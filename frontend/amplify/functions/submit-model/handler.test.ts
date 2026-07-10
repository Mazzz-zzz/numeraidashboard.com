import { beforeEach, describe, expect, it, vi } from 'vitest';

const runSubmission = vi.hoisted(() => vi.fn());

vi.mock('./submission-workflow', () => ({ runSubmission }));

import { handler } from './handler';

const identity = { sub: 'user-1', claims: { sub: 'user-1' } };
const baseArguments = {
	modelId: 'model-1',
	providerId: 'provider-1',
	providerType: 'modal',
	numeraiAccountId: 'account-1',
	numeraiModelId: 'numerai-model-1',
	numeraiPublicId: 'public-id',
	numeraiSecretRef: '/numeraidashboard/user-1/numerai/key/secret-key',
	modelArtifactUri: 's3://models/model-1.pkl',
	roundNumber: 842,
	predictionSet: 'live',
	neutralizationPct: 50,
	validationMode: 'schema_range_rank',
	uploadEnabled: true,
	baseUrl: 'https://app-spawn-inference.modal.run',
	providerConfigJson: null,
};

describe('submitModel handler security', () => {
	beforeEach(() => {
		runSubmission.mockReset();
		runSubmission.mockResolvedValue({ ok: true, status: 'queued' });
	});

	it('passes an owned Numerai secret to a trusted inference endpoint', async () => {
		await handler({ arguments: baseArguments, identity } as never);

		expect(runSubmission).toHaveBeenCalledWith(
			expect.objectContaining({
				numeraiSecretRef: '/numeraidashboard/user-1/numerai/key/secret-key',
				baseUrl: 'https://app-spawn-inference.modal.run',
			})
		);
	});

	it('rejects a foreign Numerai secret or embedded attacker endpoint', async () => {
		await expect(
			handler({
				arguments: {
					...baseArguments,
					numeraiSecretRef: '/numeraidashboard/user-2/numerai/key/secret-key',
				},
				identity,
			} as never)
		).rejects.toThrow("outside the authenticated user's secret scope");
		await expect(
			handler({
				arguments: {
					...baseArguments,
					providerConfigJson: {
						modal: { launchUrl: 'https://attacker.example/inference' },
					},
				},
				identity,
			} as never)
		).rejects.toThrow('under *.modal.run');
		expect(runSubmission).not.toHaveBeenCalled();
	});
});
