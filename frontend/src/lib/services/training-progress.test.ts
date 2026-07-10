import { describe, expect, it } from 'vitest';
import { parseTrainingLogLines, trainingProgressForJob } from './training-progress';

describe('training progress helpers', () => {
	it('parses Prime Intellect structured log payloads into readable lines', () => {
		const lines = parseTrainingLogLines(
			JSON.stringify({
				logs: [
					{ timestamp: '2026-05-26 10:57:34', level: 'INFO', log: 'CUDA Version 12.6.3' },
					{ timestamp: '2026-05-26 10:57:35', level: 'INFO', log: 'Start script(s) finished, pod is ready to use.' }
				]
			})
		);

		expect(lines).toEqual([
			{ timestamp: '2026-05-26 10:57:34', level: 'INFO', message: 'CUDA Version 12.6.3' },
			{ timestamp: '2026-05-26 10:57:35', level: 'INFO', message: 'Start script(s) finished, pod is ready to use.' }
		]);
	});

	it('uses provider progress_pct payloads when available', () => {
		const progress = trainingProgressForJob({
			status: 'running',
			startedAt: '2026-05-26T10:00:00.000Z',
			finishedAt: null,
			providerJobId: 'modal-1',
			logTail: JSON.stringify({ progress: { step: 'feature_engineering', progress_pct: 15 } })
		} as never);

		expect(progress).toMatchObject({
			percent: 15,
			label: 'Feature Engineering',
			source: 'provider'
		});
	});

	it('estimates running jobs from elapsed time when providers only expose status', () => {
		const progress = trainingProgressForJob(
			{
				status: 'running',
				startedAt: '2026-05-26T10:00:00.000Z',
				finishedAt: null,
				providerJobId: 'modal-1',
				logTail: 'Modal call modal-1 status=running.'
			} as never,
			new Date('2026-05-26T10:45:00.000Z')
		);

		expect(progress.percent).toBe(53);
		expect(progress.etaLabel).toBe('~45m left');
		expect(progress.source).toBe('elapsed');
	});

	it('marks completed jobs as complete even when no progress payload is present', () => {
		const progress = trainingProgressForJob({
			status: 'completed',
			startedAt: '2026-05-26T10:00:00.000Z',
			finishedAt: '2026-05-26T11:00:00.000Z',
			providerJobId: 'modal-1',
			logTail: 'done'
		} as never);

		expect(progress.percent).toBe(100);
		expect(progress.etaLabel).toContain('complete');
	});
});
