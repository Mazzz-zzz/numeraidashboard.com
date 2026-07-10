import { describe, expect, it } from 'vitest';
import { graphSnapshot, parseSweepValues, sweepCandidates } from './pipeline-service';

describe('pipeline service', () => {
	it('parses bounded comma-separated sweep values', () => {
		expect(parseSweepValues('0.003, 0.005, , 0.008, 0.012', 3)).toEqual([
			'0.003',
			'0.005',
			'0.008'
		]);
	});

	it('names sweep candidates from template, parameter, and values', () => {
		expect(
			sweepCandidates({
				templateName: 'Baseline',
				parameter: 'learning_rate',
				values: ['0.003', '0.005']
			})
		).toEqual([
			{ id: 'learning_rate-1', name: 'Baseline learning_rate=0.003', value: '0.003' },
			{ id: 'learning_rate-2', name: 'Baseline learning_rate=0.005', value: '0.005' }
		]);
	});

	it('captures graph nodes and edges with the active preset', () => {
		const snapshot = graphSnapshot('baseline', [{ id: 'data' }], [{ id: 'data-model' }], 'provider-1');

		expect(snapshot).toEqual({
			version: 1,
			preset: 'baseline',
			providerId: 'provider-1',
			nodes: [{ id: 'data' }],
			edges: [{ id: 'data-model' }]
		});
	});
});
