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

describe('verifyNumeraiAccount handler', () => {
	beforeEach(() => {
		ssmSend.mockReset();
		ssmSend.mockResolvedValue({});
		vi.restoreAllMocks();
	});

	it('authenticates Numerai requests with the tournament token header', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ data: { account: { id: 'account-1' } } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		);

		const result = await handler({
			arguments: {
				publicId: 'PUBLIC_ID',
				secretKey: 'SECRET_KEY',
				secretRef: '/numeraidashboard/demo/numerai/secret-key',
			},
			identity: { sub: 'user-1', claims: { sub: 'user-1' } },
		} as never);

		expect(result.ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://api-tournament.numer.ai/',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Token PUBLIC_ID$SECRET_KEY',
				}),
			})
		);
		expect(ssmSend.mock.calls[0][0].input.Name).toMatch(
			/^\/numeraidashboard\/user-1\/numerai\/[a-f0-9]{24}\/secret-key$/
		);
	});

	it('rejects another user secret reference before reading SSM or calling Numerai', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const result = await handler({
			arguments: {
				publicId: 'PUBLIC_ID',
				secretKey: null,
				secretRef: '/numeraidashboard/user-2/numerai/key/secret-key',
			},
			identity: { sub: 'user-1', claims: { sub: 'user-1' } },
		} as never);

		expect(result).toMatchObject({
			ok: false,
			secretRef: null,
		});
		expect(result.error).toContain("outside the authenticated user's secret scope");
		expect(ssmSend).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
