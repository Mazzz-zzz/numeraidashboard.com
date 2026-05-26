import type { ComputeProvider } from './compute-service';

export type GpuOption = {
	readonly value: string;
	readonly label: string;
};

type ProviderType = NonNullable<ComputeProvider['providerType']>;

const fallbackGpuCatalogs: Partial<Record<ProviderType, readonly GpuOption[]>> = {
	prime_intellect: [
		{ value: 'L40S_48GB', label: 'L40S 48GB' },
		{ value: 'RTX4090_24GB', label: 'RTX 4090 24GB' },
		{ value: 'A100_40GB', label: 'A100 40GB' },
		{ value: 'A100_80GB', label: 'A100 80GB' },
		{ value: 'H100_80GB', label: 'H100 80GB' }
	],
	modal: [
		{ value: 'L40S', label: 'L40S 48GB' },
		{ value: 'A100', label: 'A100 40GB' },
		{ value: 'A100-80GB', label: 'A100 80GB' },
		{ value: 'H100', label: 'H100 80GB' }
	]
};

export function gpuOptionsForProvider(provider: Pick<ComputeProvider, 'providerType' | 'credentialsJson'> | null | undefined): GpuOption[] {
	if (!provider?.providerType) return [];
	const configured = configuredGpuCatalog(provider.credentialsJson, provider.providerType);
	return configured.length ? configured : [...(fallbackGpuCatalogs[provider.providerType] ?? [])];
}

export function selectedGpuForProvider(
	provider: Pick<ComputeProvider, 'providerType' | 'credentialsJson'> | null | undefined,
	requestedGpu: string | null | undefined
): GpuOption | null {
	const options = gpuOptionsForProvider(provider);
	if (!options.length) return null;
	const requested = requestedGpu?.trim();
	return options.find((gpu) => gpu.value === requested) ?? options[0] ?? null;
}

export function assertProviderGpu(
	provider: Pick<ComputeProvider, 'providerType' | 'credentialsJson'>,
	requestedGpu: string | null | undefined
): string | null {
	const selected = selectedGpuForProvider(provider, requestedGpu);
	if (!selected) return null;
	const validValues = gpuOptionsForProvider(provider).map((gpu) => gpu.value);
	if (requestedGpu?.trim() && !validValues.includes(requestedGpu.trim())) {
		throw new Error(`${provider.providerType ?? 'Provider'} does not support GPU "${requestedGpu.trim()}".`);
	}
	return selected.value;
}

function configuredGpuCatalog(credentialsJson: unknown, providerType: ProviderType): GpuOption[] {
	const root = jsonRecord(credentialsJson) ?? {};
	const nested = jsonRecord(root[providerType]) ?? jsonRecord(root[providerType === 'prime_intellect' ? 'primeIntellect' : providerType]);
	const raw = root.gpuCatalog ?? root.gpus ?? nested?.gpuCatalog ?? nested?.gpus;
	if (!Array.isArray(raw)) return [];
	return raw.map(gpuOptionFromValue).filter((option): option is GpuOption => option !== null);
}

function gpuOptionFromValue(value: unknown): GpuOption | null {
	if (typeof value === 'string' && value.trim()) return { value: value.trim(), label: labelFromGpuValue(value.trim()) };
	const record = jsonRecord(value);
	if (!record) return null;
	const rawValue = stringFrom(record.value) ?? stringFrom(record.id) ?? stringFrom(record.gpuType);
	if (!rawValue) return null;
	return {
		value: rawValue,
		label: stringFrom(record.label) ?? stringFrom(record.name) ?? labelFromGpuValue(rawValue)
	};
}

function labelFromGpuValue(value: string): string {
	return value.replace(/_/g, ' ').replace(/-/g, ' ');
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== 'string') return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function stringFrom(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}
