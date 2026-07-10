import { describe, expect, it } from 'vitest';
import { DEFAULT_MODAL_SMOKE_HYPERPARAMS, launchTrainingToast, providerConfigForLaunch } from './model-launch-service';

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
			't4'
		);

		expect(config).toEqual({
			modal: {
				launchUrl: 'https://modal.example/launch',
				hyperparams: DEFAULT_MODAL_SMOKE_HYPERPARAMS,
				gpuType: 't4'
			}
		});
	});

	it('preserves configured Modal smoke hyperparam overrides and array payloads', () => {
		const config = providerConfigForLaunch(
			{
				providerType: 'modal',
				credentialsJson: {
					modal: {
						hyperparams: {
							num_rounds: 25,
							target_cols: ['target_jerome_20']
						}
					}
				}
			} as never,
			'a10g'
		);

		expect(config).toMatchObject({
			modal: {
				hyperparams: {
					...DEFAULT_MODAL_SMOKE_HYPERPARAMS,
					num_rounds: 25,
					target_cols: ['target_jerome_20']
				},
				gpuType: 'a10g'
			}
		});
	});

	it('rejects invalid provider GPU choices before launch submission', () => {
		expect(() =>
			providerConfigForLaunch(
				{
					providerType: 'modal',
					credentialsJson: { modal: { gpuCatalog: ['t4'] } }
				} as never,
				'A100'
			)
		).toThrow('modal does not support GPU "A100"');
	});
});
