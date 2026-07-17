import { describe, expect, it, vi } from 'vitest';
import {
	normalizeTrainingActionStatus,
	readLocalTrainingSnapshot,
	providerTypeArgument,
	serializeAwsJsonArg,
	startTrainingRun,
	terminalActionTimestamp,
	toComputeJobStatus,
	trainingActionSummary,
	trainingRunPatchFromAction
} from './training-service';
import type { ComputeProvider } from './compute-service';

vi.mock('$lib/auth', () => ({ requireAuthSession: vi.fn().mockResolvedValue(undefined) }));

describe('training service', () => {
	it('passes provider type through for function arguments', () => {
		expect(providerTypeArgument({ providerType: 'sagemaker' } as ComputeProvider)).toBe('sagemaker');
		expect(providerTypeArgument({ providerType: null } as ComputeProvider)).toBe('custom');
	});

	it('serializes AWSJSON mutation args for AppSync', () => {
		expect(serializeAwsJsonArg({ modal: { gpuType: 't4', targetCols: ['target_ender_20'] } })).toBe(
			'{"modal":{"gpuType":"t4","targetCols":["target_ender_20"]}}'
		);
		expect(serializeAwsJsonArg(['t4', 'a10g'])).toBe('["t4","a10g"]');
	});

	it('does not double-encode existing AWSJSON strings', () => {
		const encoded = '{"modal":{"gpuType":"t4"}}';
		expect(serializeAwsJsonArg(encoded)).toBe(encoded);
	});

	it('keeps empty AWSJSON mutation args null', () => {
		expect(serializeAwsJsonArg(null)).toBeNull();
		expect(serializeAwsJsonArg(undefined)).toBeNull();
		expect(serializeAwsJsonArg(() => 'not-json')).toBeNull();
	});

	it('summarizes successful and failed function results', () => {
		expect(trainingActionSummary({ ok: true, status: 'queued', error: null })).toBe('Training queued');
		expect(trainingActionSummary({ ok: false, status: 'failed', error: 'missing run' })).toBe(
			'missing run'
		);
	});

	it('normalizes function statuses for compute jobs', () => {
		expect(toComputeJobStatus('running')).toBe('running');
		expect(toComputeJobStatus('succeeded')).toBe('completed');
		expect(toComputeJobStatus('canceled')).toBe('cancelled');
		expect(toComputeJobStatus('provider-specific-pending')).toBe('queued');
	});

	it('normalizes provider statuses for training runs', () => {
		expect(normalizeTrainingActionStatus('pending')).toBe('queued');
		expect(normalizeTrainingActionStatus('success')).toBe('completed');
		expect(normalizeTrainingActionStatus('error')).toBe('failed');
	});

	it('builds training run patches with consistent terminal timestamps and payloads', () => {
		const patch = trainingRunPatchFromAction({
			runId: 'run-1',
			currentStartedAt: '2026-05-23T12:00:00.000Z',
			action: {
				ok: true,
				status: 'completed',
				providerJobId: 'done-job',
				checkedAt: '2026-05-23T13:00:00.000Z',
				logTail: 'completed',
				error: null,
				costUsd: 4.25,
				metricsJson: { validationCorr: 0.02 },
				artifactUri: 's3://artifact/model.pkl'
			}
		});

		expect(patch).toEqual({
			id: 'run-1',
			status: 'completed',
			finishedAt: '2026-05-23T13:00:00.000Z',
			logTail: 'completed',
			costUsd: 4.25,
			metricsJson: { validationCorr: 0.02 },
			artifactUri: 's3://artifact/model.pkl'
		});
		expect(terminalActionTimestamp('completed', '2026-05-23T13:00:00.000Z')).toBe(
			'2026-05-23T13:00:00.000Z'
		);
		expect(terminalActionTimestamp('running', '2026-05-23T13:00:00.000Z')).toBeUndefined();
	});

	it('keeps the original start time when a run continues running', () => {
		const patch = trainingRunPatchFromAction({
			runId: 'run-1',
			currentStartedAt: '2026-05-23T12:00:00.000Z',
			action: {
				ok: true,
				status: 'running',
				providerJobId: 'job-1',
				checkedAt: '2026-05-23T13:00:00.000Z',
				logTail: 'running',
				error: null,
				costUsd: null,
				metricsJson: null,
				artifactUri: null
			}
		});

		expect(patch.startedAt).toBe('2026-05-23T12:00:00.000Z');
		expect(patch.finishedAt).toBeUndefined();
	});

	it('stores provider errors as training run log tails when no log is available', () => {
		const patch = trainingRunPatchFromAction({
			runId: 'run-1',
			action: {
				ok: false,
				status: 'failed',
				providerJobId: null,
				checkedAt: '2026-05-23T13:00:00.000Z',
				logTail: null,
				error: 'No Prime Intellect availability found for L40S_48GBx1',
				costUsd: null,
				metricsJson: null,
				artifactUri: null
			}
		});

		expect(patch).toMatchObject({
			status: 'failed',
			logTail: 'No Prime Intellect availability found for L40S_48GBx1'
		});
	});

	it('queues local launches in cloud without calling a browser daemon or cloud provider mutation', async () => {
		const startTraining = vi.fn();
		const action = await startTrainingRun(
			{
				runId: 'run-local',
				provider: { id: 'provider-local', providerType: 'local' } as ComputeProvider
			},
			{ mutations: { startTraining } } as never
		);

		expect(startTraining).not.toHaveBeenCalled();
		expect(action).toMatchObject({
			ok: true,
			status: 'queued',
			providerJobId: null,
			logTail: 'Run queued for the local training daemon.'
		});
	});

	it('reads local status from daemon-pushed cloud records', async () => {
		const getRun = vi.fn().mockResolvedValue({
			data: {
				id: 'run-local',
				status: 'running',
				logTail: 'epoch 2',
				updatedAt: '2026-07-17T14:30:00.000Z'
			}
		});
		const listJobs = vi.fn().mockResolvedValue({
			data: [
				{
					id: 'job-local',
					runId: 'run-local',
					status: 'running',
					providerJobId: 'local-run-local-1',
					updatedAt: '2026-07-17T14:30:01.000Z'
				}
			]
		});
		const snapshot = await readLocalTrainingSnapshot(
			{ runId: 'run-local', providerJobId: null },
			{
				models: {
					TrainingRun: { get: getRun },
					ComputeJob: { list: listJobs }
				}
			} as never
		);

		expect(getRun).toHaveBeenCalledWith({ id: 'run-local' });
		expect(listJobs).toHaveBeenCalledWith({ filter: { runId: { eq: 'run-local' } }, limit: 20 });
		expect(snapshot.action).toMatchObject({
			ok: true,
			status: 'running',
			providerJobId: 'local-run-local-1',
			logTail: 'epoch 2'
		});
		expect(snapshot.job?.id).toBe('job-local');
	});
});
