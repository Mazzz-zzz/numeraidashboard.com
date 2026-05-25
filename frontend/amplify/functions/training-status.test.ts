import { describe, expect, it } from 'vitest';
import { cancelTrainingJob, pollTrainingJob, statusFromProviderJobId } from './training-status';

const checkedAt = '2026-05-23T15:45:00.000Z';

describe('training function status transitions', () => {
	it('classifies provider job ids into normalized statuses', () => {
		expect(statusFromProviderJobId(null)).toBe('queued');
		expect(statusFromProviderJobId('modal-job-123')).toBe('running');
		expect(statusFromProviderJobId('sagemaker-completed-123')).toBe('completed');
		expect(statusFromProviderJobId('prime-failed-123')).toBe('failed');
		expect(statusFromProviderJobId('local-canceled-123')).toBe('cancelled');
	});

	it('returns a queued poll result when a provider job id has not been recorded', async () => {
		const result = await pollTrainingJob({
			runId: 'run-1',
			providerType: 'local',
			providerJobId: null,
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'queued',
			providerJobId: null,
			checkedAt,
			error: null,
			costUsd: null,
			metricsJson: null,
			artifactUri: null,
		});
		expect(result.logTail).toContain('still queued');
	});

	it('returns terminal poll results with metrics payloads for completed jobs', async () => {
		const result = await pollTrainingJob({
			runId: 'run-1',
			providerType: 'modal',
			providerJobId: 'modal-completed-123',
			checkedAt,
		});

		expect(result.status).toBe('completed');
		expect(result.providerJobId).toBe('modal-completed-123');
		expect(result.metricsJson).toEqual({ providerStatus: 'completed', checkedAt });
	});

	it('cancels queued and provider-backed jobs consistently', async () => {
		expect(
			await cancelTrainingJob({
				runId: 'run-1',
				providerType: 'local',
				providerJobId: null,
				checkedAt,
			})
		).toMatchObject({ ok: true, status: 'cancelled', providerJobId: null });
		expect(
			await cancelTrainingJob({
				runId: 'run-1',
				providerType: 'modal',
				providerJobId: 'modal-job-1',
				checkedAt,
			})
		).toMatchObject({ ok: true, status: 'cancelled', providerJobId: 'modal-job-1' });
	});

	it('polls and cancels Prime dry-run jobs without a live pod API call', async () => {
		const providerConfigJson = {
			primeIntellect: {
				dryRun: true,
				gpuType: 'RTX4090_24GB',
			},
		};

		await expect(
			pollTrainingJob({
				runId: 'run-prime',
				providerType: 'prime_intellect',
				providerJobId: 'prime-dry-run-run-prime',
				providerConfigJson,
				checkedAt,
			})
		).resolves.toMatchObject({
			ok: true,
			status: 'running',
			providerJobId: 'prime-dry-run-run-prime',
			metricsJson: { dryRun: true, gpuType: 'RTX4090_24GB', gpuCount: 1 },
		});

		await expect(
			cancelTrainingJob({
				runId: 'run-prime',
				providerType: 'prime_intellect',
				providerJobId: 'prime-dry-run-run-prime',
				providerConfigJson,
				checkedAt,
			})
		).resolves.toMatchObject({
			ok: true,
			status: 'cancelled',
			providerJobId: 'prime-dry-run-run-prime',
		});
	});

	it('validates required identifiers before returning state transitions', async () => {
		expect(
			await pollTrainingJob({
				runId: '',
				providerType: 'modal',
				providerJobId: 'modal-job-1',
				checkedAt,
			})
		).toMatchObject({ ok: false, status: 'failed', error: 'runId is required' });
		expect(
			await cancelTrainingJob({
				runId: 'run-1',
				providerType: '',
				providerJobId: 'modal-job-1',
				checkedAt,
			})
		).toMatchObject({ ok: false, status: 'failed', error: 'providerType is required' });
	});
});
