import { cancelPrimePod, pollPrimePod } from './prime-intellect';

export const normalizedTrainingStatuses = [
	'queued',
	'running',
	'completed',
	'failed',
	'cancelled',
] as const;

export type NormalizedTrainingStatus = (typeof normalizedTrainingStatuses)[number];

export type TrainingStatusInput = {
	readonly runId: string | null | undefined;
	readonly providerType: string | null | undefined;
	readonly providerJobId?: string | null | undefined;
	readonly apiKey?: string | null;
	readonly apiKeyRef?: string | null;
	readonly baseUrl?: string | null;
	readonly workspaceId?: string | null;
	readonly providerConfigJson?: unknown;
	readonly checkedAt?: string;
};

export type TrainingActionResult = {
	readonly ok: boolean;
	readonly status: NormalizedTrainingStatus | 'failed';
	readonly providerJobId: string | null;
	readonly checkedAt: string;
	readonly logTail: string | null;
	readonly error: string | null;
	readonly costUsd: number | null;
	readonly metricsJson: Record<string, unknown> | null;
	readonly artifactUri: string | null;
};

type RequiredStatusInput = {
	readonly runId: string;
	readonly providerType: string;
	readonly providerJobId: string | null;
	readonly apiKey?: string | null;
	readonly apiKeyRef?: string | null;
	readonly baseUrl?: string | null;
	readonly workspaceId?: string | null;
	readonly providerConfigJson?: unknown;
	readonly checkedAt: string;
};

type ParseStatusInputResult =
	| { readonly ok: true; readonly value: RequiredStatusInput }
	| { readonly ok: false; readonly result: TrainingActionResult };

export async function cancelTrainingJob(input: TrainingStatusInput): Promise<TrainingActionResult> {
	const parsed = parseStatusInput(input);
	if (!parsed.ok) return parsed.result;
	const value = parsed.value;
	if (value.providerType === 'prime_intellect') return cancelPrimePod(value);

	return success({
		...value,
		status: 'cancelled',
		logTail: value.providerJobId
			? `Cancel requested for provider job ${value.providerJobId} on ${value.providerType}.`
			: `Cancelled queued run ${value.runId} before a provider job was recorded.`,
	});
}

export async function pollTrainingJob(input: TrainingStatusInput): Promise<TrainingActionResult> {
	const parsed = parseStatusInput(input);
	if (!parsed.ok) return parsed.result;
	const value = parsed.value;
	if (value.providerType === 'prime_intellect') return pollPrimePod(value);

	const status = statusFromProviderJobId(value.providerJobId);
	return success({
		...value,
		status,
		logTail: value.providerJobId
			? `Polled provider job ${value.providerJobId} on ${value.providerType}: ${status}.`
			: `Run ${value.runId} is still queued; no provider job id has been recorded.`,
		metricsJson: status === 'completed' ? { providerStatus: status, checkedAt: value.checkedAt } : null,
	});
}

export function statusFromProviderJobId(providerJobId: string | null): NormalizedTrainingStatus {
	if (!providerJobId) return 'queued';
	const normalized = providerJobId.toLowerCase();
	if (/(completed|succeeded|success|done)/.test(normalized)) return 'completed';
	if (/(failed|error)/.test(normalized)) return 'failed';
	if (/(cancelled|canceled)/.test(normalized)) return 'cancelled';
	return 'running';
}

function parseStatusInput(input: TrainingStatusInput): ParseStatusInputResult {
	const checkedAt = input.checkedAt ?? new Date().toISOString();
	const runId = input.runId?.trim();
	if (!runId) return { ok: false, result: failure('runId is required', checkedAt, input.providerJobId ?? null) };

	const providerType = input.providerType?.trim();
	if (!providerType) {
		return {
			ok: false,
			result: failure('providerType is required', checkedAt, input.providerJobId ?? null),
		};
	}

	return {
		ok: true,
		value: {
			runId,
			providerType,
			providerJobId: input.providerJobId?.trim() || null,
			apiKey: input.apiKey,
			apiKeyRef: input.apiKeyRef,
			baseUrl: input.baseUrl,
			workspaceId: input.workspaceId,
			providerConfigJson: input.providerConfigJson,
			checkedAt,
		},
	};
}

function success(
	input: RequiredStatusInput & {
		readonly status: NormalizedTrainingStatus;
		readonly logTail: string;
		readonly metricsJson?: Record<string, unknown> | null;
	}
): TrainingActionResult {
	return {
		ok: true,
		status: input.status,
		providerJobId: input.providerJobId,
		checkedAt: input.checkedAt,
		logTail: input.logTail,
		error: null,
		costUsd: null,
		metricsJson: input.metricsJson ?? null,
		artifactUri: null,
	};
}

function failure(error: string, checkedAt: string, providerJobId: string | null): TrainingActionResult {
	return {
		ok: false,
		status: 'failed',
		providerJobId,
		checkedAt,
		logTail: null,
		error,
		costUsd: null,
		metricsJson: null,
		artifactUri: null,
	};
}
