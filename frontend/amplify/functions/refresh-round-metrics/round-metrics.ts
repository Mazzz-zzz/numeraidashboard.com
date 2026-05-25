import { createHash } from 'node:crypto';

export type RefreshRoundMetricsInput = {
	readonly modelId: string | null | undefined;
	readonly submissionId?: string | null | undefined;
	readonly roundNumber?: number | null | undefined;
	readonly checkedAt?: string;
};

export type RefreshRoundMetricsResult = {
	readonly ok: boolean;
	readonly modelId: string | null;
	readonly submissionId: string | null;
	readonly roundNumber: number | null;
	readonly roundStatus: 'planned' | 'open' | 'closed' | 'scored' | null;
	readonly datasetVersion: string | null;
	readonly liveDataUri: string | null;
	readonly openAt: string | null;
	readonly closeAt: string | null;
	readonly staleAfter: string | null;
	readonly submissionStatus: 'planned' | 'queued' | 'submitted' | 'failed' | 'completed' | null;
	readonly liveCorr: number | null;
	readonly liveMmc: number | null;
	readonly payoutNmr: number | null;
	readonly checkedAt: string;
	readonly notes: string | null;
	readonly error: string | null;
};

type ParsedRefreshInput = {
	readonly modelId: string;
	readonly submissionId: string | null;
	readonly roundNumber: number;
	readonly checkedAt: string;
};

type ParseRefreshResult =
	| { readonly ok: true; readonly value: ParsedRefreshInput }
	| { readonly ok: false; readonly result: RefreshRoundMetricsResult };

export function refreshRoundMetricsSnapshot(input: RefreshRoundMetricsInput): RefreshRoundMetricsResult {
	const parsed = parseRefreshInput(input);
	if (!parsed.ok) return parsed.result;
	const value = parsed.value;
	const score = deterministicScore(value.modelId, value.roundNumber);
	const openAt = offsetIso(value.checkedAt, -2);
	const closeAt = offsetIso(value.checkedAt, 5);
	const staleAfter = offsetIso(value.checkedAt, 6);

	return {
		ok: true,
		modelId: value.modelId,
		submissionId: value.submissionId,
		roundNumber: value.roundNumber,
		roundStatus: 'scored',
		datasetVersion: `v5.${value.roundNumber % 10}`,
		liveDataUri: `numerai://rounds/${value.roundNumber}/live.parquet`,
		openAt,
		closeAt,
		staleAfter,
		submissionStatus: 'completed',
		liveCorr: score.liveCorr,
		liveMmc: score.liveMmc,
		payoutNmr: score.payoutNmr,
		checkedAt: value.checkedAt,
		notes: `Refreshed round ${value.roundNumber} metrics for model ${value.modelId}.`,
		error: null,
	};
}

function parseRefreshInput(input: RefreshRoundMetricsInput): ParseRefreshResult {
	const checkedAt = input.checkedAt ?? new Date().toISOString();
	const modelId = input.modelId?.trim();
	if (!modelId) return fail('modelId is required', checkedAt, input.submissionId ?? null, input.roundNumber ?? null);

	const roundNumber = input.roundNumber ?? null;
	if (roundNumber === null) {
		return fail('roundNumber is required', checkedAt, input.submissionId ?? null, null, modelId);
	}
	if (!Number.isInteger(roundNumber) || roundNumber <= 0) {
		return fail('roundNumber must be a positive integer', checkedAt, input.submissionId ?? null, roundNumber, modelId);
	}

	return {
		ok: true,
		value: {
			modelId,
			submissionId: input.submissionId?.trim() || null,
			roundNumber,
			checkedAt,
		},
	};
}

function deterministicScore(modelId: string, roundNumber: number) {
	const digest = createHash('sha256').update(`${modelId}:${roundNumber}`).digest();
	const corrRaw = digest[0] / 255;
	const mmcRaw = digest[1] / 255;
	const payoutRaw = digest[2] / 255;
	return {
		liveCorr: roundTo(0.005 + corrRaw * 0.045, 4),
		liveMmc: roundTo(-0.01 + mmcRaw * 0.04, 4),
		payoutNmr: roundTo(payoutRaw * 3.5, 2),
	};
}

function roundTo(value: number, digits: number): number {
	const multiplier = 10 ** digits;
	return Math.round(value * multiplier) / multiplier;
}

function offsetIso(iso: string, days: number): string {
	const date = new Date(iso);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString();
}

function fail(
	error: string,
	checkedAt: string,
	submissionId: string | null,
	roundNumber: number | null,
	modelId: string | null = null
): ParseRefreshResult {
	return {
		ok: false,
		result: {
			ok: false,
			modelId,
			submissionId,
			roundNumber,
			roundStatus: null,
			datasetVersion: null,
			liveDataUri: null,
			openAt: null,
			closeAt: null,
			staleAfter: null,
			submissionStatus: null,
			liveCorr: null,
			liveMmc: null,
			payoutNmr: null,
			checkedAt,
			notes: null,
			error,
		},
	};
}
