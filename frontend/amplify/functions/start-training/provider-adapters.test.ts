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
					gpuType: 'L40S',
					gpuCount: 1,
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
				body: expect.stringContaining('"gpu":"L40S"'),
			})
		);
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://modal.example/launch',
			expect.objectContaining({
				body: expect.stringContaining('"run_id":"run-modal"'),
			})
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

	it('launches Prime Intellect direct pods when config is missing', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [
							{
								cloudId: 'cloud-1',
								gpuType: 'L40S_48GB',
								socket: 'PCIe',
								provider: 'runpod',
								prices: { onDemand: 0.5 },
							},
						],
					}),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'pod-123', status: 'PROVISIONING' }), { status: 200 })
			);

		const result = await launchTrainingJob({
			runId: 'run-prime',
			providerId: 'provider-prime',
			providerType: 'prime_intellect',
			apiKey: 'test-token',
			providerConfigJson: null,
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'queued',
			providerJobId: 'pod-123',
			error: null,
		});
		expect(fetchSpy).toHaveBeenNthCalledWith(
			1,
			'https://api.primeintellect.ai/api/v1/availability/gpus?gpu_type=L40S_48GB&gpu_count=1',
			expect.any(Object)
		);
		expect(fetchSpy).toHaveBeenLastCalledWith(
			'https://api.primeintellect.ai/api/v1/pods/',
			expect.objectContaining({
				body: expect.stringContaining('"image":"cuda_12_6_pytorch_2_7"'),
			})
		);
		fetchSpy.mockRestore();
	});

	it('still requires a template id when Prime Intellect custom_template is explicit', async () => {
		const result = await launchTrainingJob({
			runId: 'run-prime',
			providerId: 'provider-prime',
			providerType: 'prime_intellect',
			apiKey: 'test-token',
			providerConfigJson: { primeIntellect: { image: 'custom_template' } },
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: false,
			status: 'failed',
			error: 'Prime Intellect customTemplateId is required for custom_template pods',
		});
	});

	it('skips Prime Intellect offers that are incompatible with direct CUDA images', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [
							{
								cloudId: 'gpu_1x_l40s',
								gpuType: 'L40S_48GB',
								socket: 'PCIe',
								provider: 'massedcompute',
								prices: { onDemand: 0.82 },
							},
							{
								cloudId: 'l40s-48gb.1x',
								gpuType: 'L40S_48GB',
								socket: 'PCIe',
								provider: 'crusoecloud',
								prices: { onDemand: 1 },
							},
						],
					}),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: 'pod-crusoe', status: 'PROVISIONING' }), { status: 200 })
			);

		const result = await launchTrainingJob({
			runId: 'run-prime',
			providerId: 'provider-prime',
			providerType: 'prime_intellect',
			apiKey: 'test-token',
			providerConfigJson: null,
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: true,
			providerJobId: 'pod-crusoe',
		});
		expect(fetchSpy).toHaveBeenLastCalledWith(
			'https://api.primeintellect.ai/api/v1/pods/',
			expect.objectContaining({
				body: expect.stringContaining('"provider":{"type":"crusoecloud"}'),
			})
		);
		expect(fetchSpy).toHaveBeenLastCalledWith(
			'https://api.primeintellect.ai/api/v1/pods/',
			expect.objectContaining({
				body: expect.stringContaining('"cloudId":"l40s-48gb.1x"'),
			})
		);
		fetchSpy.mockRestore();
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
