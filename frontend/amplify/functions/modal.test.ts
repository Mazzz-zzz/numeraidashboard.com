import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchModalTraining } from './modal';

const checkedAt = '2026-07-10T12:00:00.000Z';

const liveInput = {
	runId: 'run-modal',
	providerId: 'provider-modal',
	apiKey: 'token-id',
	apiSecret: 'token-secret',
	checkedAt,
};

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('Modal operator configuration', () => {
	it('fails closed when artifact storage is not configured', async () => {
		vi.stubEnv('MODAL_APP_HOST', 'operator--numerai-worker');
		vi.stubEnv('ML_ARTIFACT_BUCKET', '');
		const fetchFn = vi.fn();

		const result = await launchModalTraining(liveInput, { fetchFn });

		expect(result).toMatchObject({
			ok: false,
			status: 'failed',
			error: 'Modal storage is not configured: set ML_ARTIFACT_BUCKET or provide modal.s3Bucket',
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('fails closed when no Modal endpoint is configured', async () => {
		vi.stubEnv('MODAL_APP_HOST', '');
		vi.stubEnv('ML_ARTIFACT_BUCKET', 'operator-artifacts');
		const fetchFn = vi.fn();

		const result = await launchModalTraining(liveInput, { fetchFn });

		expect(result).toMatchObject({
			ok: false,
			status: 'failed',
			error: 'Modal endpoint is not configured: set MODAL_APP_HOST or provide a Modal base URL',
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('uses app-level environment values for Modal endpoints and storage', async () => {
		vi.stubEnv('MODAL_APP_HOST', 'operator--numerai-worker');
		vi.stubEnv('ML_ARTIFACT_BUCKET', 'operator-artifacts');
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'error' }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'error' }), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ call_id: 'modal-job-123', status: 'queued' }), { status: 200 })
			);

		const result = await launchModalTraining(liveInput, { fetchFn });

		expect(result).toMatchObject({ ok: true, providerJobId: 'modal-job-123' });
		expect(fetchFn).toHaveBeenNthCalledWith(
			1,
			'https://operator--numerai-worker-job-status.modal.run',
			expect.objectContaining({ method: 'POST' })
		);
		expect(fetchFn).toHaveBeenNthCalledWith(
			2,
			'https://operator--numerai-worker-job-cancel.modal.run',
			expect.objectContaining({ method: 'POST' })
		);
		expect(fetchFn).toHaveBeenNthCalledWith(
			3,
			'https://operator--numerai-worker-spawn-training.modal.run',
			expect.objectContaining({ body: expect.stringContaining('"s3_bucket":"operator-artifacts"') })
		);
	});
});
