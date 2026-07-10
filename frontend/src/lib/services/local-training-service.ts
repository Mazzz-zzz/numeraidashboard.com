/**
 * Client adapter for the **local** compute provider.
 *
 * The `startTraining` Amplify Lambda runs in AWS and cannot reach the user's
 * machine, so local runs are driven straight from the browser to a small
 * daemon (`ml/local/daemon.py`, auto-started by the Vite dev server and
 * proxied same-origin at `/local-daemon`). The daemon
 * returns payloads already shaped like {@link TrainingActionResult}, so the
 * rest of the launch/poll/cancel flow is unchanged.
 *
 * This path only works in local dev (a deployed https origin cannot call a
 * plaintext http://127.0.0.1 endpoint), which is exactly where "local"
 * compute is meaningful.
 */
import type { ComputeProvider } from './compute-service';
import type { TrainingActionResult } from './training-service';

// Same-origin path proxied to the daemon by the Vite dev server (see
// frontend/vite.config.ts). Avoids CORS and hard-coded ports in dev. A
// provider with an explicit http(s) baseUrl (a standalone daemon) overrides it.
export const DEFAULT_LOCAL_DAEMON_URL = '/local-daemon';

export type LocalTrainingInput = {
	readonly runId: string;
	readonly provider: Pick<ComputeProvider, 'baseUrl' | 'credentialsJson'>;
	readonly providerJobId?: string | null;
	readonly providerConfigJson?: unknown;
};

export type LocalDaemonHealth = {
	readonly ok: boolean;
	readonly device?: string;
	readonly chip?: string;
	readonly torch?: string;
	readonly running?: number;
	readonly queued?: number;
	readonly maxParallel?: number;
	readonly cap?: number;
	readonly allocatedMb?: number;
	readonly driverMb?: number;
	readonly recommendedMaxMb?: number;
};

/** Set how many local training jobs may run concurrently. Returns the clamped value, or null on failure. */
export async function setLocalDaemonMaxParallel(
	maxParallel: number,
	provider?: Pick<ComputeProvider, 'baseUrl'> | null,
	fetchFn: typeof fetch = fetch
): Promise<number | null> {
	const base = localDaemonBaseUrl({ baseUrl: provider?.baseUrl ?? null });
	try {
		const resp = await fetchFn(`${base}/config`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ maxParallel })
		});
		const body = (await resp.json()) as { ok?: boolean; maxParallel?: number };
		return body?.ok ? (body.maxParallel ?? null) : null;
	} catch {
		return null;
	}
}

/**
 * Ping the local daemon's /health. Returns null if it isn't running (so the UI
 * can simply hide the local GPU strip).
 */
export async function fetchLocalDaemonHealth(
	provider?: Pick<ComputeProvider, 'baseUrl'> | null,
	fetchFn: typeof fetch = fetch
): Promise<LocalDaemonHealth | null> {
	const base = localDaemonBaseUrl({ baseUrl: provider?.baseUrl ?? null });
	try {
		const resp = await fetchFn(`${base}/health`);
		if (!resp.ok) return null;
		const body = (await resp.json()) as LocalDaemonHealth;
		return body?.ok ? body : null;
	} catch {
		return null;
	}
}

export function localDaemonBaseUrl(provider: Pick<ComputeProvider, 'baseUrl'>): string {
	const raw = provider.baseUrl?.trim();
	const url = raw && /^https?:\/\//i.test(raw) ? raw : DEFAULT_LOCAL_DAEMON_URL;
	return url.replace(/\/$/, '');
}

/** Extract the training request the daemon needs from the launch config. */
export function localLaunchRequest(runId: string, config: unknown): Record<string, unknown> {
	const root = asRecord(config) ?? {};
	const local = asRecord(root.local) ?? root;
	return {
		runId,
		model_type: str(local.model_type) ?? str(local.modelType) ?? 'mlp',
		feature_set: str(local.feature_set) ?? str(local.featureSet) ?? 'small',
		neutralization_pct: num(local.neutralization_pct) ?? num(local.neutralizationPct) ?? 25,
		hyperparams: asRecord(local.hyperparams) ?? {},
		upload: local.upload === true
	};
}

export async function launchLocalTraining(
	input: LocalTrainingInput,
	fetchFn: typeof fetch = fetch
): Promise<TrainingActionResult> {
	const body = localLaunchRequest(input.runId, input.providerConfigJson ?? input.provider.credentialsJson);
	return post(localDaemonBaseUrl(input.provider), '/launch', body, fetchFn);
}

export async function pollLocalTraining(
	input: LocalTrainingInput,
	fetchFn: typeof fetch = fetch
): Promise<TrainingActionResult> {
	const base = localDaemonBaseUrl(input.provider);
	if (!input.providerJobId) {
		return failure('Local job id not recorded yet; run still queued.', input.providerJobId ?? null, 'queued');
	}
	return get(base, `/status?jobId=${encodeURIComponent(input.providerJobId)}`, input.providerJobId, fetchFn);
}

export async function cancelLocalTraining(
	input: LocalTrainingInput,
	fetchFn: typeof fetch = fetch
): Promise<TrainingActionResult> {
	const base = localDaemonBaseUrl(input.provider);
	return post(base, '/cancel', { jobId: input.providerJobId }, fetchFn, input.providerJobId ?? null);
}

// ---------------------------------------------------------------------------
// HTTP helpers — never throw; a daemon that isn't running surfaces as a
// friendly failed TrainingActionResult in the UI.
// ---------------------------------------------------------------------------

async function post(
	base: string,
	path: string,
	body: unknown,
	fetchFn: typeof fetch,
	providerJobId: string | null = null
): Promise<TrainingActionResult> {
	try {
		const resp = await fetchFn(`${base}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		return normalizeResponse(await resp.json(), providerJobId);
	} catch (e) {
		return daemonUnreachable(e, providerJobId);
	}
}

async function get(
	base: string,
	path: string,
	providerJobId: string | null,
	fetchFn: typeof fetch
): Promise<TrainingActionResult> {
	try {
		const resp = await fetchFn(`${base}${path}`);
		return normalizeResponse(await resp.json(), providerJobId);
	} catch (e) {
		return daemonUnreachable(e, providerJobId);
	}
}

function normalizeResponse(raw: unknown, providerJobId: string | null): TrainingActionResult {
	const r = asRecord(raw) ?? {};
	return {
		ok: r.ok === true,
		status: str(r.status) ?? 'failed',
		providerJobId: str(r.providerJobId) ?? providerJobId,
		checkedAt: str(r.checkedAt) ?? new Date().toISOString(),
		logTail: str(r.logTail) ?? null,
		error: str(r.error) ?? null,
		costUsd: num(r.costUsd) ?? null,
		metricsJson: asRecord(r.metricsJson) ?? null,
		artifactUri: str(r.artifactUri) ?? null
	} as TrainingActionResult;
}

function daemonUnreachable(e: unknown, providerJobId: string | null): TrainingActionResult {
	const detail = e instanceof Error ? e.message : String(e);
	return failure(
		`Local training daemon unreachable — it should start automatically with "npm run dev", ` +
			`or run it directly: "cd ml && python3 local/daemon.py" (${detail}).`,
		providerJobId,
		'failed'
	);
}

function failure(error: string, providerJobId: string | null, status: string): TrainingActionResult {
	return {
		ok: false,
		status,
		providerJobId,
		checkedAt: new Date().toISOString(),
		logTail: null,
		error,
		costUsd: null,
		metricsJson: null,
		artifactUri: null
	} as TrainingActionResult;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== 'string') return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}
