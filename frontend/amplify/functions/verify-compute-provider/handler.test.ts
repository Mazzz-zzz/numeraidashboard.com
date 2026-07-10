import { beforeEach, describe, expect, it, vi } from 'vitest';

const ssmSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ssm', () => ({
	SSMClient: vi.fn(function SSMClient() {
		return { send: ssmSend };
	}),
	PutParameterCommand: vi.fn(function PutParameterCommand(input) {
		return { input, type: 'PutParameterCommand' };
	}),
	GetParameterCommand: vi.fn(function GetParameterCommand(input) {
		return { input, type: 'GetParameterCommand' };
	}),
}));

import { handler } from './handler';

const identity = { sub: 'user-1', claims: { sub: 'user-1' } };
const baseArguments = {
	providerType: 'prime_intellect',
	apiKey: null,
	apiSecret: null,
	apiKeyRef: '/numeraidashboard/user-1/provider/key/api-key',
	apiSecretRef: null,
	workspaceId: null,
	awsRoleArn: null,
	awsRegion: null,
	baseUrl: 'https://api.primeintellect.ai',
};

describe('verifyComputeProvider handler security', () => {
	beforeEach(() => {
		ssmSend.mockReset();
		vi.restoreAllMocks();
	});

	it('rejects another user API key reference before reading SSM', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		await expect(
			handler({
				arguments: {
					...baseArguments,
					apiKeyRef: '/numeraidashboard/user-2/provider/key/api-key',
				},
				identity,
			} as never)
		).rejects.toThrow("outside the authenticated user's secret scope");
		expect(ssmSend).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects an attacker endpoint before resolving an owned API key', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		await expect(
			handler({
				arguments: { ...baseArguments, baseUrl: 'https://attacker.example' },
				identity,
			} as never)
		).rejects.toThrow('https://api.primeintellect.ai');
		expect(ssmSend).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('stores new credentials only below the caller namespace', async () => {
		ssmSend.mockResolvedValue({});
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('{}', { status: 200 })
		);

		const result = await handler({
			arguments: {
				...baseArguments,
				apiKey: 'pi-test-token',
				apiKeyRef: '/numeraidashboard/demo/provider/api-key',
			},
			identity,
		} as never);

		expect(result.ok).toBe(true);
		expect(ssmSend.mock.calls[0][0].input.Name).toMatch(
			/^\/numeraidashboard\/user-1\/provider\/[a-f0-9]{24}\/api-key$/
		);
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://api.primeintellect.ai/api/v1/pods/?offset=0&limit=1',
			expect.objectContaining({
				headers: { Authorization: 'Bearer pi-test-token' },
			})
		);
	});

	it('fails closed when the caller identity is missing', async () => {
		await expect(
			handler({ arguments: baseArguments } as never)
		).rejects.toThrow('Authenticated caller identity is required');
		expect(ssmSend).not.toHaveBeenCalled();
	});
});
