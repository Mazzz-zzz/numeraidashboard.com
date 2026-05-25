const NUMERAI_GRAPHQL = 'https://api-tournament.numer.ai/';

const ROUND_PERFORMANCES_QUERY = `
query RoundModelPerformancesV2($modelId: String!) {
  v2RoundModelPerformances(modelId: $modelId) {
    roundNumber
    roundOpenTime
    roundResolveTime
    roundResolved
    submissionScores {
      day
      displayName
      value
      percentile
    }
  }
}
`;

export type ModelScoreSample = {
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
	readonly submissionScores: readonly ModelScoreSample[];
};

export type ModelPerformance = {
	readonly numeraiModelId: string;
	readonly rounds: readonly ModelRoundPerformance[];
	readonly latestRound: number | null;
	readonly latestScores: Record<string, ModelScoreSample>;
	readonly error: string | null;
};

export type NumeraiSubmissionsQueryInput = {
	readonly publicId: string;
	readonly secretKey: string;
	readonly numeraiModelIds: readonly string[];
	readonly maxRounds?: number;
};

export type FetchFn = typeof fetch;

const DEFAULT_MAX_ROUNDS = 30;

export async function fetchNumeraiSubmissions(
	input: NumeraiSubmissionsQueryInput,
	deps: { readonly fetchFn?: FetchFn } = {}
): Promise<readonly ModelPerformance[]> {
	const fetchFn = deps.fetchFn ?? fetch;
	const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
	const auth = `Token ${input.publicId}$${input.secretKey}`;

	const results: ModelPerformance[] = [];
	for (const numeraiModelId of input.numeraiModelIds) {
		const id = numeraiModelId.trim();
		if (!id) continue;
		try {
			const rounds = await queryRoundPerformances(fetchFn, auth, id);
			const limited = limitRounds(rounds, maxRounds);
			results.push({
				numeraiModelId: id,
				rounds: limited,
				latestRound: limited[0]?.roundNumber ?? null,
				latestScores: pickLatestScores(limited),
				error: null,
			});
		} catch (e) {
			results.push({
				numeraiModelId: id,
				rounds: [],
				latestRound: null,
				latestScores: {},
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
	return results;
}

async function queryRoundPerformances(
	fetchFn: FetchFn,
	auth: string,
	modelId: string
): Promise<readonly ModelRoundPerformance[]> {
	const resp = await fetchFn(NUMERAI_GRAPHQL, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			Authorization: auth,
		},
		body: JSON.stringify({
			query: ROUND_PERFORMANCES_QUERY,
			variables: { modelId },
		}),
	});
	const body = (await resp.json().catch(() => null)) as {
		data?: { v2RoundModelPerformances?: unknown };
		errors?: { message: string }[];
	} | null;
	if (!resp.ok) {
		throw new Error(`Numerai GraphQL HTTP ${resp.status}: ${body?.errors?.[0]?.message ?? 'unknown error'}`);
	}
	if (body?.errors?.length) {
		throw new Error(body.errors[0].message);
	}
	const raw = body?.data?.v2RoundModelPerformances;
	if (!Array.isArray(raw)) return [];
	return raw
		.map(parseRoundPerformance)
		.filter((round): round is ModelRoundPerformance => round !== null)
		.sort((a, b) => b.roundNumber - a.roundNumber);
}

function parseRoundPerformance(value: unknown): ModelRoundPerformance | null {
	const record = asRecord(value);
	if (!record) return null;
	const roundNumber = numberFrom(record.roundNumber);
	if (roundNumber === null) return null;
	return {
		roundNumber,
		roundOpenTime: stringFrom(record.roundOpenTime),
		roundResolveTime: stringFrom(record.roundResolveTime),
		roundResolved: record.roundResolved === true,
		submissionScores: Array.isArray(record.submissionScores)
			? record.submissionScores.map(parseScore).filter((s): s is ModelScoreSample => s !== null)
			: [],
	};
}

function parseScore(value: unknown): ModelScoreSample | null {
	const record = asRecord(value);
	if (!record) return null;
	const day = numberFrom(record.day);
	const displayName = stringFrom(record.displayName);
	if (day === null || !displayName) return null;
	return {
		day,
		displayName,
		value: numberFrom(record.value),
		percentile: numberFrom(record.percentile),
	};
}

function limitRounds(
	rounds: readonly ModelRoundPerformance[],
	max: number
): readonly ModelRoundPerformance[] {
	if (max <= 0 || rounds.length <= max) return rounds;
	return rounds.slice(0, max);
}

function pickLatestScores(rounds: readonly ModelRoundPerformance[]): Record<string, ModelScoreSample> {
	const out: Record<string, ModelScoreSample> = {};
	for (const round of rounds) {
		for (const score of round.submissionScores) {
			const current = out[score.displayName];
			if (!current) {
				out[score.displayName] = score;
				continue;
			}
			if (
				round.roundNumber > findRoundForScore(rounds, current) ||
				(round.roundNumber === findRoundForScore(rounds, current) && score.day > current.day)
			) {
				out[score.displayName] = score;
			}
		}
	}
	return out;
}

function findRoundForScore(
	rounds: readonly ModelRoundPerformance[],
	score: ModelScoreSample
): number {
	for (const round of rounds) {
		if (round.submissionScores.some((s) => s.displayName === score.displayName && s.day === score.day)) {
			return round.roundNumber;
		}
	}
	return -1;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberFrom(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}

function stringFrom(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}
