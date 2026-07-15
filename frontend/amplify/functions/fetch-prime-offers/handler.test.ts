import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from './handler';

vi.mock('../prime-intellect', () => ({
	resolvePrimeApiKey: vi.fn(async () => 'test-prime-key'),
}));

const event = {
	arguments: {
		apiKeyRef: '/numeraidashboard/user-1/provider/prime/api-key',
		baseUrl: 'https://api.primeintellect.ai',
		gpuType: 'L40S_48GB',
		gpuCount: 1,
		maxPrice: 1.1,
	},
	identity: { sub: 'user-1', claims: { sub: 'user-1' } },
};

beforeEach(() => {
	vi.restoreAllMocks();
});

describe('fetchPrimeOffers', () => {
	it('returns normalized, price-sorted live offers within the configured cap', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [
						{
							provider: 'crusoecloud',
							cloudId: 'l40s-48gb.1x',
							gpuType: 'L40S_48GB',
							socket: 'PCIe',
							dataCenter: 'us-east1-a',
							country: 'US',
							prices: { onDemand: 1 },
							images: ['cuda_12_6_pytorch_2_7'],
						},
						{
							provider: 'vultr',
							cloudId: 'vultr-l40s',
							gpuType: 'L40S_48GB',
							socket: 'PCIe',
							prices: { onDemand: 1.7 },
						},
					],
				}),
				{ status: 200 }
			)
		);
		const result = await handler(event as never);

		expect(result).toMatchObject({ ok: true, error: null });
		expect(JSON.parse(result.offersJson ?? '[]')).toEqual([
			expect.objectContaining({
				id: 'crusoecloud|l40s-48gb.1x|PCIe|us-east1-a|US',
				providerType: 'crusoecloud',
				priceHr: 1,
			}),
		]);
	});

	it('rejects another user secret reference before calling Prime', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		await expect(
			handler({ ...event, arguments: { ...event.arguments, apiKeyRef: '/numeraidashboard/user-2/provider/prime/api-key' } } as never)
		).rejects.toThrow("outside the authenticated user's secret scope");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
