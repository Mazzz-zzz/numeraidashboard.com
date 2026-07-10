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

	it('maps Modal launch labels to runner GPU identifiers', () => {
		const selected = selectedGpuForProvider({ providerType: 'modal', credentialsJson: null } as never, 'a100-80gb');

		expect(selected).toEqual({ value: 'a100-80gb', label: 'A100 80GB' });
	});

	it('defaults Modal launches to the inexpensive T4 runner identifier', () => {
		const selected = selectedGpuForProvider({ providerType: 'modal', credentialsJson: null } as never, null);

		expect(selected).toEqual({ value: 't4', label: 'T4' });
	});

	it('rejects stale or unsupported GPU selections before launch payloads are built', () => {
		expect(() =>
			assertProviderGpu(
				{
					providerType: 'modal',
					credentialsJson: { modal: { gpuCatalog: ['t4'] } }
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
