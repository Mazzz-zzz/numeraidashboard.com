import { describe, expect, it } from 'vitest';
import { refreshRoundMetricsSnapshot } from './round-metrics';

const checkedAt = '2026-05-23T16:30:00.000Z';

describe('round metrics refresh function', () => {
	it('returns deterministic scored round data for a model submission', () => {
		const first = refreshRoundMetricsSnapshot({
			modelId: 'model-1',
			submissionId: 'submission-1',
			roundNumber: 842,
			checkedAt,
		});
		const second = refreshRoundMetricsSnapshot({
			modelId: 'model-1',
			submissionId: 'submission-1',
			roundNumber: 842,
			checkedAt,
		});

		expect(first).toEqual(second);
		expect(first).toMatchObject({
			ok: true,
			modelId: 'model-1',
			submissionId: 'submission-1',
			roundNumber: 842,
			roundStatus: 'scored',
			submissionStatus: 'completed',
			datasetVersion: 'v5.2',
			liveDataUri: 'numerai://rounds/842/live.parquet',
			checkedAt,
			error: null,
		});
		expect(first.liveCorr).toBeGreaterThan(0);
		expect(first.payoutNmr).toBeGreaterThanOrEqual(0);
	});

	it('validates required model and round identifiers', () => {
		expect(
			refreshRoundMetricsSnapshot({ modelId: '', submissionId: 'submission-1', roundNumber: 842, checkedAt })
		).toMatchObject({ ok: false, error: 'modelId is required' });
		expect(
			refreshRoundMetricsSnapshot({ modelId: 'model-1', submissionId: 'submission-1', roundNumber: null, checkedAt })
		).toMatchObject({ ok: false, error: 'roundNumber is required' });
		expect(
			refreshRoundMetricsSnapshot({ modelId: 'model-1', submissionId: 'submission-1', roundNumber: 0, checkedAt })
		).toMatchObject({ ok: false, error: 'roundNumber must be a positive integer' });
	});
});
