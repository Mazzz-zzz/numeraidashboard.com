import { writable, get } from 'svelte/store';
import {
	api,
	type MlOverview,
	type MlExperimentData,
	type MlModelData,
	type MlRoundData,
	type MlEnsembleData,
	type TrainRequest,
} from './api';

// ── Overview ────────────────────────────────────────────────────────

export const mlOverview = writable<MlOverview | null>(null);

export async function loadMlOverview(tournament?: string) {
	const data = await api.getMlOverview(tournament);
	mlOverview.set(data);
}

// ── Experiments (cursor-paginated) ──────────────────────────────────

function createExperimentStore() {
	const store = writable<{
		items: MlExperimentData[];
		cursor: number | null;
		hasMore: boolean;
		loading: boolean;
	}>({
		items: [],
		cursor: null,
		hasMore: true,
		loading: false,
	});

	let activeTournament: string | undefined;

	async function load(reset = false) {
		const state = get(store);
		if (state.loading) return;

		store.update((s) => ({ ...s, loading: true }));
		try {
			const cursor = reset ? undefined : state.cursor ?? undefined;
			const res = await api.getMlExperiments({ cursor, limit: 20, tournament: activeTournament });
			store.update((s) => ({
				items: reset ? res.data : [...s.items, ...res.data],
				cursor: res.next_cursor,
				hasMore: !!res.next_cursor,
				loading: false,
			}));
		} catch {
			store.update((s) => ({ ...s, loading: false }));
		}
	}

	return {
		subscribe: store.subscribe,
		load,
		refresh: (tournament?: string) => {
			activeTournament = tournament;
			return load(true);
		},
	};
}

export const mlExperiments = createExperimentStore();

// ── Models ──────────────────────────────────────────────────────────

export const mlModels = writable<MlModelData[]>([]);

export async function loadMlModels(tournament?: string) {
	const res = await api.getMlModels(tournament);
	mlModels.set(res.data);
}

// ── Rounds ──────────────────────────────────────────────────────────

export const mlRounds = writable<MlRoundData[]>([]);

export async function loadMlRounds(tournament?: string) {
	const res = await api.getMlRounds(50, tournament);
	mlRounds.set(res.data);
}

// ── Ensemble ────────────────────────────────────────────────────────

export const mlEnsemble = writable<MlEnsembleData | null>(null);

export async function loadMlEnsemble() {
	const res = await api.getMlEnsemble();
	mlEnsemble.set(res.data);
}

// ── Training trigger + polling ──────────────────────────────────────

export const trainingInProgress = writable(false);

let pollInterval: ReturnType<typeof setInterval> | null = null;
let metricsRefreshCallback: (() => Promise<void>) | null = null;
let pollTournament: string | undefined;

/** Register a callback to refresh metrics during polling (called from +page). */
export function setMetricsRefreshCallback(cb: (() => Promise<void>) | null) {
	metricsRefreshCallback = cb;
}

export async function triggerTraining(body: TrainRequest, tournament?: string) {
	const result = await api.triggerTraining(body);
	trainingInProgress.set(true);
	startPolling(tournament);
	return result;
}

export function startPolling(tournament?: string) {
	if (pollInterval) return;
	pollTournament = tournament;
	pollInterval = setInterval(async () => {
		try {
			await loadMlOverview(pollTournament);
			// Refresh metrics for selected run while training is active
			if (metricsRefreshCallback) {
				await metricsRefreshCallback();
			}
			const overview = get(mlOverview);
			if (overview && overview.active_runs === 0) {
				stopPolling();
				trainingInProgress.set(false);
				// Final refresh of metrics
				if (metricsRefreshCallback) {
					await metricsRefreshCallback();
				}
				// Refresh all data when training completes
				await Promise.all([
					mlExperiments.refresh(pollTournament),
					loadMlModels(pollTournament),
				]);
			}
		} catch {
			// Ignore polling errors
		}
	}, 5000);
}

export function stopPolling() {
	if (pollInterval) {
		clearInterval(pollInterval);
		pollInterval = null;
	}
}
