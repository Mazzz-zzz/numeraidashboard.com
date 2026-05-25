import { describe, expect, it } from 'vitest';
import { launchTrainingToast } from './model-launch-service';

describe('model launch service', () => {
	it('uses an error toast for failed launch actions', () => {
		expect(
			launchTrainingToast({
				model: { name: 'Baseline learning_rate=0.012' },
				action: {
					ok: false,
					error: 'Prime Intellect customTemplateId is required for custom_template pods'
				}
			})
		).toEqual({
			message: 'Prime Intellect customTemplateId is required for custom_template pods',
			type: 'error'
		});
	});

	it('uses the training success toast only for successful launch actions', () => {
		expect(
			launchTrainingToast({
				model: { name: 'Baseline learning_rate=0.012' },
				action: {
					ok: true,
					error: null
				}
			})
		).toEqual({
			message: 'Baseline learning_rate=0.012 is training.',
			type: 'success'
		});
	});
});
