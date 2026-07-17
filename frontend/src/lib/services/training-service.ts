import { dataClient } from '$lib/data';
import { requireAuthSession } from '$lib/auth';
import type { Schema } from '../../../amplify/data/resource';
import type { ComputeJob, ComputeJobStatus, ComputeProvider } from './compute-service';
import type { TrainingRun } from './pipeline-service';
import { cancelLocalTraining } from './local-training-service';

/** Local runs execute on the user's machine via the local daemon, not AWS. */
function isLocalProvider(provider: ComputeProvider): boolean {
	return providerTypeArgument(provider) === 'local';
}

type Client = ReturnType<typeof dataClient>;

export type TrainingActionResult = NonNullable<Schema['TrainingActionResult']['type']>;
export type TrainingRunStatus = NonNullable<TrainingRun['status']>;
export type NormalizedTrainingStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type TrainingActionInput = {
	readonly runId: string;
	readonly provider: ComputeProvider;
	readonly providerJobId?: string | null;
	readonly providerConfigJson?: unknown;
};

export type LocalTrainingSnapshot = {
	readonly action: TrainingActionResult;
	readonly run: TrainingRun;
	readonly job: ComputeJob | null;
};

export function serializeAwsJsonArg(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') return value;
	const encoded = JSON.stringify(value);
	if (encoded === undefined) return null;
	return encoded;
}

export type TrainingRunActionPatch = {
	readonly id: string;
	readonly status: TrainingRunStatus;
	readonly startedAt?: string | null;
	readonly finishedAt?: string | null;
	readonly logTail?: string | null;
	readonly costUsd?: number | null;
	readonly metricsJson?: TrainingRun['metricsJson'];
	readonly artifactUri?: string | null;
};

export function providerTypeArgument(provider: ComputeProvider): string {
	return provider.providerType ?? 'custom';
}

function providerRuntimeArgs(provider: ComputeProvider, providerConfigJson?: unknown) {
	return {
		apiKeyRef: provider.apiKeyRef ?? null,
		apiSecretRef: provider.apiSecretRef ?? null,
		baseUrl: provider.baseUrl ?? null,
		workspaceId: provider.workspaceId ?? null,
		providerConfigJson: serializeAwsJsonArg(providerConfigJson ?? provider.credentialsJson ?? null),
	};
}

export function trainingActionSummary(result: Pick<TrainingActionResult, 'ok' | 'status' | 'error'>): string {
	if (!result.ok) return result.error ?? 'Training action failed';
	return `Training ${result.status}`;
}

