import { describe, expect, it } from 'vitest';
import {
	countActiveWork,
	latestSubmission,
	nextDashboardAction,
	summarizeComputeConnection,
	summarizeNumeraiConnection
} from './dashboard';

describe('dashboard summaries', () => {
	it('prioritizes missing Numerai connection before other dashboard actions', () => {
		const numerai = summarizeNumeraiConnection([]);
		const compute = summarizeComputeConnection([{ status: 'available', verifiedAt: '2026-05-23T00:00:00Z' }]);

		expect(numerai.tone).toBe('bad');
		expect(nextDashboardAction({ numerai, compute, modelCount: 2, activeWorkCount: 0 })).toEqual({
			label: 'Connect Numerai account',
			href: '/settings'
		});
	});

	it('counts active training and compute work statuses', () => {
		expect(
			countActiveWork([
				{ status: 'planned' },
				{ status: 'queued' },
				{ status: 'running' },
				{ status: 'completed' },
				{ status: 'failed' }
			])
		).toBe(3);
	});

	it('keeps active work on the dashboard after removing the Compute tab', () => {
		const numerai = summarizeNumeraiConnection([{ verifiedAt: '2026-05-23T00:00:00Z' }]);
		const compute = summarizeComputeConnection([{ status: 'available', verifiedAt: '2026-05-23T00:00:00Z' }]);

		expect(nextDashboardAction({ numerai, compute, modelCount: 2, activeWorkCount: 1 })).toEqual({
			label: 'Review active work',
			href: '/'
		});
	});

	it('finds latest submission by timestamp before round fallback', () => {
		expect(
			latestSubmission([
				{ name: 'round only', lastSubmittedRound: 999 },
				{ name: 'older', lastSubmittedAt: '2026-05-20T00:00:00Z', lastSubmittedRound: 100 },
				{ name: 'newer', lastSubmittedAt: '2026-05-22T00:00:00Z', lastSubmittedRound: 101 }
			])
		)?.toMatchObject({ name: 'newer' });
	});
});
