import { describe, expect, it, vi } from 'vitest';
import { handler } from './handler';

const baseEvent = {
	arguments: {
		apiKey: 'test-token',
		apiKeyRef: null,
		baseUrl: 'https://api.primeintellect.ai',
		templateName: 'Numerai worker',
		customTemplateId: 'cm-template',
		dockerImage: 'ghcr.io/example/numerai-worker:latest',
		registryCredentialsId: null,
		gpuType: 'RTX4090_24GB',
		maxPrice: 1.25,
		dryRun: true,
	},
	identity: { sub: 'user-1', claims: { sub: 'user-1' } },
};

describe('syncPrimeTemplate handler', () => {
	it('returns provider config without calling Prime in dry-run mode', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const result = await handler(baseEvent as never);

		expect(result).toMatchObject({
			ok: true,
			status: 'validated',
			templateName: 'Numerai worker',
			customTemplateId: 'cm-template',
			dockerImage: 'ghcr.io/example/numerai-worker:latest',
			error: null,
		});
		expect(result.providerConfigJson).toMatchObject({
			primeIntellect: {
				customTemplateId: 'cm-template',
				gpuType: 'RTX4090_24GB',
				maxPrice: 1.25,
				dryRun: true,
			},
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('checks Docker image access when dry-run is off', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
		const result = await handler({
			...baseEvent,
			arguments: { ...baseEvent.arguments, dryRun: false },
		} as never);

		expect(result.ok).toBe(true);
		expect(result.status).toBe('synced');
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://api.primeintellect.ai/api/v1/template/check-docker-image',
			expect.objectContaining({ method: 'POST' })
		);
		fetchSpy.mockRestore();
	});

	it('rejects an untrusted Prime endpoint before making a request', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		await expect(
			handler({
				...baseEvent,
				arguments: {
					...baseEvent.arguments,
					baseUrl: 'https://attacker.example',
					dryRun: false,
				},
			} as never)
		).rejects.toThrow('https://api.primeintellect.ai');
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('rejects another user stored API key reference', async () => {
		await expect(
			handler({
				...baseEvent,
				arguments: {
					...baseEvent.arguments,
					apiKey: null,
					apiKeyRef: '/numeraidashboard/user-2/provider/key/api-key',
				},
			} as never)
		).rejects.toThrow("outside the authenticated user's secret scope");
	});
});
