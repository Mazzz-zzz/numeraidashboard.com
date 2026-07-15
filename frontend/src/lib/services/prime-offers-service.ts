import { requireAuthSession } from '$lib/auth';
import { dataClient } from '$lib/data';
import type { ComputeProvider } from './compute-service';

type Client = ReturnType<typeof dataClient>;

export type PrimeOffer = {
	readonly id: string;
	readonly providerType: string;
	readonly cloudId: string;
	readonly gpuType: string;
	readonly socket: string;
	readonly region: string | null;
	readonly dataCenterId: string | null;
	readonly country: string | null;
	readonly security: string;
	readonly stockStatus: string | null;
	readonly priceHr: number;
	readonly images: readonly string[];
};

export async function fetchPrimeOffers(
	provider: Pick<ComputeProvider, 'apiKeyRef' | 'baseUrl' | 'credentialsJson'>,
	gpuType: string,
	client: Client = dataClient()
): Promise<PrimeOffer[]> {
	await requireAuthSession();
	if (!provider.apiKeyRef) throw new Error('Verify and save the Prime Intellect API key first.');
	const settings = primeSettings(provider.credentialsJson);
	const { data, errors } = await client.queries.fetchPrimeOffers({
		apiKeyRef: provider.apiKeyRef,
		baseUrl: provider.baseUrl ?? null,
		gpuType,
		gpuCount: numberValue(settings.gpuCount) ?? 1,
		maxPrice: numberValue(settings.maxPrice),
	});
	if (errors?.length) throw new Error(errors[0].message);
	if (!data?.ok) throw new Error(data?.error ?? 'Prime Intellect availability could not be loaded.');
	return parseOffers(data.offersJson);
}

export function primeOfferConfig(offer: PrimeOffer): Record<string, unknown> {
	return {
		providerType: offer.providerType,
		cloudId: offer.cloudId,
		socket: offer.socket,
		dataCenterId: offer.dataCenterId,
		country: offer.country,
		security: offer.security,
		maxPrice: offer.priceHr,
	};
}

function parseOffers(value: string | null | undefined): PrimeOffer[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isPrimeOffer);
	} catch {
		return [];
	}
}

function isPrimeOffer(value: unknown): value is PrimeOffer {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === 'string' &&
		typeof row.providerType === 'string' &&
		typeof row.cloudId === 'string' &&
		typeof row.gpuType === 'string' &&
		typeof row.socket === 'string' &&
		typeof row.priceHr === 'number' &&
		Number.isFinite(row.priceHr)
	);
}

function primeSettings(value: unknown): Record<string, unknown> {
	const root = recordValue(value);
	return recordValue(root?.primeIntellect) ?? recordValue(root?.prime_intellect) ?? root ?? {};
}

function recordValue(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== 'string') return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function numberValue(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}
