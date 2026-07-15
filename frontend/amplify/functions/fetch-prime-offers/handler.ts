import type { Schema } from '../../data/resource';
import { ownedSecretRef, requireCallerSub, trustedProviderUrl } from '../workflow-security';
import { resolvePrimeApiKey } from '../prime-intellect';

type RawOffer = {
	readonly cloudId?: unknown;
	readonly gpuType?: unknown;
	readonly socket?: unknown;
	readonly provider?: unknown;
	readonly region?: unknown;
	readonly dataCenterId?: unknown;
	readonly dataCenter?: unknown;
	readonly country?: unknown;
	readonly security?: unknown;
	readonly stockStatus?: unknown;
	readonly prices?: { readonly onDemand?: unknown };
	readonly images?: unknown;
};

export const handler: Schema['fetchPrimeOffers']['functionHandler'] = async (event) => {
	const checkedAt = new Date().toISOString();
	const owner = requireCallerSub(event);
	const apiKeyRef = ownedSecretRef(event.arguments.apiKeyRef, owner, 'Prime Intellect API key reference');
	const baseUrl = trustedProviderUrl(event.arguments.baseUrl, 'prime_intellect', 'Prime Intellect base URL');
	const gpuType = event.arguments.gpuType.trim();
	const gpuCount = event.arguments.gpuCount ?? 1;
	const maxPrice = event.arguments.maxPrice;

	if (!apiKeyRef) return failure('Prime Intellect API key reference is required', checkedAt);
	if (!/^[A-Z0-9_]+$/i.test(gpuType)) return failure('Invalid Prime Intellect GPU type', checkedAt);
	if (!Number.isInteger(gpuCount) || gpuCount < 1 || gpuCount > 8) {
		return failure('GPU count must be between 1 and 8', checkedAt);
	}

	try {
		const apiKey = await resolvePrimeApiKey({ apiKeyRef });
		if (!apiKey) return failure('Prime Intellect API key is required', checkedAt);
		const params = new URLSearchParams({
			gpu_type: gpuType,
			gpu_count: String(gpuCount),
			page: '1',
			page_size: '100',
		});
		const response = await fetch(`${baseUrl ?? 'https://api.primeintellect.ai'}/api/v1/availability/gpus?${params}`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		const body = (await response.json().catch(() => null)) as { readonly items?: RawOffer[] } | null;
		if (!response.ok) {
			return failure(`Prime Intellect availability responded ${response.status}`, checkedAt);
		}
		const offers = (body?.items ?? [])
			.map(normalizeOffer)
			.filter((offer): offer is NonNullable<ReturnType<typeof normalizeOffer>> => offer !== null)
			.filter((offer) => maxPrice == null || offer.priceHr <= maxPrice)
			.sort((left, right) => left.priceHr - right.priceHr);

		return {
			ok: true,
			checkedAt,
			error: null,
			offersJson: JSON.stringify(offers),
		};
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error), checkedAt);
	}
};

function normalizeOffer(offer: RawOffer) {
	const providerType = stringValue(offer.provider);
	const cloudId = stringValue(offer.cloudId);
	const gpuType = stringValue(offer.gpuType);
	const socket = stringValue(offer.socket);
	const priceHr = numberValue(offer.prices?.onDemand);
	if (!providerType || !cloudId || !gpuType || !socket || priceHr === null) return null;
	const dataCenterId = stringValue(offer.dataCenterId) ?? stringValue(offer.dataCenter);
	const country = stringValue(offer.country);
	return {
		id: [providerType, cloudId, socket, dataCenterId ?? '', country ?? ''].join('|'),
		providerType,
		cloudId,
		gpuType,
		socket,
		region: stringValue(offer.region),
		dataCenterId,
		country,
		security: stringValue(offer.security) ?? 'secure_cloud',
		stockStatus: stringValue(offer.stockStatus),
		priceHr,
		images: Array.isArray(offer.images) ? offer.images.filter((image): image is string => typeof image === 'string') : [],
	};
}

function failure(error: string, checkedAt: string) {
	return { ok: false, checkedAt, error, offersJson: null };
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