export function normalizeTrainingActionStatus(status: string): NormalizedTrainingStatus {
	switch (status) {
		case 'planned':
		case 'pending':
		case 'queued':
			return 'queued';
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

export function toComputeJobStatus(status: string): ComputeJobStatus {
	return normalizeTrainingActionStatus(status);
}

export function toTrainingRunStatus(status: string): TrainingRunStatus {
	return normalizeTrainingActionStatus(status);
}

export function trainingRunPatchFromAction(input: {
	readonly runId: string;
	readonly action: TrainingActionResult;
	readonly currentStartedAt?: string | null;
}): TrainingRunActionPatch {
	const status = toTrainingRunStatus(input.action.status);
	const finishedAt =
		status === 'completed' || status === 'failed' || status === 'cancelled'
			? input.action.checkedAt
			: undefined;
	const startedAt = status === 'running' ? (input.currentStartedAt ?? input.action.checkedAt) : undefined;

	return {
		id: input.runId,
		status,
		...(startedAt !== undefined ? { startedAt } : {}),
		...(finishedAt !== undefined ? { finishedAt } : {}),
		...(input.action.logTail !== undefined || input.action.error ? { logTail: input.action.logTail ?? input.action.error ?? null } : {}),
		...(input.action.costUsd !== undefined ? { costUsd: input.action.costUsd ?? null } : {}),
		...(input.action.metricsJson !== undefined ? { metricsJson: input.action.metricsJson ?? null } : {}),
		...(input.action.artifactUri !== undefined ? { artifactUri: input.action.artifactUri ?? null } : {}),
	};
}

export async function updateTrainingRunFromAction(
	input: {
		readonly runId: string;
		readonly action: TrainingActionResult;
		readonly currentStartedAt?: string | null;
	},
	client: Client = dataClient()
): Promise<TrainingRun> {
	await requireAuthSession();
	const patch = trainingRunPatchFromAction(input);
	const { data, errors } = await client.models.TrainingRun.update(patch);
	if (errors?.length) {
		throw new Error(
			errors.map((error) => error.message).filter(Boolean).join('; ') ||
				`TrainingRun.update failed for run ${input.runId}`
		);
	}
	if (!data) {
		// A null result with no errors almost always means the row doesn't exist
		// for this runId (e.g. the run was launched outside the dashboard flow).
		throw new Error(`TrainingRun.update returned no data — no run found for id ${input.runId}`);
	}
	return data as TrainingRun;
}

export function terminalActionTimestamp(status: string, checkedAt: string): string | undefined {
	switch (normalizeTrainingActionStatus(status)) {
		case 'completed':
		case 'failed':
		case 'cancelled':
			return checkedAt;
		default:
			return undefined;
	}
}

export async function startTrainingRun(
	input: TrainingActionInput,
	client: Client = dataClient()
): Promise<TrainingActionResult> {
	await requireAuthSession();
	if (isLocalProvider(input.provider)) {
		return localControlAction({
			status: 'queued',
			providerJobId: null,
			logTail: 'Run queued for the local training daemon.'
		});
	}
	const { data, errors } = await client.mutations.startTraining({
		runId: input.runId,
		providerId: input.provider.id,
		providerType: providerTypeArgument(input.provider),
		...providerRuntimeArgs(input.provider, input.providerConfigJson)
	});
	if (errors?.length) throw new Error(errors[0].message);
	if (!data) throw new Error('startTraining returned no data');
	return data as TrainingActionResult;
}

export async function cancelTrainingRun(
	input: TrainingActionInput,
	client: Client = dataClient()
): Promise<TrainingActionResult> {
	await requireAuthSession();
	if (isLocalProvider(input.provider)) {
		return cancelLocalTraining({
			runId: input.runId,
			provider: input.provider,
			providerJobId: input.providerJobId ?? null
		});
	}
	const { data, errors } = await client.mutations.cancelTraining({
		runId: input.runId,
		providerId: input.provider.id,
		providerType: providerTypeArgument(input.provider),
		providerJobId: input.providerJobId ?? null,
		...providerRuntimeArgs(input.provider, input.providerConfigJson)
	});
	if (errors?.length) throw new Error(errors[0].message);
	if (!data) throw new Error('cancelTraining returned no data');
	return data as TrainingActionResult;
}

export async function pollTrainingRunStatus(
	input: TrainingActionInput,
	client: Client = dataClient()
): Promise<TrainingActionResult> {
	await requireAuthSession();
	if (isLocalProvider(input.provider)) {
		return (await readLocalTrainingSnapshot(input, client)).action;
	}
	const { data, errors } = await client.mutations.pollTrainingStatus({
		runId: input.runId,
		providerId: input.provider.id,
		providerType: providerTypeArgument(input.provider),
		providerJobId: input.providerJobId ?? null,
		...providerRuntimeArgs(input.provider, input.providerConfigJson)
	});
	if (errors?.length) throw new Error(errors[0].message);
	if (!data) throw new Error('pollTrainingStatus returned no data');
	return data as TrainingActionResult;
}

/**
 * Read local training state from the cloud mirror maintained by the Mac daemon.
 *
 * A deployed browser cannot reach the workstation through the relative
 * `/local-daemon` development proxy. More importantly, polling that route from
 * the hosted SPA returns HTML and used to overwrite valid daemon-pushed state
 * with a synthetic failure. The daemon is the sole writer for local execution
 * progress; browser and MCP clients only read its cloud mirror.
 */
export async function readLocalTrainingSnapshot(
	input: Pick<TrainingActionInput, 'runId' | 'providerJobId'>,
	client: Client = dataClient()
): Promise<LocalTrainingSnapshot> {
	await requireAuthSession();
	const [runResult, jobsResult] = await Promise.all([
		client.models.TrainingRun.get({ id: input.runId }),
		client.models.ComputeJob.list({ filter: { runId: { eq: input.runId } }, limit: 20 })
	]);
	throwDataErrors(runResult.errors, `TrainingRun.get failed for run ${input.runId}`);
	throwDataErrors(jobsResult.errors, `ComputeJob.list failed for run ${input.runId}`);
	if (!runResult.data) throw new Error(`TrainingRun.get returned no data for run ${input.runId}`);

	const run = runResult.data as TrainingRun;
	const job = ((jobsResult.data ?? []) as ComputeJob[])
		.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))[0] ?? null;
	const status = normalizeTrainingActionStatus(run.status ?? job?.status ?? 'queued');
	const logTail = run.logTail ?? job?.logTail ?? null;
	const action = localControlAction({
		status,
		providerJobId: job?.providerJobId ?? input.providerJobId ?? null,
		checkedAt: run.updatedAt ?? job?.updatedAt ?? new Date().toISOString(),
		logTail,
		error: status === 'failed' ? logTail : null,
		costUsd: run.costUsd ?? job?.actualCostUsd ?? null,
		metricsJson: run.metricsJson ?? null,
		artifactUri: run.artifactUri ?? null
	});
	return { action, run, job };
}

function localControlAction(input: {
	readonly status: NormalizedTrainingStatus;
	readonly providerJobId: string | null;
	readonly checkedAt?: string;
	readonly logTail?: string | null;
	readonly error?: string | null;
	readonly costUsd?: number | null;
	readonly metricsJson?: TrainingActionResult['metricsJson'];
	readonly artifactUri?: string | null;
}): TrainingActionResult {
	return {
		ok: input.status !== 'failed',
		status: input.status,
		providerJobId: input.providerJobId,
		checkedAt: input.checkedAt ?? new Date().toISOString(),
		logTail: input.logTail ?? null,
		error: input.error ?? null,
		costUsd: input.costUsd ?? null,
		metricsJson: input.metricsJson ?? null,
		artifactUri: input.artifactUri ?? null
	} as TrainingActionResult;
}

function throwDataErrors(errors: readonly { readonly message?: string | null }[] | undefined, fallback: string) {
	if (!errors?.length) return;
	throw new Error(errors.map((error) => error.message).filter(Boolean).join('; ') || fallback);
}

function timestamp(value: string | null | undefined): number {
	return value ? Date.parse(value) || 0 : 0;
}
