import { describe, expect, it, vi } from 'vitest';
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
			providerType: 'sagemaker',
			providerJobId: 'sagemaker-completed-123',
			checkedAt,
		});

		expect(result.status).toBe('completed');
		expect(result.providerJobId).toBe('sagemaker-completed-123');
		expect(result.metricsJson).toEqual({ providerStatus: 'completed', checkedAt });
	});

	it('keeps Modal jobs queued when status polling gets a 404 empty response', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));

		const result = await pollTrainingJob({
			runId: 'run-1',
			providerType: 'modal',
			providerJobId: 'modal-job-123',
			apiKey: 'ak-test',
			apiSecret: 'as-test',
			providerConfigJson: { modal: { statusUrl: 'https://modal.example/status/{jobId}' } },
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'queued',
			providerJobId: 'modal-job-123',
			error: null,
		});
		expect(result.logTail).toContain('404 empty response');
		expect(fetchSpy).toHaveBeenCalledWith('https://modal.example/status/modal-job-123', expect.any(Object));
		fetchSpy.mockRestore();
	});

	it('polls Modal status endpoints into completed pipeline state', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					status: 'succeeded',
					logTail: 'NUMERAI_DASHBOARD_TRAINING_COMPLETED',
					artifactUri: 's3://models/run-1.pkl',
					metricsJson: { validationCorr: 0.02 },
				}),
				{ status: 200 }
			)
		);

		const result = await pollTrainingJob({
			runId: 'run-1',
			providerType: 'modal',
			providerJobId: 'modal-job-123',
			apiKey: 'ak-test',
			apiSecret: 'as-test',
			providerConfigJson: { modal: { statusUrl: 'https://modal.example/status/{jobId}' } },
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'completed',
			providerJobId: 'modal-job-123',
			artifactUri: 's3://models/run-1.pkl',
			metricsJson: { validationCorr: 0.02 },
		});
		fetchSpy.mockRestore();
	});

	it('keeps cancelled Modal calls distinct from failed training', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ status: 'cancelled', error: 'Function call was cancelled' }), { status: 200 })
		);

		const result = await pollTrainingJob({
			runId: 'run-1',
			providerType: 'modal',
			providerJobId: 'modal-job-123',
			apiKey: 'ak-test',
			apiSecret: 'as-test',
			providerConfigJson: { modal: { statusUrl: 'https://modal.example/status/{jobId}' } },
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'cancelled',
			providerJobId: 'modal-job-123',
			error: 'Function call was cancelled',
		});
		fetchSpy.mockRestore();
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
				providerType: 'sagemaker',
				providerJobId: 'sagemaker-job-1',
				checkedAt,
			})
		).toMatchObject({ ok: true, status: 'cancelled', providerJobId: 'sagemaker-job-1' });
	});

	it('polls and cancels Modal dry-run jobs without a live spawn call', async () => {
		const providerConfigJson = { modal: { dryRun: true } };

		await expect(
			pollTrainingJob({
				runId: 'run-modal',
				providerType: 'modal',
				providerJobId: 'modal-dry-run-numerai-run-modal-abcdef12',
				providerConfigJson,
				checkedAt,
			})
		).resolves.toMatchObject({
			ok: true,
			status: 'running',
			providerJobId: 'modal-dry-run-numerai-run-modal-abcdef12',
		});

		await expect(
			cancelTrainingJob({
				runId: 'run-modal',
				providerType: 'modal',
				providerJobId: 'modal-dry-run-numerai-run-modal-abcdef12',
				providerConfigJson,
				checkedAt,
			})
		).resolves.toMatchObject({
			ok: true,
			status: 'cancelled',
			providerJobId: 'modal-dry-run-numerai-run-modal-abcdef12',
		});
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
