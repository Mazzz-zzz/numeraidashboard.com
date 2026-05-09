import { writable, get } from 'svelte/store';
import { api, type Alert, type SurfaceData, type Contract } from './api';

// --- Toast Notifications ---
export interface Toast {
	id: number;
	message: string;
	type: 'success' | 'error' | 'info';
}

let toastId = 0;
export const toasts = writable<Toast[]>([]);

export function addToast(message: string, type: Toast['type'] = 'info') {
	const id = ++toastId;
	toasts.update(t => [...t, { id, message, type }]);
	setTimeout(() => {
		toasts.update(t => t.filter(toast => toast.id !== id));
	}, 4000);
}

// --- Global Selected Underlying ---
export const selectedUnderlying = writable<string>('');
export const fetchStatus = writable<{ loading: boolean; result: string | null; error: string | null }>({
	loading: false,
	result: null,
	error: null,
});

/** Select a symbol and load existing data from the DB (no exchange API call). */
export function selectUnderlying(symbol: string) {
	if (!symbol) return;
	selectedUnderlying.set(symbol);
	fetchStatus.set({ loading: false, result: null, error: null });
}

/** Fetch fresh data from the exchange API, then reload. */
export async function fetchUnderlying(symbol: string) {
	if (!symbol) return;
	selectedUnderlying.set(symbol);
	fetchStatus.set({ loading: true, result: null, error: null });
	try {
		const res = await api.fetchChain(symbol);
		const msg = `${res.alerts_raised} alerts / ${res.snapshots} contracts`;
		fetchStatus.set({ loading: false, result: msg, error: null });
		addToast(`${symbol}: ${msg}`, 'success');
		await alerts.refresh();
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Fetch failed';
		fetchStatus.set({ loading: false, result: null, error: msg });
		addToast(`Fetch ${symbol} failed: ${msg}`, 'error');
	}
}

// --- Alerts Store ---
function createAlertStore() {
	const store = writable<{ items: Alert[]; cursor: number | null; hasMore: boolean; loading: boolean }>({
		items: [],
		cursor: null,
		hasMore: true,
		loading: false,
	});

	async function load(reset = false) {
		const state = get(store);
		if (state.loading) return;

		store.update(s => ({ ...s, loading: true }));
		try {
			const cursor = reset ? undefined : state.cursor ?? undefined;
			const res = await api.getAlerts({ cursor, limit: 200 });
			store.update((s) => ({
				items: reset ? res.data : [...s.items, ...res.data],
				cursor: res.next_cursor,
				hasMore: !!res.next_cursor,
				loading: false,
			}));
		} catch {
			store.update(s => ({ ...s, loading: false }));
		}
	}

	async function loadAll() {
		await load(true);
		let state = get(store);
		while (state.hasMore) {
			await load(false);
			state = get(store);
		}
	}

	return {
		subscribe: store.subscribe,
		load,
		loadAll,
		refresh: () => loadAll(),
	};
}

export const alerts = createAlertStore();

// --- Surface Store ---
export const surface = writable<SurfaceData | null>(null);

export async function loadSurface(underlying: string, optionType?: string) {
	const data = await api.getSurface(underlying, optionType);
	surface.set(data);
}

// --- Contracts Store ---
export const contracts = writable<{ items: Contract[]; total: number }>({
	items: [],
	total: 0,
});

export async function loadContracts(params?: { underlying?: string }) {
	const res = await api.getContracts({ ...params, limit: 500 });
	contracts.set({ items: res.data, total: res.total });
}
