import { describe, expect, it, vi } from 'vitest';
import {
	launchTrainingJob,
	normalizeTrainingProviderType,
	trainingProviderTypes,
} from './provider-adapters';

const checkedAt = '2026-05-23T15:30:00.000Z';

describe('training provider adapters', () => {
	it('normalizes provider types from function arguments', () => {
		expect(normalizeTrainingProviderType(' SageMaker ')).toBe('sagemaker');
		expect(normalizeTrainingProviderType('prime_intellect')).toBe('prime_intellect');
		expect(normalizeTrainingProviderType('unknown-cloud')).toBeNull();
		expect(normalizeTrainingProviderType(null)).toBeNull();
	});

	it('launches deterministic local demo jobs', async () => {
		const first = await launchTrainingJob({
			runId: 'run-123',
			providerId: 'provider-local',
			providerType: 'local',
			checkedAt,
		});
		const second = await launchTrainingJob({
			runId: 'run-123',
			providerId: 'provider-local',
			providerType: 'local',
			checkedAt,
		});

		expect(first).toMatchObject({
			ok: true,
			status: 'queued',
			checkedAt,
			error: null,
		});
		expect(first.providerJobId).toBe(second.providerJobId);
		expect(first.providerJobId).toMatch(/^local-[a-f0-9]{16}$/);
		expect(first.logTail).toContain('Local/demo runner accepted run run-123');
	});

	it.each(trainingProviderTypes.filter((type) => type !== 'local' && type !== 'prime_intellect' && type !== 'modal'))(
		'launches known %s providers through the adapter contract',
		async (providerType) => {
			const result = await launchTrainingJob({
				runId: 'run-abc',
				providerId: `provider-${providerType}`,
				providerType,
				checkedAt,
			});

			expect(result.ok).toBe(true);
			expect(result.status).toBe('queued');
			expect(result.providerJobId).toMatch(new RegExp(`^${providerType}-[a-f0-9]{16}$`));
			expect(result.logTail).toContain('accepted run run-abc');
			expect(result.error).toBeNull();
		}
	);

	it('prepares Modal training launches with explicit dry-run config', async () => {
		const result = await launchTrainingJob({
			runId: 'run-modal',
			providerId: 'provider-modal',
			providerType: 'modal',
			providerConfigJson: {
				modal: { dryRun: true, gpu: 'h100' },
			},
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'queued',
			error: null,
		});
		expect(result.providerJobId).toMatch(/^modal-dry-run-/);
		expect(result.logTail).toContain('Modal dry run prepared h100');
	});

	it('launches Modal jobs through the configured provider endpoint with selected GPU config', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ call_id: 'modal-job-123', status: 'queued' }), { status: 200 })
		);

		const result = await launchTrainingJob({
			runId: 'run-modal',
			providerId: 'provider-modal',
			providerType: 'modal',
			apiKey: 'ak-test',
			apiSecret: 'as-test',
			providerConfigJson: {
				modal: {
					launchUrl: 'https://modal.example/launch',
					s3Bucket: 'test-artifacts',
					gpuType: 't4',
					gpuCount: 1,
					hyperparams: {
						feature_set: 'small',
						target_cols: ['target_ender_20'],
					},
				},
			},
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'queued',
			providerJobId: 'modal-job-123',
			error: null,
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://modal.example/launch',
			expect.objectContaining({
				method: 'POST',
				body: expect.stringContaining('"gpu":"t4"'),
			})
		);
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://modal.example/launch',
			expect.objectContaining({
				body: expect.stringContaining('"run_id":"run-modal"'),
			})
		);
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://modal.example/launch',
			expect.objectContaining({
				body: expect.stringContaining('"target_cols":["target_ender_20"]'),
			})
		);
		fetchSpy.mockRestore();
	});

	it('fails Modal launch before spawn when required control endpoints are stale', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));

		const result = await launchTrainingJob({
			runId: 'run-modal',
			providerId: 'provider-modal',
			providerType: 'modal',
			apiKey: 'ak-test',
			apiSecret: 'as-test',
			baseUrl: 'https://operator--numerai-worker-spawn-training.modal.run',
			providerConfigJson: { modal: { gpuType: 't4', s3Bucket: 'test-artifacts' } },
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: false,
			status: 'failed',
			providerJobId: null,
			error: 'Modal endpoint job-status is missing. Redeploy ml/sagemaker/modal_runner.py before launching training.',
		});
		expect(fetchSpy).toHaveBeenCalledOnce();
		fetchSpy.mockRestore();
	});

	it('preflights status and cancel endpoints derived from explicit Modal spawn URLs', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'error', detail: 'Unknown call_id' }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'error', detail: 'Unknown call_id' }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ call_id: 'modal-job-456', status: 'queued' }), { status: 200 }));

		const result = await launchTrainingJob({
			runId: 'run-modal',
			providerId: 'provider-modal',
			providerType: 'modal',
			apiKey: 'ak-test',
			apiSecret: 'as-test',
			providerConfigJson: {
				modal: {
					launchUrl: 'https://operator--numerai-worker-spawn-training.modal.run',
					s3Bucket: 'test-artifacts',
					gpuType: 't4',
				},
			},
			checkedAt,
		});

		expect(result).toMatchObject({ ok: true, providerJobId: 'modal-job-456' });
		expect(fetchSpy).toHaveBeenNthCalledWith(
			1,
			'https://operator--numerai-worker-job-status.modal.run',
			expect.objectContaining({ method: 'POST' })
		);
		expect(fetchSpy).toHaveBeenNthCalledWith(
			2,
			'https://operator--numerai-worker-job-cancel.modal.run',
			expect.objectContaining({ method: 'POST' })
		);
		expect(fetchSpy).toHaveBeenNthCalledWith(
			3,
			'https://operator--numerai-worker-spawn-training.modal.run',
			expect.objectContaining({ method: 'POST' })
		);
		fetchSpy.mockRestore();
	});

	it('prepares Prime Intellect compute pod launches with explicit dry-run config', async () => {
		const result = await launchTrainingJob({
			runId: 'run-prime',
			providerId: 'provider-prime',
			providerType: 'prime_intellect',
			apiKey: 'test-token',
			providerConfigJson: {
				primeIntellect: {
					dryRun: true,
					customTemplateId: 'template-123',
					gpuType: 'RTX4090_24GB',
				},
			},
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'queued',
			providerJobId: 'prime-dry-run-run-prime',
			error: null,
		});
		expect(result.logTail).toContain('Prime Intellect dry run prepared');
	});

	it('fails Prime Intellect launches without a stored API key reference', async () => {
		const result = await launchTrainingJob({
			runId: 'run-prime',
			providerId: 'provider-prime',
			providerType: 'prime_intellect',
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: false,
			status: 'failed',
			error: 'Prime Intellect apiKeyRef is required',
		});
	});

	it('launches the managed Prime worker on the exact selected live offer', async () => {
		vi.stubEnv('PRIME_DEFAULT_TEMPLATE_ID', 'managed-template-123');
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 'pod-123', status: 'PROVISIONING' }), { status: 200 })
		);

		const result = await launchTrainingJob({
			runId: 'run-prime',
			providerId: 'provider-prime',
			providerType: 'prime_intellect',
			apiKey: 'test-token',
			providerConfigJson: {
				primeIntellect: {
					gpuType: 'L40S_48GB',
					cloudId: 'l40s-48gb.1x',
					socket: 'PCIe',
					providerType: 'crusoecloud',
					dataCenterId: 'us-east',
					country: 'US',
					envVars: { NUMERAI_RUN_CONFIG_JSON: '{"feature_set":"small"}' },
				},
			},
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'queued',
			providerJobId: 'pod-123',
			error: null,
		});
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://api.primeintellect.ai/api/v1/pods/',
			expect.objectContaining({
				body: expect.stringContaining('"customTemplateId":"managed-template-123"'),
			})
		);
		expect(fetchSpy.mock.calls[0]?.[1]?.body).toContain('"provider":{"type":"crusoecloud"}');
		expect(fetchSpy.mock.calls[0]?.[1]?.body).toContain('"NUMERAI_RUN_CONFIG_JSON"');
		fetchSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	it('requires the operator default or a user custom template', async () => {
		const result = await launchTrainingJob({
			runId: 'run-prime',
			providerId: 'provider-prime',
			providerType: 'prime_intellect',
			apiKey: 'test-token',
			providerConfigJson: {
				primeIntellect: { cloudId: 'cloud-1', socket: 'PCIe', providerType: 'runpod' },
			},
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: false,
			status: 'failed',
			error: 'Prime Intellect managed worker template is not configured. Set PRIME_DEFAULT_TEMPLATE_ID or add a custom template ID in provider settings.',
		});
	});

	it('refuses to guess a Prime offer in the launch adapter', async () => {
		vi.stubEnv('PRIME_DEFAULT_TEMPLATE_ID', 'managed-template-123');
		const result = await launchTrainingJob({
			runId: 'run-prime',
			providerId: 'provider-prime',
			providerType: 'prime_intellect',
			apiKey: 'test-token',
			providerConfigJson: { primeIntellect: { gpuType: 'L40S_48GB' } },
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: false,
			providerJobId: null,
			error: 'Select an available Prime Intellect GPU offer before launching.',
		});
		vi.unstubAllEnvs();
	});

	it('fails unsupported provider types with the supported list', async () => {
		const result = await launchTrainingJob({
			runId: 'run-abc',
			providerId: 'provider-abc',
			providerType: 'legacy-fastapi',
			checkedAt,
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe('failed');
		expect(result.providerJobId).toBeNull();
		expect(result.error).toContain('Unsupported training provider type "legacy-fastapi"');
		expect(result.error).toContain('prime_intellect, modal, sagemaker, local, custom');
	});

	it('validates required launch identifiers before selecting an adapter', async () => {
		expect(
			await launchTrainingJob({
				runId: '',
				providerId: 'provider-abc',
				providerType: 'local',
				checkedAt,
			})
		).toMatchObject({ ok: false, status: 'failed', error: 'runId is required' });
		expect(
			await launchTrainingJob({
				runId: 'run-abc',
				providerId: '  ',
				providerType: 'local',
				checkedAt,
			})
		).toMatchObject({ ok: false, status: 'failed', error: 'providerId is required' });
	});
});
