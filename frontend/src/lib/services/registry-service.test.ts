import { describe, expect, it } from 'vitest';
import { registryPayload } from './registry-service';

describe('registry service', () => {
	it('normalizes empty optional model fields to null', () => {
		expect(
			registryPayload({
				name: '  baseline-v4  ',
				stage: 'testing',
				numeraiModelId: '  ',
				parentModelId: '',
				changeSummary: '  '
			})
		).toEqual({
			name: 'baseline-v4',
			stage: 'testing',
			numeraiModelId: null,
			parentModelId: null,
			changeSummary: null
		});
	});
});
