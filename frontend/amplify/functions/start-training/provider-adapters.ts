import { createHash } from 'node:crypto';
import { launchPrimePod } from '../prime-intellect';

export const trainingProviderTypes = [
	'prime_intellect',
	'modal',
	'sagemaker',
	'local',
	'custom',
] as const;

export type TrainingProviderType = (typeof trainingProviderTypes)[number];

export type TrainingLaunchInput = {
	readonly runId: string | null | undefined;
	readonly providerId: string | null | undefined;
	readonly providerType: string | null | undefined;
	readonly apiKey?: string | null;
	readonly apiKeyRef?: string | null;
	readonly baseUrl?: string | null;
	readonly workspaceId?: string | null;
	readonly providerConfigJson?: unknown;
	readonly checkedAt?: string;
};

export type TrainingActionResult = {
	readonly ok: boolean;
	readonly status: string;
	readonly providerJobId: string | null;
	readonly checkedAt: string;
	readonly logTail: string | null;
	readonly error: string | null;
	readonly costUsd: number | null;
	readonly metricsJson: Record<string, unknown> | null;
	readonly artifactUri: string | null;
};

type ProviderAdapter = {
	readonly type: TrainingProviderType;
	readonly label: string;
	launch(input: RequiredLaunchInput): TrainingActionResult | Promise<TrainingActionResult>;
};

type RequiredLaunchInput = {
	readonly runId: string;
	readonly providerId: string;
	readonly providerType: TrainingProviderType;
	readonly apiKey?: string | null;
	readonly apiKeyRef?: string | null;
	readonly baseUrl?: string | null;
	readonly workspaceId?: string | null;
	readonly providerConfigJson?: unknown;
	readonly checkedAt: string;
};

export function normalizeTrainingProviderType(value: string | null | undefined): TrainingProviderType | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	return trainingProviderTypes.includes(normalized as TrainingProviderType)
		? (normalized as TrainingProviderType)
		: null;
}

export async function launchTrainingJob(input: TrainingLaunchInput): Promise<TrainingActionResult> {
	const checkedAt = input.checkedAt ?? new Date().toISOString();
	const runId = input.runId?.trim();
	if (!runId) return failure('runId is required', checkedAt);

	const providerId = input.providerId?.trim();
	if (!providerId) return failure('providerId is required', checkedAt);

	const providerType = normalizeTrainingProviderType(input.providerType);
	if (!providerType) {
		return failure(
			`Unsupported training provider type "${input.providerType ?? ''}". Supported providers: ${trainingProviderTypes.join(', ')}`,
			checkedAt
		);
	}

	return adapters[providerType].launch({
		runId,
		providerId,
		providerType,
		apiKey: input.apiKey,
		apiKeyRef: input.apiKeyRef,
		baseUrl: input.baseUrl,
		workspaceId: input.workspaceId,
		providerConfigJson: input.providerConfigJson,
		checkedAt,
	});
}

const adapters: Record<TrainingProviderType, ProviderAdapter> = {
	local: createQueuedAdapter('local', 'Local/demo runner'),
	modal: createQueuedAdapter('modal', 'Modal training adapter'),
	prime_intellect: {
		type: 'prime_intellect',
		label: 'Prime Intellect compute pod adapter',
		launch(input) {
			return launchPrimePod(input);
		},
	},
	sagemaker: createQueuedAdapter('sagemaker', 'SageMaker training adapter'),
	custom: createQueuedAdapter('custom', 'Custom provider adapter'),
};

function createQueuedAdapter(type: TrainingProviderType, label: string): ProviderAdapter {
	return {
		type,
		label,
		launch(input) {
			const providerJobId = `${type}-${stableId(input.runId, input.providerId)}`;
			return {
				ok: true,
				status: 'queued',
				providerJobId,
				checkedAt: input.checkedAt,
				logTail: `${label} accepted run ${input.runId} for provider ${input.providerId}.`,
				error: null,
				costUsd: null,
				metricsJson: null,
				artifactUri: null,
			};
		},
	};
}

function stableId(runId: string, providerId: string): string {
	return createHash('sha256').update(`${runId}:${providerId}`).digest('hex').slice(0, 16);
}

function failure(error: string, checkedAt: string): TrainingActionResult {
	return {
		ok: false,
		status: 'failed',
		providerJobId: null,
		checkedAt,
		logTail: null,
		error,
		costUsd: null,
		metricsJson: null,
		artifactUri: null,
	};
}
