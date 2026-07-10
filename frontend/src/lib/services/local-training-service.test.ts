import { describe, expect, it } from 'vitest';
import {
	DEFAULT_LOCAL_DAEMON_URL,
	cancelLocalTraining,
	launchLocalTraining,
	localDaemonBaseUrl,
	localLaunchRequest,
	pollLocalTraining
} from './local-training-service';

const daemonOk = {
	ok: true,
	status: 'queued',
	providerJobId: 'local-run-1-123',
	checkedAt: '2026-07-07T00:00:00Z',
	logTail: 'started',
	error: null,
	costUsd: null,
	metricsJson: null,
	artifactUri: null
};

function fakeFetch(body: unknown, capture?: (url: string, init?: RequestInit) => void): typeof fetch {
	return (async (url: string, init?: RequestInit) => {
		capture?.(url, init);
		return { json: async () => body } as Response;
	}) as unknown as typeof fetch;
}

describe('localDaemonBaseUrl', () => {
	it('falls back to the default when baseUrl is empty', () => {
		expect(localDaemonBaseUrl({ baseUrl: null })).toBe(DEFAULT_LOCAL_DAEMON_URL);
	});

	it('uses and trims a configured http base url', () => {
		expect(localDaemonBaseUrl({ baseUrl: 'http://127.0.0.1:9000/' })).toBe('http://127.0.0.1:9000');
	});

	it('ignores a non-http base url', () => {
		expect(localDaemonBaseUrl({ baseUrl: 'not-a-url' })).toBe(DEFAULT_LOCAL_DAEMON_URL);
	});
});

describe('localLaunchRequest', () => {
	it('applies MPS-friendly defaults', () => {
		const req = localLaunchRequest('run-1', null);
		expect(req).toMatchObject({ runId: 'run-1', model_type: 'mlp', feature_set: 'small', neutralization_pct: 25 });
	});

	it('reads overrides from a nested local config (string or object)', () => {
		const req = localLaunchRequest('run-1', JSON.stringify({ local: { model_type: 'tabm', feature_set: 'medium' } }));
		expect(req).toMatchObject({ model_type: 'tabm', feature_set: 'medium' });
	});
});

describe('launch/poll/cancel', () => {
	it('launches with the extracted request body', async () => {
		let sentUrl = '';
		let sentBody: unknown;
		const result = await launchLocalTraining(
			{ runId: 'run-1', provider: { baseUrl: null, credentialsJson: { local: { model_type: 'tabm' } } } },
			fakeFetch(daemonOk, (url, init) => {
				sentUrl = url;
				sentBody = JSON.parse(String(init?.body));
			})
		);
		expect(sentUrl).toBe(`${DEFAULT_LOCAL_DAEMON_URL}/launch`);
		expect(sentBody).toMatchObject({ runId: 'run-1', model_type: 'tabm' });
		expect(result.ok).toBe(true);
		expect(result.providerJobId).toBe('local-run-1-123');
	});

	it('returns queued without a job id when polling before launch completes', async () => {
		const result = await pollLocalTraining(
			{ runId: 'run-1', provider: { baseUrl: null, credentialsJson: null }, providerJobId: null },
			fakeFetch(daemonOk)
		);
		expect(result.status).toBe('queued');
	});

	it('surfaces a friendly failure when the daemon is unreachable', async () => {
		const throwing = (async () => {
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch;
		const result = await cancelLocalTraining(
			{ runId: 'run-1', provider: { baseUrl: null, credentialsJson: null }, providerJobId: 'local-run-1-123' },
			throwing
		);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('daemon.py');
	});
});
