import { createHash } from 'node:crypto';

const validationModes = ['schema', 'schema_range', 'schema_range_rank'] as const;

export type ValidationMode = (typeof validationModes)[number];

export type SubmitModelInput = {
	readonly modelId: string | null | undefined;
	readonly providerId?: string | null | undefined;
	readonly numeraiAccountId?: string | null | undefined;
	readonly roundNumber?: number | null | undefined;
	readonly predictionSet: string | null | undefined;
	readonly neutralizationPct: number | null | undefined;
	readonly validationMode: string | null | undefined;
	readonly uploadEnabled: boolean | null | undefined;
	readonly checkedAt?: string;
};

export type SubmitModelResult = {
	readonly ok: boolean;
	readonly status: 'planned' | 'queued' | 'failed';
	readonly submissionId: string | null;
	readonly roundNumber: number | null;
	readonly artifactUri: string | null;
	readonly checkedAt: string;
	readonly logTail: string | null;
	readonly error: string | null;
};

type ParsedSubmitModelInput = {
	readonly modelId: string;
	readonly providerId: string | null;
	readonly numeraiAccountId: string | null;
	readonly roundNumber: number | null;
	readonly predictionSet: string;
	readonly neutralizationPct: number;
	readonly validationMode: ValidationMode;
	readonly uploadEnabled: boolean;
	readonly checkedAt: string;
};

type ParseSubmitResult =
	| { readonly ok: true; readonly value: ParsedSubmitModelInput }
	| { readonly ok: false; readonly result: SubmitModelResult };

export function planSubmission(input: SubmitModelInput): SubmitModelResult {
	const parsed = parseSubmitModelInput(input);
	if (!parsed.ok) return parsed.result;

	const value = parsed.value;
	const artifactUri = predictionArtifactUri(value);
	const submissionId = value.uploadEnabled ? `numerai-${stableId(value)}` : null;

	return {
		ok: true,
		status: value.uploadEnabled ? 'queued' : 'planned',
		submissionId,
		roundNumber: value.roundNumber,
		artifactUri,
		checkedAt: value.checkedAt,
		logTail: value.uploadEnabled
			? `Queued Numerai upload ${submissionId} using artifact ${artifactUri}.`
			: `Prepared export-only prediction artifact ${artifactUri}.`,
		error: null,
	};
}

function parseSubmitModelInput(input: SubmitModelInput): ParseSubmitResult {
	const checkedAt = input.checkedAt ?? new Date().toISOString();
	const modelId = input.modelId?.trim();
	if (!modelId) return fail('modelId is required', checkedAt, input.roundNumber ?? null);

	const predictionSet = input.predictionSet?.trim();
	if (!predictionSet) return fail('predictionSet is required', checkedAt, input.roundNumber ?? null);

	const neutralizationPct = input.neutralizationPct;
	if (typeof neutralizationPct !== 'number' || neutralizationPct < 0 || neutralizationPct > 100) {
		return fail('neutralizationPct must be between 0 and 100', checkedAt, input.roundNumber ?? null);
	}

	const validationMode = normalizeValidationMode(input.validationMode);
	if (!validationMode) {
		return fail(
			`Unsupported validationMode "${input.validationMode ?? ''}". Supported modes: ${validationModes.join(', ')}`,
			checkedAt,
			input.roundNumber ?? null
		);
	}

	const uploadEnabled = input.uploadEnabled === true;
	const numeraiAccountId = input.numeraiAccountId?.trim() || null;
	if (uploadEnabled && !numeraiAccountId) {
		return fail('numeraiAccountId is required when upload is enabled', checkedAt, input.roundNumber ?? null);
	}

	const roundNumber = input.roundNumber ?? null;
	if (roundNumber !== null && (!Number.isInteger(roundNumber) || roundNumber <= 0)) {
		return fail('roundNumber must be a positive integer when provided', checkedAt, roundNumber);
	}

	return {
		ok: true,
		value: {
			modelId,
			providerId: input.providerId?.trim() || null,
			numeraiAccountId,
			roundNumber,
			predictionSet,
			neutralizationPct,
			validationMode,
			uploadEnabled,
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

function fail(error: string, checkedAt: string, roundNumber: number | null): ParseSubmitResult {
	return {
		ok: false,
		result: {
			ok: false,
			status: 'failed',
			submissionId: null,
			roundNumber,
			artifactUri: null,
			checkedAt,
			logTail: null,
			error,
		},
	};
}
