import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { env } from '$amplify/env/mcp-server';
import type { Schema } from '../../data/resource';
import { McpControlPlane, type McpDataClient, type McpPrincipal } from './control-plane';
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
const controlPlane = new McpControlPlane(
	generateClient<Schema>({ authMode: 'iam' }) as unknown as McpDataClient
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

	registerTool<{ run_id: string; provider_id?: string }>(
		'launch_training_run',
		{
			description: 'Launch a queued training run through its configured compute provider.',
			inputSchema: {
				run_id: z.string().min(1),
				provider_id: z.string().min(1).optional(),
			},
			annotations: { destructiveHint: false, idempotentHint: false },
		},
		async ({ run_id, provider_id }) =>
			toolResult(() => controlPlane.launchTrainingRun(principal, { runId: run_id, providerId: provider_id }))
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
