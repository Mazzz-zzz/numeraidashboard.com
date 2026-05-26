import { dataClient } from '$lib/data';
import { requireAuthSession } from '$lib/auth';
import type { Schema } from '../../../amplify/data/resource';
import type { ComputeJobStatus, ComputeProvider } from './compute-service';
import type { TrainingRun } from './pipeline-service';

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
		providerConfigJson: providerConfigJson ?? provider.credentialsJson ?? null,
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
	const { data } = await client.models.TrainingRun.update(patch);
	if (!data) throw new Error('TrainingRun.update returned no data');
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
