import { createHash } from 'node:crypto';
import type { Schema } from '../../data/resource';

type ApiKey = Schema['ApiKey']['type'];
type ComputeJob = Schema['ComputeJob']['type'];
type ComputeProvider = Schema['ComputeProvider']['type'];
type ModelSubmission = Schema['ModelSubmission']['type'];
type TrainingActionResult = NonNullable<Schema['TrainingActionResult']['type']>;
type TrainingRun = Schema['TrainingRun']['type'];

type DataError = { readonly message?: string | null };
type DataResult<T> = Promise<{
	readonly data?: T | null;
	readonly errors?: readonly DataError[];
}>;

export type McpDataClient = {
	readonly models: {
		readonly ApiKey: {
			apiKeyByHash(args: unknown): DataResult<ApiKey[]>;
			update(args: unknown): DataResult<ApiKey>;
		};
		readonly TrainingRun: {
			list(args: unknown): DataResult<TrainingRun[]>;
			get(args: unknown): DataResult<TrainingRun>;
			update(args: unknown): DataResult<TrainingRun>;
		};
		readonly ComputeProvider: {
			get(args: unknown): DataResult<ComputeProvider>;
		};
		readonly ComputeJob: {
			list(args: unknown): DataResult<ComputeJob[]>;
			create(args: unknown): DataResult<ComputeJob>;
			update(args: unknown): DataResult<ComputeJob>;
		};
		readonly ModelSubmission: {
			list(args: unknown): DataResult<ModelSubmission[]>;
		};
	};
	readonly mutations: {
		startTraining(args: unknown): DataResult<TrainingActionResult>;
		pollTrainingStatus(args: unknown): DataResult<TrainingActionResult>;
		cancelTraining(args: unknown): DataResult<TrainingActionResult>;
	};
};

export type McpPrincipal = {
	readonly ownerSub: string;
};

export class McpControlPlane {
	constructor(private readonly client: McpDataClient) {}

	async authenticate(rawKey: string | null | undefined): Promise<McpPrincipal | null> {
		if (!isMcpApiKey(rawKey)) return null;
		const { data, errors } = await this.client.models.ApiKey.apiKeyByHash({
			keyHash: hashMcpApiKey(rawKey),
		});
		throwDataErrors(errors, 'ApiKey lookup failed');
		const matches = (data ?? []).filter((record) => !record.revokedAt);
		if (matches.length !== 1) return null;

		const key = matches[0] as ApiKey;
		const ownerSub = ownerSubFromRecord(key);
		if (!ownerSub) return null;
		await this.client.models.ApiKey.update({ id: key.id, lastUsedAt: new Date().toISOString() });
		return { ownerSub };
	}

	async listTrainingRuns(
		principal: McpPrincipal,
		input: { readonly status?: string; readonly limit?: number } = {}
	) {
		const limit = boundedLimit(input.limit);
		const filter = ownedFilter(
			principal,
			input.status?.trim() ? { status: { eq: input.status.trim() } } : undefined
		);
		const { data, errors } = await this.client.models.TrainingRun.list({ filter, limit });
		throwDataErrors(errors, 'TrainingRun list failed');
		return (data ?? [])
			.filter((record) => ownedBy(record, principal))
			.map(publicTrainingRun);
	}

	async launchTrainingRun(
		principal: McpPrincipal,
		input: { readonly runId: string; readonly providerId?: string }
	) {
		const run = await this.ownedRun(principal, input.runId);
		if (run.status === 'running' || run.status === 'completed') {
			throw new Error(`Training run ${run.id} is already ${run.status}.`);
		}
		const provider = await this.ownedProvider(principal, input.providerId ?? run.providerId);
		if (provider.status === 'disabled') throw new Error(`Compute provider ${provider.id} is disabled.`);

		const action = await this.invokeTrainingMutation('start', principal, run, provider, null);
		return this.persistAction(principal, run, provider, action);
	}

	async pollTrainingStatus(principal: McpPrincipal, input: { readonly runId: string }) {
		const run = await this.ownedRun(principal, input.runId);
		const job = await this.jobForRun(principal, run.id);
		const provider = await this.ownedProvider(principal, job?.providerId ?? run.providerId);
		const action = await this.invokeTrainingMutation(
			'poll',
			principal,
			run,
			provider,
			job?.providerJobId ?? null
		);
		return this.persistAction(principal, run, provider, action, job);
	}

