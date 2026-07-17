import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { env } from '$amplify/env/mcp-server';
import type { Schema } from '../../data/resource';
import {
	McpControlPlane,
	type CreateModelInput,
	type McpDataClient,
	type McpPrincipal,
	type UpdateModelInput,
} from './control-plane';
import { McpOAuthAuthenticator } from './oauth';

type FunctionUrlEvent = {
	readonly body?: string | null;
	readonly headers?: Record<string, string | undefined>;
	readonly isBase64Encoded?: boolean;
	readonly rawPath?: string;
	readonly rawQueryString?: string;
	readonly requestContext?: {
		readonly domainName?: string;
		readonly http?: { readonly method?: string };
	};
};

type FunctionUrlResult = {
	readonly statusCode: number;
	readonly headers?: Record<string, string>;
	readonly body: string;
	readonly isBase64Encoded?: boolean;
};

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const ssm = new SSMClient({});
const controlPlane = new McpControlPlane(
	generateClient<Schema>({ authMode: 'iam' }) as unknown as McpDataClient,
	{
		getSecret: async (ref) => {
			const result = await ssm.send(new GetParameterCommand({ Name: ref, WithDecryption: true }));
			const value = result.Parameter?.Value;
			if (!value) throw new Error('The Numerai account secret could not be resolved.');
			return value;
		},
		numeraiQuery: async (authToken, query) => {
			const response = await fetch('https://api-tournament.numer.ai/', {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
					Authorization: `Token ${authToken}`,
				},
				body: JSON.stringify({ query }),
			});
			if (!response.ok) throw new Error(`Numerai API request failed: HTTP ${response.status}`);
			return (await response.json()) as Record<string, unknown>;
		},
	}
);

// OAuth is optional: without MCP_OAUTH_ISSUER (the Auth0 tenant) the endpoint
// runs API-key-only and skips the discovery surface entirely.
const oauth = McpOAuthAuthenticator.fromEnvironment(process.env);

type McpToolResult = {
	readonly content: readonly { readonly type: 'text'; readonly text: string }[];
	readonly isError?: boolean;
};

type RegisterTool = <Input extends Record<string, unknown>>(
	name: string,
	config: {
		readonly description: string;
		readonly inputSchema: Record<string, z.ZodTypeAny>;
		readonly annotations?: Record<string, boolean>;
	},
	callback: (input: Input) => Promise<McpToolResult>
) => void;

export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
	const method = event.requestContext?.http?.method?.toUpperCase() ?? 'POST';
	const resource = resourceUrl(event);
	const path = (event.rawPath || '/').replace(/\/+$/, '') || '/';
	if (method === 'GET' && path === '/.well-known/oauth-protected-resource') {
		if (!oauth) return jsonResponse(404, { error: 'OAuth is not configured for this endpoint.' });
		return jsonResponse(200, oauth.protectedResourceMetadata(resource));
	}
	if (method !== 'POST') return methodNotAllowed();

	let principal = oauth ? await oauth.authenticate(header(event.headers, 'authorization'), resource) : null;
	try {
		principal ??= await controlPlane.authenticate(header(event.headers, 'x-api-key'));
	} catch (error) {
		console.error('MCP API-key lookup failed', error);
		return jsonResponse(503, { error: 'MCP authentication is temporarily unavailable.' });
	}
	if (!principal) {
		return jsonResponse(
			401,
			{ error: 'A valid OAuth bearer token or X-API-Key is required.' },
			oauth ? { 'www-authenticate': oauth.challenge(resource) } : {}
		);
	}
	if (path === '/daemon/poll' || path === '/daemon/report') {
		return daemonSync(path, principal, event);
	}
	const server = createServer(principal);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	try {
		await server.connect(transport);
		const response = await transport.handleRequest(toRequest(event));
		return fromResponse(response);
	} catch (error) {
		console.error('MCP request failed', error);
		return jsonResponse(500, {
			jsonrpc: '2.0',
			id: null,
			error: { code: -32603, message: 'Internal server error' },
		});
	} finally {
		await server.close().catch(() => undefined);
	}
};

async function daemonSync(
	path: string,
	principal: McpPrincipal,
	event: FunctionUrlEvent
): Promise<FunctionUrlResult> {
	try {
		if (path === '/daemon/poll') {
			return jsonResponse(200, await controlPlane.pollDaemonWork(principal));
		}
		let body: unknown;
		try {
			body = JSON.parse(decodedBody(event) || '{}');
		} catch {
			return jsonResponse(400, { error: 'Daemon report body must be valid JSON.' });
		}
		const report = (body ?? {}) as { runId?: unknown; action?: unknown };
		return jsonResponse(200, await controlPlane.reportDaemonAction(principal, report));
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Daemon sync failed.';
		console.error('MCP daemon sync failed', error);
		return jsonResponse(400, { error: message });
	}
}

