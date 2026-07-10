import { describe, expect, it } from 'vitest';
import { computeJobRows, formatCurrency, providerCards } from './compute-service';
import type { ComputeJob, ComputeProvider } from './compute-service';

const modalProvider = {
	id: 'provider-1',
	name: 'Modal',
	providerType: 'modal',
	status: 'available',
	verifiedAt: '2026-05-23T00:00:00.000Z',
	monthlyBudgetUsd: 250,
	defaultRunCapUsd: 18,
	maxConcurrentJobs: 4
} as ComputeProvider;

describe('compute service', () => {
	it('maps provider records into display cards', () => {
		expect(providerCards([modalProvider])).toEqual([
			{
				id: 'provider-1',
				name: 'Modal',
				status: 'available',
				type: 'serverless GPU',
				body: 'Verified and available for queued training workloads.',
				monthlyBudgetUsd: 250,
				defaultRunCapUsd: 18,
				maxConcurrentJobs: 4
			}
		]);
	});

	it('formats unset and decimal currency values', () => {
		expect(formatCurrency(null)).toBe('unset');
		expect(formatCurrency(18)).toBe('$18');
		expect(formatCurrency(3.8)).toBe('$3.80');
	});

	it('marks cancellable and retryable compute jobs', () => {
		const jobs = [
			{ id: 'job-1', name: 'queued run', providerId: 'provider-1', status: 'queued' },
			{ id: 'job-2', name: 'failed run', providerId: 'provider-1', status: 'failed' }
		] as ComputeJob[];

		expect(computeJobRows(jobs, [modalProvider])).toMatchObject([
			{
				id: 'job-1',
				provider: 'Modal',
				status: 'queued',
				canCancel: true,
				canRetry: false
			},
			{
				id: 'job-2',
				provider: 'Modal',
				status: 'failed',
				canCancel: false,
				canRetry: true
			}
		]);
	});
});
