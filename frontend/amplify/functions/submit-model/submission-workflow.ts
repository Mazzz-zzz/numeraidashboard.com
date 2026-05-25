import { createHash } from 'node:crypto';
import { launchModalInference, resolveSecretRef } from '../modal';

const validationModes = ['schema', 'schema_range', 'schema_range_rank'] as const;

export type ValidationMode = (typeof validationModes)[number];

export type SubmitModelInput = {
	readonly modelId: string | null | undefined;
	readonly providerId?: string | null | undefined;
	readonly providerType?: string | null | undefined;
	readonly numeraiAccountId?: string | null | undefined;
	readonly numeraiModelId?: string | null | undefined;
	readonly numeraiPublicId?: string | null | undefined;
	readonly numeraiSecretRef?: string | null | undefined;
	readonly modelArtifactUri?: string | null | undefined;
	readonly roundNumber?: number | null | undefined;
	readonly predictionSet: string | null | undefined;
	readonly neutralizationPct: number | null | undefined;
	readonly validationMode: string | null | undefined;
	readonly uploadEnabled: boolean | null | undefined;
	readonly baseUrl?: string | null | undefined;
	readonly providerConfigJson?: unknown;
	readonly checkedAt?: string;
};

export type SubmitModelResult = {
	readonly ok: boolean;
	readonly status: 'planned' | 'queued' | 'failed';
	readonly submissionId: string | null;
	readonly providerJobId: string | null;
	readonly roundNumber: number | null;
	readonly artifactUri: string | null;
	readonly checkedAt: string;
	readonly logTail: string | null;
	readonly error: string | null;
};

type ParsedSubmitModelInput = {
	readonly modelId: string;
	readonly providerId: string | null;
	readonly providerType: string | null;
	readonly numeraiAccountId: string | null;
	readonly numeraiModelId: string | null;
	readonly numeraiPublicId: string | null;
	readonly numeraiSecretRef: string | null;
	readonly modelArtifactUri: string | null;
	readonly roundNumber: number | null;
	readonly predictionSet: string;
	readonly neutralizationPct: number;
	readonly validationMode: ValidationMode;
	readonly uploadEnabled: boolean;
	readonly baseUrl: string | null;
	readonly providerConfigJson: unknown;
	readonly checkedAt: string;
};

type ParseSubmitResult =
	| { readonly ok: true; readonly value: ParsedSubmitModelInput }
	| { readonly ok: false; readonly result: SubmitModelResult };

export async function runSubmission(
	input: SubmitModelInput,
	deps: { readonly secretResolver?: (name: string) => Promise<string> } = {}
): Promise<SubmitModelResult> {
	const parsed = parseSubmitModelInput(input);
	if (!parsed.ok) return parsed.result;
	const value = parsed.value;

	if (!value.uploadEnabled) {
		return planExportOnly(value);
	}

	if (value.providerType === 'modal') {
		return submitViaModal(value, deps);
	}

	// Other providers fall back to the planned-queued behavior until they're wired.
	return planQueuedSubmission(value, `Submission queued for ${value.providerType ?? 'unknown'} provider; runtime not yet wired.`);
}

// Kept for backwards-compatibility with existing callers/tests.
export function planSubmission(input: SubmitModelInput): SubmitModelResult {
	const parsed = parseSubmitModelInput(input);
	if (!parsed.ok) return parsed.result;
	const value = parsed.value;
	if (!value.uploadEnabled) return planExportOnly(value);
	return planQueuedSubmission(value);
}

async function submitViaModal(
	value: ParsedSubmitModelInput,
	deps: { readonly secretResolver?: (name: string) => Promise<string> }
): Promise<SubmitModelResult> {
	if (!value.numeraiPublicId) {
		return fail('numeraiPublicId is required for Modal submission', value).result;
	}
	if (!value.numeraiSecretRef) {
		return fail('numeraiSecretRef is required for Modal submission', value).result;
	}
	if (!value.numeraiModelId) {
		return fail('numeraiModelId is required for Modal submission', value).result;
	}
	if (!value.modelArtifactUri) {
		return fail('modelArtifactUri is required for Modal submission', value).result;
	}

	let secretKey: string | null;
	try {
		secretKey = await resolveSecretRef(value.numeraiSecretRef, deps.secretResolver);
	} catch (e) {
		return fail(`Failed to resolve Numerai secret: ${e instanceof Error ? e.message : String(e)}`, value).result;
	}
	if (!secretKey) {
		return fail('Resolved Numerai secret was empty', value).result;
	}

	const jobName = submissionJobName(value);
	const launch = await launchModalInference({
		jobName,
		modelArtifactUri: value.modelArtifactUri,
		numeraiPublicId: value.numeraiPublicId,
		numeraiSecretKey: secretKey,
		numeraiModelId: value.numeraiModelId,
		baseUrl: value.baseUrl,
		providerConfigJson: value.providerConfigJson,
		checkedAt: value.checkedAt,
	});

	if (!launch.ok || !launch.providerJobId) {
		return {
			ok: false,
			status: 'failed',
			submissionId: null,
			providerJobId: launch.providerJobId,
			roundNumber: value.roundNumber,
			artifactUri: predictionArtifactUri(value),
			checkedAt: value.checkedAt,
			logTail: launch.logTail,
			error: launch.error ?? 'Modal submission failed',
		};
	}

	return {
		ok: true,
		status: 'queued',
		submissionId: `modal-${launch.providerJobId}`,
		providerJobId: launch.providerJobId,
		roundNumber: value.roundNumber,
		artifactUri: predictionArtifactUri(value),
		checkedAt: value.checkedAt,
		logTail: launch.logTail ?? `Modal inference ${jobName} spawned for model ${value.numeraiModelId}.`,
		error: null,
	};
}

