import { describe, expect, it } from 'vitest';
import {
	normalizeTrainingActionStatus,
	providerTypeArgument,
	terminalActionTimestamp,
	toComputeJobStatus,
	trainingActionSummary,
	trainingRunPatchFromAction
} from './training-service';
import type { ComputeProvider } from './compute-service';

describe('training service', () => {
	it('passes provider type through for function arguments', () => {
		expect(providerTypeArgument({ providerType: 'sagemaker' } as ComputeProvider)).toBe('sagemaker');
		expect(providerTypeArgument({ providerType: null } as ComputeProvider)).toBe('custom');
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
});
