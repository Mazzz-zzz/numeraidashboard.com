import { dataClient } from '$lib/data';
import type { Schema } from '../../../amplify/data/resource';
import { listNumeraiAccounts, type NumeraiAccount } from './account-service';
import { listRegistryModels, type ModelRegistryItem } from './registry-service';

type Client = ReturnType<typeof dataClient>;

export type NumeraiSubmissionsResult = NonNullable<Schema['NumeraiSubmissionsResult']['type']>;

export type ScoreSample = {
	readonly day: number;
	readonly displayName: string;
	readonly value: number | null;
	readonly percentile: number | null;
};

export type ModelRoundPerformance = {
	readonly roundNumber: number;
	readonly roundOpenTime: string | null;
	readonly roundResolveTime: string | null;
	readonly roundResolved: boolean;
	readonly submissionScores: readonly ScoreSample[];
};

export type ModelPerformance = {
	readonly numeraiModelId: string;
	readonly rounds: readonly ModelRoundPerformance[];
	readonly latestRound: number | null;
	readonly latestScores: Record<string, ScoreSample>;
	readonly error: string | null;
};

export type SubmissionsBundle = {
	readonly checkedAt: string | null;
	readonly performances: readonly ModelPerformance[];
	readonly error: string | null;
};

export const TRACKED_METRICS = ['canon_corr', 'canon_mmc', 'corr60', 'mmc60', 'fnc_v3'] as const;
export type TrackedMetric = (typeof TRACKED_METRICS)[number];

export async function loadSubmissionsBundle(
	options: { readonly maxRounds?: number } = {},
	client: Client = dataClient()
): Promise<SubmissionsBundle> {
	const [models, accounts] = await Promise.all([listRegistryModels(client), listNumeraiAccounts(client)]);
	const account = accounts[0] ?? null;
	const modelIds = uniqueNumeraiModelIds(models);

	if (!account) {
		return {
			checkedAt: null,
			performances: [],
			error: 'No Numerai account linked. Add one in Settings.',
		};
	}
	if (!modelIds.length) {
		return {
			checkedAt: null,
			performances: [],
			error: 'No models with a Numerai slot id yet. Link a model in Settings or Models.',
		};
	}

	return fetchSubmissionsForAccount(account, modelIds, options.maxRounds ?? 30, client);
}

export async function fetchSubmissionsForAccount(
	account: NumeraiAccount,
	numeraiModelIds: readonly string[],
	maxRounds = 30,
	client: Client = dataClient()
): Promise<SubmissionsBundle> {
	const { data, errors } = await client.mutations.fetchNumeraiSubmissions({
		publicId: account.publicId,
		secretRef: account.secretRef ?? null,
		numeraiModelIds: [...numeraiModelIds],
		maxRounds
	});
	if (errors?.length) {
		return { checkedAt: null, performances: [], error: errors[0].message };
	}
	if (!data) {
		return { checkedAt: null, performances: [], error: 'fetchNumeraiSubmissions returned no data' };
	}
	const result = data as NumeraiSubmissionsResult;
	if (!result.ok) {
		return { checkedAt: result.checkedAt ?? null, performances: [], error: result.error ?? 'Unknown error' };
	}
	return {
		checkedAt: result.checkedAt,
		performances: parsePerformances(result.modelsJson),
		error: null
	};
}

export function uniqueNumeraiModelIds(models: readonly ModelRegistryItem[]): string[] {
	const ids = new Set<string>();
	for (const model of models) {
		const id = (model.numeraiModelId ?? '').trim();
		if (id) ids.add(id);
	}
	return [...ids];
}

export function findPerformance(
	performances: readonly ModelPerformance[],
	numeraiModelId: string | null | undefined
): ModelPerformance | null {
	if (!numeraiModelId) return null;
	return performances.find((p) => p.numeraiModelId === numeraiModelId) ?? null;
}

export function metricSeries(
	performance: ModelPerformance | null,
	metric: string
): readonly { round: number; value: number; percentile: number | null }[] {
	if (!performance) return [];
	const series: { round: number; value: number; percentile: number | null }[] = [];
	for (const round of performance.rounds) {
		const sample = lastSampleForMetric(round.submissionScores, metric);
		if (sample && typeof sample.value === 'number') {
			series.push({ round: round.roundNumber, value: sample.value, percentile: sample.percentile });
		}
	}
	return series.sort((a, b) => a.round - b.round);
}

function lastSampleForMetric(
	scores: readonly ScoreSample[],
	metric: string
): ScoreSample | null {
	let latest: ScoreSample | null = null;
	for (const sample of scores) {
		if (sample.displayName !== metric) continue;
		if (!latest || sample.day > latest.day) latest = sample;
	}
	return latest;
}

export function meanMetric(series: readonly { value: number }[]): number | null {
	if (!series.length) return null;
	const sum = series.reduce((acc, point) => acc + point.value, 0);
	return sum / series.length;
}

export function formatScore(value: number | null | undefined, digits = 4): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
	const sign = value >= 0 ? '+' : '';
	return `${sign}${value.toFixed(digits)}`;
}

export function formatPercentile(value: number | null | undefined): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
	const pct = value > 1 ? value : value * 100;
	return `${pct.toFixed(0)}%`;
}

function parsePerformances(modelsJson: unknown): readonly ModelPerformance[] {
	if (typeof modelsJson !== 'string' || !modelsJson.trim()) return [];
	try {
		const parsed = JSON.parse(modelsJson);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(parseModelPerformance)
			.filter((p): p is ModelPerformance => p !== null);
	} catch {
		return [];
	}
}

function parseModelPerformance(value: unknown): ModelPerformance | null {
	if (!value || typeof value !== 'object') return null;
	const record = value as Record<string, unknown>;
	const numeraiModelId = typeof record.numeraiModelId === 'string' ? record.numeraiModelId : null;
	if (!numeraiModelId) return null;
	const rounds = Array.isArray(record.rounds) ? record.rounds.map(parseRound).filter((r): r is ModelRoundPerformance => r !== null) : [];
	const latestScores = record.latestScores && typeof record.latestScores === 'object' && !Array.isArray(record.latestScores)
		? (record.latestScores as Record<string, ScoreSample>)
		: {};
	return {
		numeraiModelId,
		rounds,
		latestRound: typeof record.latestRound === 'number' ? record.latestRound : null,
		latestScores,
		error: typeof record.error === 'string' ? record.error : null
	};
}

function parseRound(value: unknown): ModelRoundPerformance | null {
	if (!value || typeof value !== 'object') return null;
	const record = value as Record<string, unknown>;
	const roundNumber = typeof record.roundNumber === 'number' ? record.roundNumber : null;
	if (roundNumber === null) return null;
	return {
		roundNumber,
		roundOpenTime: typeof record.roundOpenTime === 'string' ? record.roundOpenTime : null,
		roundResolveTime: typeof record.roundResolveTime === 'string' ? record.roundResolveTime : null,
		roundResolved: record.roundResolved === true,
		submissionScores: Array.isArray(record.submissionScores)
			? (record.submissionScores as ScoreSample[]).filter((s) => typeof s?.displayName === 'string')
			: []
	};
}
