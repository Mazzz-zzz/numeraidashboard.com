import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchTrainingJob = vi.hoisted(() => vi.fn());

vi.mock('./provider-adapters', () => ({ launchTrainingJob }));

import { handler } from './handler';

const identity = { sub: 'user-1', claims: { sub: 'user-1' } };
const baseArguments = {
	runId: 'run-1',
	providerId: 'provider-1',
	providerType: 'modal',
	apiKeyRef: '/numeraidashboard/user-1/provider/key/api-key',
	apiSecretRef: '/numeraidashboard/user-1/provider/key/api-secret',
	baseUrl: 'https://app-spawn-training.modal.run',
	workspaceId: null,
	providerConfigJson: null,
};

describe('startTraining handler security', () => {
	beforeEach(() => {
		launchTrainingJob.mockReset();
		launchTrainingJob.mockResolvedValue({ ok: true, status: 'queued' });
	});

	it('passes caller-scoped references to the provider adapter', async () => {
		await handler({ arguments: baseArguments, identity } as never);

		expect(launchTrainingJob).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: 'run-1',
				apiKeyRef: '/numeraidashboard/user-1/provider/key/api-key',
				baseUrl: 'https://app-spawn-training.modal.run',
			})
		);
	});

	it('rejects foreign references and attacker endpoints before provider launch', async () => {
		await expect(
			handler({
				arguments: {
					...baseArguments,
					apiSecretRef: '/numeraidashboard/user-2/provider/key/api-secret',
				},
				identity,
			} as never)
		).rejects.toThrow("outside the authenticated user's secret scope");
		await expect(
			handler({
				arguments: { ...baseArguments, baseUrl: 'https://attacker.example' },
				identity,
			} as never)
		).rejects.toThrow('under *.modal.run');
		expect(launchTrainingJob).not.toHaveBeenCalled();
	});
});
