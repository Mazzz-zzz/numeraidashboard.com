import { describe, expect, it } from 'vitest';
import {
	latestRoundDataset,
	latestSubmissionForModel,
	parseRoundNumber,
	refreshRoundMetricsForModel,
	registryPayloadFromRefresh,
	roundDatasetPayloadFromRefresh,
	roundFreshnessLabel,
	roundLabel,
	submissionRecordPayloadFromResult,
	submissionPayloadFromRefresh,
	submissionPlanPayload,
	submissionStatusLabel
} from './submission-service';
import type { ModelSubmission, RoundDataset } from './submission-service';

describe('submission service', () => {
	it('parses positive round numbers and rejects blank or invalid values', () => {
		expect(parseRoundNumber(' 842 ')).toBe(842);
		expect(parseRoundNumber('')).toBeNull();
		expect(parseRoundNumber('0')).toBeNull();
		expect(parseRoundNumber('next')).toBeNull();
	});

	it('builds a planned ModelSubmission payload from selected inputs', () => {
		expect(
			submissionPlanPayload({
				selectedModelId: 'model-1',
				selectedProviderId: 'provider-1',
				numeraiAccountId: 'account-1',
				roundNumber: '123',
				predictionSet: 'live',
				neutralizationPct: 50,
				validationMode: 'schema_range_rank',
				uploadEnabled: true,
				modelName: 'Prod',
				providerName: 'Modal'
			})
		).toEqual({
			modelId: 'model-1',
			providerId: 'provider-1',
			numeraiAccountId: 'account-1',
			roundNumber: 123,
			status: 'planned',
			predictionSet: 'live',
			neutralizationPct: 50,
			validationMode: 'schema_range_rank',
			uploadEnabled: true,
			notes: 'Prepared submission plan for Prod on Modal'
		});
	});

	it('finds the newest submission for a model', () => {
		const submissions = [
			{ id: 'old', modelId: 'model-1', status: 'planned', createdAt: '2026-05-20T00:00:00.000Z' },
			{ id: 'new', modelId: 'model-1', status: 'queued', submittedAt: '2026-05-23T00:00:00.000Z' },
			{ id: 'other', modelId: 'model-2', status: 'queued', submittedAt: '2026-05-24T00:00:00.000Z' }
		] as ModelSubmission[];

		expect(latestSubmissionForModel('model-1', submissions)?.id).toBe('new');
	});

	it('formats round and submission labels', () => {
		expect(roundLabel({ roundNumber: 842, datasetVersion: 'v5.2' } as RoundDataset)).toBe(
			'Round 842 · v5.2'
		);
		expect(submissionStatusLabel({ status: 'queued', roundNumber: 842 } as ModelSubmission)).toBe(
			'queued r842'
		);
		expect(submissionStatusLabel(null)).toBe('No submission yet');
	});

	it('reports latest round cache freshness', () => {
		const rounds = [
			{ roundNumber: 840, staleAfter: '2026-05-20T00:00:00.000Z' },
			{ roundNumber: 842, staleAfter: '2026-05-24T00:00:00.000Z' }
		] as RoundDataset[];

		expect(latestRoundDataset(rounds)?.roundNumber).toBe(842);
		expect(roundFreshnessLabel(rounds[1], '2026-05-23T00:00:00.000Z')).toBe('Round cache fresh');
		expect(roundFreshnessLabel(rounds[0], '2026-05-23T00:00:00.000Z')).toBe('Round cache stale');
		expect(roundFreshnessLabel(null)).toBe('No round cache');
	});

	it('persists submit-model result details into ModelSubmission payloads', () => {
		const draft = {
			selectedModelId: 'model-1',
			selectedProviderId: 'provider-1',
			numeraiAccountId: 'account-1',
			roundNumber: '842',
			predictionSet: 'live',
			neutralizationPct: 50,
			validationMode: 'schema_range_rank' as const,
			uploadEnabled: true,
			modelName: 'Prod',
			providerName: 'Modal'
		};

		expect(
			submissionRecordPayloadFromResult(draft, {
				ok: true,
				status: 'queued',
				submissionId: 'numerai-123',
				roundNumber: 842,
				artifactUri: 'artifact://numeraidashboard/predictions/model-1/round-842/run.csv',
				checkedAt: '2026-05-23T16:00:00.000Z',
				logTail: 'Queued Numerai upload numerai-123',
				error: null
			})
		).toEqual({
			modelId: 'model-1',
			providerId: 'provider-1',
			numeraiAccountId: 'account-1',
			roundNumber: 842,
			status: 'queued',
			predictionSet: 'live',
			neutralizationPct: 50,
			validationMode: 'schema_range_rank',
			uploadEnabled: true,
			externalSubmissionId: 'numerai-123',
			artifactUri: 'artifact://numeraidashboard/predictions/model-1/round-842/run.csv',
			submittedAt: '2026-05-23T16:00:00.000Z',
			notes: 'Queued Numerai upload numerai-123'
			});
	});

	it('builds round, submission, and registry updates from refresh results', () => {
		const result = {
			ok: true,
			modelId: 'model-1',
			submissionId: 'submission-1',
			roundNumber: 842,
			roundStatus: 'scored',
			datasetVersion: 'v5.2',
			liveDataUri: 'numerai://rounds/842/live.parquet',
			openAt: '2026-05-21T16:00:00.000Z',
			closeAt: '2026-05-28T16:00:00.000Z',
			staleAfter: '2026-05-29T16:00:00.000Z',
			submissionStatus: 'completed',
			liveCorr: 0.0234,
			liveMmc: 0.0111,
			payoutNmr: 1.25,
			checkedAt: '2026-05-23T16:00:00.000Z',
			notes: 'Refreshed round 842 metrics',
			error: null
		};

		expect(roundDatasetPayloadFromRefresh(result)).toEqual({
			roundNumber: 842,
			status: 'scored',
			openAt: '2026-05-21T16:00:00.000Z',
			closeAt: '2026-05-28T16:00:00.000Z',
			datasetVersion: 'v5.2',
			liveDataUri: 'numerai://rounds/842/live.parquet',
			cachedAt: '2026-05-23T16:00:00.000Z',
			staleAfter: '2026-05-29T16:00:00.000Z'
		});
		expect(submissionPayloadFromRefresh(result)).toEqual({
			status: 'completed',
			roundNumber: 842,
			notes: 'Refreshed round 842 metrics',
			submittedAt: '2026-05-23T16:00:00.000Z'
		});
		expect(registryPayloadFromRefresh(result)).toEqual({
			lastSubmittedRound: 842,
			lastSubmittedAt: '2026-05-23T16:00:00.000Z',
			liveCorr: 0.0234,
			liveMmc: 0.0111,
			payoutNmr: 1.25
		});
	});

	it('refreshes metrics and merges existing round, submission, and model records', async () => {
		const calls: string[] = [];
		const client = {
			mutations: {
				refreshRoundMetrics: async () => ({
					data: {
						ok: true,
						modelId: 'model-1',
						submissionId: 'submission-1',
						roundNumber: 842,
						roundStatus: 'scored',
						datasetVersion: 'v5.2',
						liveDataUri: 'numerai://rounds/842/live.parquet',
						openAt: '2026-05-21T16:00:00.000Z',
						closeAt: '2026-05-28T16:00:00.000Z',
						staleAfter: '2026-05-29T16:00:00.000Z',
						submissionStatus: 'completed',
						liveCorr: 0.0234,
						liveMmc: 0.0111,
						payoutNmr: 1.25,
						checkedAt: '2026-05-23T16:00:00.000Z',
						notes: 'Refreshed round 842 metrics',
						error: null
					}
				})
			},
			models: {
				RoundDataset: {
					list: async () => ({ data: [{ id: 'round-row-1', roundNumber: 842 }] }),
					update: async (payload: unknown) => {
						calls.push(`round:${JSON.stringify(payload)}`);
						return { data: payload };
					},
					create: async (payload: unknown) => ({ data: payload })
				},
				ModelSubmission: {
					update: async (payload: unknown) => {
						calls.push(`submission:${JSON.stringify(payload)}`);
						return { data: payload };
					}
				},
				ModelRegistryItem: {
					update: async (payload: unknown) => {
						calls.push(`model:${JSON.stringify(payload)}`);
						return { data: payload };
					}
				}
			}
		};

		const refresh = await refreshRoundMetricsForModel(
			{ modelId: 'model-1', submissionId: 'submission-1', roundNumber: 842 },
			client as never
		);

		expect(refresh.result.ok).toBe(true);
		expect(calls).toHaveLength(3);
		expect(calls[0]).toContain('"id":"round-row-1"');
		expect(calls[1]).toContain('"status":"completed"');
		expect(calls[2]).toContain('"liveCorr":0.0234');
	});
});
