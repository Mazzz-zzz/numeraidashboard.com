import { describe, expect, it, vi } from 'vitest';
import { fetchNumeraiSubmissions } from './numerai-query';

function mockResponse(payload: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: async () => payload,
	} as unknown as Response;
}

describe('fetchNumeraiSubmissions', () => {
	it('returns parsed rounds and latest scores per model', async () => {
		const fetchFn = vi.fn(async () =>
			mockResponse({
				data: {
					v2RoundModelPerformances: [
						{
							roundNumber: 842,
							roundOpenTime: '2026-05-17T18:00:00Z',
							roundResolveTime: '2026-05-22T18:00:00Z',
							roundResolved: true,
							submissionScores: [
								{ day: 5, displayName: 'canon_corr', value: 0.027, percentile: 0.72 },
								{ day: 5, displayName: 'canon_mmc', value: 0.012, percentile: 0.65 },
							],
						},
						{
							roundNumber: 841,
							roundOpenTime: '2026-05-10T18:00:00Z',
							roundResolveTime: '2026-05-15T18:00:00Z',
							roundResolved: true,
							submissionScores: [
								{ day: 5, displayName: 'canon_corr', value: 0.018, percentile: 0.55 },
							],
						},
					],
				},
			})
		);

		const result = await fetchNumeraiSubmissions(
			{
				publicId: 'pub',
				secretKey: 'sec',
				numeraiModelIds: ['model-1'],
			},
			{ fetchFn: fetchFn as unknown as typeof fetch }
		);

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(result).toHaveLength(1);
		expect(result[0].numeraiModelId).toBe('model-1');
		expect(result[0].error).toBeNull();
		expect(result[0].rounds.map((r) => r.roundNumber)).toEqual([842, 841]);
		expect(result[0].latestRound).toBe(842);
		expect(result[0].latestScores.canon_corr.value).toBe(0.027);
		expect(result[0].latestScores.canon_mmc.value).toBe(0.012);
	});

	it('records per-model errors without failing the whole batch', async () => {
		const fetchFn = vi.fn(async (_url: unknown, init: { body: string }) => {
			const variables = JSON.parse(init.body).variables;
			if (variables.modelId === 'model-broken') {
				return mockResponse({ errors: [{ message: 'unauthorized' }] }, true, 200);
			}
			return mockResponse({
				data: {
					v2RoundModelPerformances: [
						{
							roundNumber: 1,
							submissionScores: [{ day: 5, displayName: 'canon_corr', value: 0.01 }],
						},
					],
				},
			});
		});

		const result = await fetchNumeraiSubmissions(
			{
				publicId: 'pub',
				secretKey: 'sec',
				numeraiModelIds: ['model-ok', 'model-broken'],
			},
			{ fetchFn: fetchFn as unknown as typeof fetch }
		);

		expect(result).toHaveLength(2);
		expect(result[0].numeraiModelId).toBe('model-ok');
		expect(result[0].error).toBeNull();
		expect(result[0].rounds).toHaveLength(1);
		expect(result[1].numeraiModelId).toBe('model-broken');
		expect(result[1].error).toBe('unauthorized');
		expect(result[1].rounds).toHaveLength(0);
	});

	it('limits rounds to maxRounds, keeping newest first', async () => {
		const fetchFn = vi.fn(async () =>
			mockResponse({
				data: {
					v2RoundModelPerformances: Array.from({ length: 50 }, (_, idx) => ({
						roundNumber: 800 + idx,
						roundResolved: idx < 45,
						submissionScores: [{ day: 5, displayName: 'canon_corr', value: idx / 1000 }],
					})),
				},
			})
		);

		const result = await fetchNumeraiSubmissions(
			{
				publicId: 'pub',
				secretKey: 'sec',
				numeraiModelIds: ['model-1'],
				maxRounds: 10,
			},
			{ fetchFn: fetchFn as unknown as typeof fetch }
		);

		expect(result[0].rounds).toHaveLength(10);
		expect(result[0].rounds[0].roundNumber).toBe(849);
		expect(result[0].rounds[9].roundNumber).toBe(840);
	});

	it('skips empty model ids', async () => {
		const fetchFn = vi.fn();
		const result = await fetchNumeraiSubmissions(
			{ publicId: 'pub', secretKey: 'sec', numeraiModelIds: ['', '   '] },
			{ fetchFn: fetchFn as unknown as typeof fetch }
		);
		expect(fetchFn).not.toHaveBeenCalled();
		expect(result).toEqual([]);
	});
});
