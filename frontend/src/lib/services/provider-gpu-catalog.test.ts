import { describe, expect, it } from 'vitest';
import { assertProviderGpu, gpuOptionsForProvider, selectedGpuForProvider } from './provider-gpu-catalog';

describe('provider GPU catalog', () => {
	it('uses configured Prime Intellect GPU catalog entries before fallbacks', () => {
		const options = gpuOptionsForProvider({
			providerType: 'prime_intellect',
			credentialsJson: { primeIntellect: { gpuCatalog: [{ value: 'H100_80GB', label: 'H100 SXM 80GB' }] } }
		} as never);

		expect(options).toEqual([{ value: 'H100_80GB', label: 'H100 SXM 80GB' }]);
	});

	it('maps Modal L40S launch labels to provider GPU identifiers', () => {
		const selected = selectedGpuForProvider({ providerType: 'modal', credentialsJson: null } as never, 'L40S');

		expect(selected).toEqual({ value: 'L40S', label: 'L40S 48GB' });
	});

	it('rejects stale or unsupported GPU selections before launch payloads are built', () => {
		expect(() =>
			assertProviderGpu(
				{
					providerType: 'modal',
					credentialsJson: { modal: { gpuCatalog: ['L40S'] } }
				} as never,
				'A10G'
			)
		).toThrow('modal does not support GPU "A10G"');
	});

	it('falls back deterministically when no provider catalog is configured', () => {
		expect(gpuOptionsForProvider({ providerType: 'prime_intellect', credentialsJson: null } as never)).toContainEqual({
			value: 'L40S_48GB',
			label: 'L40S 48GB'
		});
		expect(gpuOptionsForProvider({ providerType: 'custom', credentialsJson: null } as never)).toEqual([]);
	});
});