	async cancelRun(principal: McpPrincipal, input: { readonly runId: string }) {
		const run = await this.ownedRun(principal, input.runId);
		if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
			throw new Error(`Training run ${run.id} is already ${run.status}.`);
		}
		const job = await this.jobForRun(principal, run.id);
		const provider = await this.ownedProvider(principal, job?.providerId ?? run.providerId);
		const action = await this.invokeTrainingMutation(
			'cancel',
			principal,
			run,
			provider,
			job?.providerJobId ?? null
		);
		return this.persistAction(principal, run, provider, action, job);
	}

	async listSubmissions(
		principal: McpPrincipal,
		input: { readonly modelId?: string; readonly status?: string; readonly limit?: number } = {}
	) {
		const conditions: Record<string, unknown>[] = [];
		if (input.modelId?.trim()) conditions.push({ modelId: { eq: input.modelId.trim() } });
		if (input.status?.trim()) conditions.push({ status: { eq: input.status.trim() } });
		const filter = ownedFilter(principal, ...conditions);
		const { data, errors } = await this.client.models.ModelSubmission.list({
			filter,
			limit: boundedLimit(input.limit),
		});
		throwDataErrors(errors, 'ModelSubmission list failed');
		return (data ?? [])
			.filter((record) => ownedBy(record, principal))
			.map(publicSubmission);
	}

	private async ownedRun(principal: McpPrincipal, id: string): Promise<TrainingRun> {
		const runId = requiredId(id, 'run_id');
		const { data, errors } = await this.client.models.TrainingRun.get({ id: runId });
		throwDataErrors(errors, 'TrainingRun lookup failed');
		if (!data || !ownedBy(data, principal)) throw new Error(`Training run ${runId} was not found.`);
		return data as TrainingRun;
	}

	private async ownedProvider(
		principal: McpPrincipal,
		id: string | null | undefined
	): Promise<ComputeProvider> {
		const providerId = requiredId(id, 'provider_id');
		const { data, errors } = await this.client.models.ComputeProvider.get({ id: providerId });
		throwDataErrors(errors, 'ComputeProvider lookup failed');
		if (!data || !ownedBy(data, principal)) throw new Error(`Compute provider ${providerId} was not found.`);
		return data as ComputeProvider;
	}

	private async jobForRun(principal: McpPrincipal, runId: string): Promise<ComputeJob | null> {
		const { data, errors } = await this.client.models.ComputeJob.list({
			filter: ownedFilter(principal, { runId: { eq: runId } }),
			limit: 20,
		});
		throwDataErrors(errors, 'ComputeJob lookup failed');
		return (
			(data ?? [])
				.filter((record) => ownedBy(record, principal))
				.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))[0] ?? null
		) as ComputeJob | null;
	}

	private async invokeTrainingMutation(
		operation: 'start' | 'poll' | 'cancel',
		principal: McpPrincipal,
		run: TrainingRun,
		provider: ComputeProvider,
		providerJobId: string | null
	): Promise<TrainingActionResult> {
		const baseArgs = {
			runId: run.id,
			providerId: provider.id,
			providerType: provider.providerType ?? 'custom',
			apiKeyRef: provider.apiKeyRef ?? null,
			apiSecretRef: provider.apiSecretRef ?? null,
			baseUrl: provider.baseUrl ?? null,
			workspaceId: provider.workspaceId ?? null,
			providerConfigJson: serializeAwsJson(provider.credentialsJson),
			ownerSub: principal.ownerSub,
		};
		const result =
			operation === 'start'
				? await this.client.mutations.startTraining(baseArgs)
				: operation === 'poll'
					? await this.client.mutations.pollTrainingStatus({ ...baseArgs, providerJobId })
					: await this.client.mutations.cancelTraining({ ...baseArgs, providerJobId });
		throwDataErrors(result.errors, `${operation} training mutation failed`);
		if (!result.data) throw new Error(`${operation} training mutation returned no data.`);
		return result.data as TrainingActionResult;
	}

	private async persistAction(
		principal: McpPrincipal,
		run: TrainingRun,
		provider: ComputeProvider,
		action: TrainingActionResult,
		existingJob?: ComputeJob | null
	) {
		const runPatch = trainingRunPatch(run, action);
		const { data: updatedRun, errors: runErrors } = await this.client.models.TrainingRun.update(runPatch);
		throwDataErrors(runErrors, 'TrainingRun update failed');
		if (!updatedRun || !ownedBy(updatedRun, principal)) throw new Error('TrainingRun update returned no data.');

		const job = existingJob ?? (await this.jobForRun(principal, run.id));
		const jobPatch = computeJobPatch(action);
		const jobResult = job
			? await this.client.models.ComputeJob.update({ id: job.id, ...jobPatch })
			: await this.client.models.ComputeJob.create({
					owner: principal.ownerSub,
					providerId: provider.id,
					runId: run.id,
					name: `MCP training ${run.id}`,
					...jobPatch,
				});
		throwDataErrors(jobResult.errors, 'ComputeJob write failed');
		if (!jobResult.data || !ownedBy(jobResult.data, principal)) throw new Error('ComputeJob write returned no data.');

		return {
			action: publicAction(action),
			run: publicTrainingRun(updatedRun as TrainingRun),
			job: publicComputeJob(jobResult.data as ComputeJob),
		};
	}
}