function decodedBody(event: FunctionUrlEvent): string {
	if (!event.body) return '';
	return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

function createServer(principal: McpPrincipal): McpServer {
	const server = new McpServer({ name: 'numeraidashboard', version: '1.0.0' });
	const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;

	registerTool<{ status?: string; limit?: number }>(
		'list_training_runs',
		{
			description: 'List training runs owned by the authenticated NumeraiDashboard user.',
			inputSchema: {
				status: z.string().optional().describe('Optional queued/running/completed/failed/cancelled filter.'),
				limit: z.number().int().min(1).max(100).optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async (input) => toolResult(() => controlPlane.listTrainingRuns(principal, input))
	);

	registerTool<{ stage?: string; limit?: number }>(
		'list_models',
		{
			description:
				'List owned model drafts and their complete Builder runConfig. Use this to select any model type before launching it.',
			inputSchema: {
				stage: z.string().optional().describe('Optional draft/training/success/failed/testing/live/retired filter.'),
				limit: z.number().int().min(1).max(100).optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async (input) => toolResult(() => controlPlane.listModels(principal, input))
	);

	registerTool<{
		name?: string;
		model_type: string;
		run_config?: Record<string, unknown>;
		change_summary?: string;
		parent_model_id?: string;
		template?: string;
		sweep?: { parameter: string; values: (string | number | boolean)[]; max_runs?: number };
	}>(
		'create_model',
		{
			description:
				'Create one owned Builder model draft, or multiple drafts when sweep is supplied. The complete run_config is preserved for launch_model_training; model-specific fields are supported for every model type.',
			inputSchema: {
				name: z.string().min(1).optional(),
				model_type: z.string().min(1).describe('Model type such as lgbm, xgboost, catboost, mlp, ft_transformer, modern_nca, tabm, tabpfn, or tabicl.'),
				run_config: z.record(z.unknown()).optional().describe('Complete Builder runConfig. Defaults for mode, tournament, feature_set, neutralization_pct, and upload are added when omitted.'),
				change_summary: z.string().optional(),
				parent_model_id: z.string().min(1).optional(),
				template: z.enum(['baseline', 'challenger', 'ensemble', 'custom']).optional(),
				sweep: z.object({
					parameter: z.string().min(1),
					values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1).max(64),
					max_runs: z.number().int().min(1).max(64).optional(),
				}).optional(),
			},
			annotations: { destructiveHint: false, idempotentHint: false },
		},
		async ({ name, model_type, run_config, change_summary, parent_model_id, template, sweep }) =>
			toolResult(() => controlPlane.createModel(principal, {
				name,
				modelType: model_type,
				runConfig: run_config,
				changeSummary: change_summary,
				parentModelId: parent_model_id,
				template,
				sweep: sweep ? { parameter: sweep.parameter, values: sweep.values, maxRuns: sweep.max_runs } : undefined,
			} satisfies CreateModelInput))
	);

	registerTool<{
		model_id: string;
		name?: string;
		stage?: string;
		change_summary?: string | null;
		parent_model_id?: string | null;
		numerai_model_id?: string | null;
		run_config?: Record<string, unknown>;
	}>(
		'update_model',
		{
			description: 'Update an owned model record, including its Builder runConfig or lifecycle metadata.',
			inputSchema: {
				model_id: z.string().min(1),
				name: z.string().min(1).optional(),
				stage: z.enum(['draft', 'training', 'success', 'failed', 'testing', 'live', 'retired']).optional(),
				change_summary: z.string().nullable().optional(),
				parent_model_id: z.string().min(1).nullable().optional(),
				numerai_model_id: z.string().nullable().optional(),
				run_config: z.record(z.unknown()).optional(),
			},
			annotations: { destructiveHint: false, idempotentHint: true },
		},
		async ({ model_id, name, stage, change_summary, parent_model_id, numerai_model_id, run_config }) =>
			toolResult(() => controlPlane.updateModelDraft(principal, {
				modelId: model_id,
				name,
				stage,
				changeSummary: change_summary,
				parentModelId: parent_model_id,
				numeraiModelId: numerai_model_id,
				runConfig: run_config,
			} satisfies UpdateModelInput))
	);

	registerTool<{ model_id: string }>(
		'delete_model',
		{
			description: 'Permanently delete an owned model registry item. Related training records are retained.',
			inputSchema: { model_id: z.string().min(1) },
			annotations: { destructiveHint: true, idempotentHint: false },
		},
		async ({ model_id }) => toolResult(() => controlPlane.deleteModel(principal, { modelId: model_id }))
	);

	registerTool<{ provider_type?: string; status?: string; limit?: number }>(
		'list_compute_providers',
		{
			description:
				'List safe metadata for compute providers owned by the authenticated user. Use this before selecting a provider_id for a launch.',
			inputSchema: {
				provider_type: z
					.string()
					.optional()
					.describe('Optional prime_intellect/modal/sagemaker/local/custom filter.'),
				status: z.string().optional().describe('Optional available/planned/disabled filter.'),
				limit: z.number().int().min(1).max(100).optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ provider_type, status, limit }) =>
			toolResult(() =>
				controlPlane.listComputeProviders(principal, { providerType: provider_type, status, limit })
			)
	);

	registerTool<{ run_id: string; provider_id?: string; compute_type?: string }>(
		'launch_training_run',
		{
			description:
				'Launch a queued training run through its configured compute provider, or through an explicit provider_id from list_compute_providers. Modal launches may set compute_type to cpu or a supported GPU type.',
			inputSchema: {
				run_id: z.string().min(1),
				provider_id: z.string().min(1).optional(),
				compute_type: z
					.string()
					.min(1)
					.optional()
					.describe('Optional Modal compute type such as cpu, t4, a10g, l4, a100, or h100.'),
			},
			annotations: { destructiveHint: false, idempotentHint: false },
		},
		async ({ run_id, provider_id, compute_type }) =>
			toolResult(() =>
				controlPlane.launchTrainingRun(principal, {
					runId: run_id,
					providerId: provider_id,
					computeType: compute_type,
				})
			)
	);

	registerTool<{
		model_id: string;
		provider_id: string;
		compute_type?: string;
		max_spend_usd?: number;
	}>(
		'launch_model_training',
		{
			description:
				'Create and launch a new training run from an owned Builder model, preserving its full runConfig for every model type. Select provider_id with list_compute_providers. Local providers are queued for their normal worker; compute_type applies only to Modal.',
			inputSchema: {
				model_id: z.string().min(1),
				provider_id: z.string().min(1),
				compute_type: z.string().min(1).optional(),
				max_spend_usd: z.number().nonnegative().optional(),
			},
			annotations: { destructiveHint: false, idempotentHint: false },
		},
		async ({ model_id, provider_id, compute_type, max_spend_usd }) =>
			toolResult(() =>
				controlPlane.launchModelTraining(principal, {
					modelId: model_id,
					providerId: provider_id,
					computeType: compute_type,
					maxSpendUsd: max_spend_usd,
				})
			)
	);

	registerTool<{ run_id: string }>(
		'poll_training_status',
		{
			description: 'Poll a training run and persist the latest run/job status and logs.',
			inputSchema: { run_id: z.string().min(1) },
			annotations: { destructiveHint: false, idempotentHint: true },
		},
		async ({ run_id }) => toolResult(() => controlPlane.pollTrainingStatus(principal, { runId: run_id }))
	);

	registerTool<{ run_id: string }>(
		'cancel_run',
		{
			description: 'Cancel a queued or active training run and persist the terminal state.',
			inputSchema: { run_id: z.string().min(1) },
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async ({ run_id }) => toolResult(() => controlPlane.cancelRun(principal, { runId: run_id }))
	);

	registerTool<{ model_id?: string; status?: string; limit?: number }>(
		'list_submissions',
		{
			description: 'List Numerai model submissions owned by the authenticated user.',
			inputSchema: {
				model_id: z.string().min(1).optional(),
				status: z.string().optional(),
				limit: z.number().int().min(1).max(100).optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ model_id, status, limit }) =>
			toolResult(() => controlPlane.listSubmissions(principal, { modelId: model_id, status, limit }))
	);

	registerTool<Record<string, never>>(
		'get_numerai_account',
		{
			description:
				'Show the linked Numerai account: verification status, username, and the Numerai models it owns. Use the returned model ids with update_model.numerai_model_id to link registry models. Secrets are never returned.',
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () => toolResult(() => controlPlane.getNumeraiAccount(principal))
	);

	return server;
}

async function toolResult<T>(operation: () => Promise<T>): Promise<McpToolResult> {
	try {
		const result = await operation();
		return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
	} catch (error) {
		return {
			isError: true,
			content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
		};
	}
}

function resourceUrl(event: FunctionUrlEvent): string {
	const domain = event.requestContext?.domainName ?? 'mcp.numeraidashboard.invalid';
	return `https://${domain}/`;
}

function toRequest(event: FunctionUrlEvent): Request {
	const domain = event.requestContext?.domainName ?? 'mcp.numeraidashboard.invalid';
	const path = event.rawPath || '/';
	const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
	const headers = new Headers();
	for (const [name, value] of Object.entries(event.headers ?? {})) {
		if (value !== undefined) headers.set(name, value);
	}
	const body = event.body
		? event.isBase64Encoded
			? Buffer.from(event.body, 'base64')
			: event.body
		: undefined;
	return new Request(`https://${domain}${path}${query}`, { method: 'POST', headers, body });
}

async function fromResponse(response: Response): Promise<FunctionUrlResult> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return {
		statusCode: response.status,
		headers,
		body: await response.text(),
	};
}

function header(headers: Record<string, string | undefined> | undefined, name: string): string | null {
	const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
	return match?.[1]?.trim() || null;
}

function methodNotAllowed(): FunctionUrlResult {
	return jsonResponse(405, {
		jsonrpc: '2.0',
		id: null,
		error: { code: -32000, message: 'Method not allowed. Use POST.' },
	});
}

function jsonResponse(
	statusCode: number,
	body: unknown,
	headers: Record<string, string> = {}
): FunctionUrlResult {
	return {
		statusCode,
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	};
}
