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
				secretRef: null,
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
	});
});