export function hashMcpApiKey(rawKey: string): string {
	return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

export function ownerSub(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const sub = value.split('::', 1)[0]?.trim();
	return sub || null;
}

function ownerSubFromRecord(record: unknown): string | null {
	return ownerSub(asRecord(record)?.owner);
}

function ownedBy(record: unknown, principal: McpPrincipal): boolean {
	return ownerSubFromRecord(record) === principal.ownerSub;
}

function ownedFilter(
	principal: McpPrincipal,
	...conditions: (Record<string, unknown> | undefined)[]
): Record<string, unknown> {
	const owner = {
		or: [
			{ owner: { eq: principal.ownerSub } },
			{ owner: { beginsWith: `${principal.ownerSub}::` } },
		],
	};
	const active = conditions.filter((condition): condition is Record<string, unknown> => Boolean(condition));
	return active.length ? { and: [owner, ...active] } : owner;
}

function isMcpApiKey(value: string | null | undefined): value is string {
	return typeof value === 'string' && /^nd_mcp_[A-Za-z0-9_-]{32,}$/.test(value);
}

function boundedLimit(value: number | undefined): number {
	if (!Number.isFinite(value)) return 20;
	return Math.max(1, Math.min(100, Math.trunc(value ?? 20)));
}

function requiredId(value: string | null | undefined, name: string): string {
	const id = value?.trim();
	if (!id) throw new Error(`${name} is required.`);
	return id;
}

function normalizeStatus(status: string): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
	switch (status) {
		case 'running':
		case 'started':
			return 'running';
		case 'completed':
		case 'complete':
		case 'succeeded':
		case 'success':
			return 'completed';
		case 'failed':
		case 'error':
			return 'failed';
		case 'cancelled':
		case 'canceled':
			return 'cancelled';
		default:
			return 'queued';
	}
}

function trainingRunPatch(run: TrainingRun, action: TrainingActionResult) {
	const status = normalizeStatus(action.status);
	const terminal = ['completed', 'failed', 'cancelled'].includes(status);
	return {
		id: run.id,
		status,
		...(status === 'running' ? { startedAt: run.startedAt ?? action.checkedAt } : {}),
		...(terminal ? { finishedAt: action.checkedAt } : {}),
		logTail: action.logTail ?? action.error ?? null,
		costUsd: action.costUsd ?? null,
		metricsJson: action.metricsJson ?? null,
		artifactUri: action.artifactUri ?? null,
	};
}

function computeJobPatch(action: TrainingActionResult) {
	const status = normalizeStatus(action.status);
	const terminal = ['completed', 'failed', 'cancelled'].includes(status);
	return {
		status,
		providerJobId: action.providerJobId ?? null,
		...(status === 'running' ? { startedAt: action.checkedAt } : {}),
		...(terminal ? { finishedAt: action.checkedAt } : {}),
		logTail: action.logTail ?? action.error ?? null,
		actualCostUsd: action.costUsd ?? null,
	};
}

function publicTrainingRun(run: TrainingRun) {
	return {
		id: run.id,
		pipelineId: run.pipelineId,
		branchId: run.branchId ?? null,
		providerId: run.providerId ?? null,
		modelTemplate: run.modelTemplate ?? null,
		status: run.status ?? null,
		metricsJson: run.metricsJson ?? null,
		costUsd: run.costUsd ?? null,
		startedAt: run.startedAt ?? null,
		finishedAt: run.finishedAt ?? null,
		logTail: run.logTail ?? null,
		artifactUri: run.artifactUri ?? null,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
	};
}

function publicComputeJob(job: ComputeJob) {
	return {
		id: job.id,
		runId: job.runId ?? null,
		providerId: job.providerId ?? null,
		providerJobId: job.providerJobId ?? null,
		name: job.name,
		status: job.status ?? null,
		actualCostUsd: job.actualCostUsd ?? null,
		startedAt: job.startedAt ?? null,
		finishedAt: job.finishedAt ?? null,
		logTail: job.logTail ?? null,
		updatedAt: job.updatedAt,
	};
}

function publicSubmission(submission: ModelSubmission) {
	return {
		id: submission.id,
		modelId: submission.modelId,
		providerId: submission.providerId ?? null,
		roundNumber: submission.roundNumber ?? null,
		status: submission.status ?? null,
		externalSubmissionId: submission.externalSubmissionId ?? null,
		artifactUri: submission.artifactUri ?? null,
		notes: submission.notes ?? null,
		submittedAt: submission.submittedAt ?? null,
		createdAt: submission.createdAt,
		updatedAt: submission.updatedAt,
	};
}

function publicAction(action: TrainingActionResult) {
	return {
		ok: action.ok,
		status: action.status,
		providerJobId: action.providerJobId ?? null,
		checkedAt: action.checkedAt,
		logTail: action.logTail ?? null,
		error: action.error ?? null,
		costUsd: action.costUsd ?? null,
		metricsJson: action.metricsJson ?? null,
		artifactUri: action.artifactUri ?? null,
	};
}

function serializeAwsJson(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return typeof value === 'string' ? value : JSON.stringify(value);
}

function timestamp(value: string | null | undefined): number {
	const parsed = value ? Date.parse(value) : 0;
	return Number.isFinite(parsed) ? parsed : 0;
}

function throwDataErrors(errors: readonly { readonly message?: string | null }[] | undefined, fallback: string): void {
	if (!errors?.length) return;
	throw new Error(errors.map((error) => error.message).filter(Boolean).join('; ') || fallback);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
