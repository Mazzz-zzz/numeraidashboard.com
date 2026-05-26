import { describe, expect, it } from 'vitest';
import { launchTrainingToast, providerConfigForLaunch } from './model-launch-service';

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

	it('builds Prime Intellect providerConfigJson as an object with the selected GPU', () => {
		const config = providerConfigForLaunch(
			{
				providerType: 'prime_intellect',
				credentialsJson: JSON.stringify({ primeIntellect: { dryRun: true } })
			} as never,
			'L40S_48GB'
		);

		expect(config).toEqual({ primeIntellect: { dryRun: true, gpuType: 'L40S_48GB' } });
		expect(typeof config).toBe('object');
	});

	it('builds Modal providerConfigJson with the provider GPU identifier', () => {
		const config = providerConfigForLaunch(
			{
				providerType: 'modal',
				credentialsJson: { modal: { launchUrl: 'https://modal.example/launch' } }
			} as never,
			'L40S'
		);

		expect(config).toEqual({ modal: { launchUrl: 'https://modal.example/launch', gpuType: 'L40S' } });
	});

	it('rejects invalid provider GPU choices before launch submission', () => {
		expect(() =>
			providerConfigForLaunch(
				{
					providerType: 'modal',
					credentialsJson: { modal: { gpuCatalog: ['L40S'] } }
				} as never,
				'A100'
			)
		).toThrow('modal does not support GPU "A100"');
	});
});
