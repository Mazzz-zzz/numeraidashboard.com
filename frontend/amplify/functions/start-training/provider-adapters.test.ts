import { describe, expect, it } from 'vitest';
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

	it.each(trainingProviderTypes.filter((type) => type !== 'local' && type !== 'prime_intellect'))(
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

	it('fails Prime Intellect launches with missing config instead of throwing', async () => {
		const result = await launchTrainingJob({
			runId: 'run-prime',
			providerId: 'provider-prime',
			providerType: 'prime_intellect',
			apiKey: 'test-token',
			providerConfigJson: null,
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: false,
			status: 'failed',
			error: 'Prime Intellect customTemplateId is required for custom_template pods',
		});
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
