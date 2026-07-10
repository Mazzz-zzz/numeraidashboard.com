import { beforeEach, describe, expect, it, vi } from 'vitest';

const ssmSend = vi.hoisted(() => vi.fn());
const fetchNumeraiSubmissions = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-ssm', () => ({
	SSMClient: vi.fn(function SSMClient() {
		return { send: ssmSend };
	}),
	GetParameterCommand: vi.fn(function GetParameterCommand(input) {
		return { input, type: 'GetParameterCommand' };
	}),
}));
vi.mock('./numerai-query', () => ({ fetchNumeraiSubmissions }));

import { handler } from './handler';

const identity = { sub: 'user-1', claims: { sub: 'user-1' } };
const baseArguments = {
	publicId: 'public-id',
	secretKey: null,
	secretRef: '/numeraidashboard/user-1/numerai/key/secret-key',
	numeraiModelIds: ['model-1'],
	maxRounds: 30,
};

describe('fetchNumeraiSubmissions handler security', () => {
	beforeEach(() => {
		ssmSend.mockReset();
		fetchNumeraiSubmissions.mockReset();
		fetchNumeraiSubmissions.mockResolvedValue([]);
	});

	it('rejects another user secret reference before reading SSM', async () => {
		const result = await handler({
			arguments: {
				...baseArguments,
				secretRef: '/numeraidashboard/user-2/numerai/key/secret-key',
			},
			identity,
		} as never);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("outside the authenticated user's secret scope");
		expect(ssmSend).not.toHaveBeenCalled();
		expect(fetchNumeraiSubmissions).not.toHaveBeenCalled();
	});

	it('reads an owned secret reference and forwards only the resolved value', async () => {
		ssmSend.mockResolvedValue({ Parameter: { Value: 'resolved-secret' } });

		const result = await handler({ arguments: baseArguments, identity } as never);

		expect(result.ok).toBe(true);
		expect(ssmSend.mock.calls[0][0].input.Name).toBe(
			'/numeraidashboard/user-1/numerai/key/secret-key'
		);
		expect(fetchNumeraiSubmissions).toHaveBeenCalledWith(
			expect.objectContaining({
				publicId: 'public-id',
				secretKey: 'resolved-secret',
			})
		);
	});

	it('ignores a legacy reference when an explicit secret is supplied', async () => {
		const result = await handler({
			arguments: {
				...baseArguments,
				secretKey: 'fresh-secret',
				secretRef: '/numeraidashboard/demo/numerai/secret-key',
			},
			identity,
		} as never);

		expect(result.ok).toBe(true);
		expect(ssmSend).not.toHaveBeenCalled();
		expect(fetchNumeraiSubmissions).toHaveBeenCalledWith(
			expect.objectContaining({ secretKey: 'fresh-secret' })
		);
	});
});