function planExportOnly(value: ParsedSubmitModelInput): SubmitModelResult {
	const artifactUri = predictionArtifactUri(value);
	return {
		ok: true,
		status: 'planned',
		submissionId: null,
		providerJobId: null,
		roundNumber: value.roundNumber,
		artifactUri,
		checkedAt: value.checkedAt,
		logTail: `Prepared export-only prediction artifact ${artifactUri}.`,
		error: null,
	};
}

function planQueuedSubmission(value: ParsedSubmitModelInput, logTail?: string): SubmitModelResult {
	const artifactUri = predictionArtifactUri(value);
	const submissionId = `numerai-${stableId(value)}`;
	return {
		ok: true,
		status: 'queued',
		submissionId,
		providerJobId: null,
		roundNumber: value.roundNumber,
		artifactUri,
		checkedAt: value.checkedAt,
		logTail: logTail ?? `Queued Numerai upload ${submissionId} using artifact ${artifactUri}.`,
		error: null,
	};
}

function parseSubmitModelInput(input: SubmitModelInput): ParseSubmitResult {
	const checkedAt = input.checkedAt ?? new Date().toISOString();
	const modelId = input.modelId?.trim();
	if (!modelId) return fail('modelId is required', { checkedAt, roundNumber: input.roundNumber ?? null });

	const predictionSet = input.predictionSet?.trim();
	if (!predictionSet)
		return fail('predictionSet is required', { checkedAt, roundNumber: input.roundNumber ?? null });

	const neutralizationPct = input.neutralizationPct;
	if (typeof neutralizationPct !== 'number' || neutralizationPct < 0 || neutralizationPct > 100) {
		return fail('neutralizationPct must be between 0 and 100', { checkedAt, roundNumber: input.roundNumber ?? null });
	}

	const validationMode = normalizeValidationMode(input.validationMode);
	if (!validationMode) {
		return fail(
			`Unsupported validationMode "${input.validationMode ?? ''}". Supported modes: ${validationModes.join(', ')}`,
			{ checkedAt, roundNumber: input.roundNumber ?? null }
		);
	}

	const uploadEnabled = input.uploadEnabled === true;
	const numeraiAccountId = input.numeraiAccountId?.trim() || null;
	if (uploadEnabled && !numeraiAccountId) {
		return fail('numeraiAccountId is required when upload is enabled', { checkedAt, roundNumber: input.roundNumber ?? null });
	}

	const roundNumber = input.roundNumber ?? null;
	if (roundNumber !== null && (!Number.isInteger(roundNumber) || roundNumber <= 0)) {
		return fail('roundNumber must be a positive integer when provided', { checkedAt, roundNumber });
	}

	return {
		ok: true,
		value: {
			modelId,
			providerId: input.providerId?.trim() || null,
			providerType: input.providerType?.trim().toLowerCase() || null,
			numeraiAccountId,
			numeraiModelId: input.numeraiModelId?.trim() || null,
			numeraiPublicId: input.numeraiPublicId?.trim() || null,
			numeraiSecretRef: input.numeraiSecretRef?.trim() || null,
			modelArtifactUri: input.modelArtifactUri?.trim() || null,
			roundNumber,
			predictionSet,
			neutralizationPct,
			validationMode,
			uploadEnabled,
			baseUrl: input.baseUrl?.trim() || null,
			providerConfigJson: input.providerConfigJson ?? null,
			checkedAt,
		},
	};
}

function normalizeValidationMode(value: string | null | undefined): ValidationMode | null {
	const normalized = value?.trim();
	return validationModes.includes(normalized as ValidationMode) ? (normalized as ValidationMode) : null;
}

function predictionArtifactUri(input: ParsedSubmitModelInput): string {
	const round = input.roundNumber === null ? 'next' : String(input.roundNumber);
	return `artifact://numeraidashboard/predictions/${input.modelId}/round-${round}/${stableId(input)}.csv`;
}

function stableId(input: ParsedSubmitModelInput): string {
	return createHash('sha256')
		.update(
			[
				input.modelId,
				input.providerId ?? 'no-provider',
				input.numeraiAccountId ?? 'export-only',
				input.roundNumber ?? 'next',
				input.predictionSet,
				input.neutralizationPct,
				input.validationMode,
				input.uploadEnabled ? 'upload' : 'export',
			].join(':')
		)
		.digest('hex')
		.slice(0, 20);
}

function submissionJobName(input: ParsedSubmitModelInput): string {
	const round = input.roundNumber === null ? 'next' : String(input.roundNumber);
	return `submit-${input.modelId}-r${round}-${stableId(input).slice(0, 8)}`;
}

type FailContext = { readonly checkedAt: string; readonly roundNumber: number | null };

function fail(error: string, ctx: ParsedSubmitModelInput | FailContext): ParseSubmitResult {
	const checkedAt = 'checkedAt' in ctx ? ctx.checkedAt : (ctx as ParsedSubmitModelInput).checkedAt;
	const roundNumber = 'roundNumber' in ctx ? ctx.roundNumber : null;
	return {
		ok: false,
		result: {
			ok: false,
			status: 'failed',
			submissionId: null,
			providerJobId: null,
			roundNumber,
			artifactUri: null,
			checkedAt,
			logTail: null,
			error,
		},
	};
}
