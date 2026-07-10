import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export type TrainingActionResult = {
	readonly ok: boolean;
	readonly status: string;
	readonly providerJobId: string | null;
	readonly checkedAt: string;
	readonly logTail: string | null;
	readonly error: string | null;
	readonly costUsd: number | null;
	readonly metricsJson: Record<string, unknown> | null;
	readonly artifactUri: string | null;
};

export type PrimeProviderInput = {
	readonly apiKey?: string | null;
	readonly apiKeyRef?: string | null;
	readonly baseUrl?: string | null;
	readonly workspaceId?: string | null;
	readonly providerConfigJson?: unknown;
};

export type PrimeLaunchInput = PrimeProviderInput & {
	readonly runId: string;
	readonly providerId: string;
	readonly checkedAt: string;
};

export type PrimeStatusInput = PrimeProviderInput & {
	readonly runId: string;
	readonly providerJobId: string | null;
	readonly checkedAt: string;
};

type FetchFn = typeof fetch;
type SecretResolver = (name: string) => Promise<string>;

type PrimeSettings = {
	readonly dryRun: boolean;
	readonly gpuType: string;
	readonly gpuCount: number;
	readonly image: string;
	readonly customTemplateId: string | null;
	readonly providerType: string | null;
	readonly cloudId: string | null;
	readonly socket: string | null;
	readonly dataCenterId: string | null;
	readonly country: string | null;
	readonly security: string;
	readonly diskSize: number | null;
	readonly maxPrice: number | null;
	readonly sshKeyId: string | null;
	readonly autoRestart: boolean;
	readonly teamId: string | null;
	readonly sharedWithTeam: boolean;
	readonly envVars: Record<string, string>;
};

type AvailabilityOffer = {
	readonly cloudId?: unknown;
	readonly gpuType?: unknown;
	readonly socket?: unknown;
	readonly provider?: unknown;
	readonly dataCenterId?: unknown;
	readonly dataCenter?: unknown;
	readonly country?: unknown;
	readonly security?: unknown;
	readonly prices?: { readonly onDemand?: unknown };
};

type PrimePod = {
	readonly id?: unknown;
	readonly status?: unknown;
	readonly installationStatus?: unknown;
	readonly installationFailure?: unknown;
	readonly installationProgress?: unknown;
	readonly priceHr?: unknown;
	readonly sshConnection?: unknown;
	readonly ip?: unknown;
};

const ssm = new SSMClient({});
const defaultDirectImage = 'cuda_12_6_pytorch_2_7';
const defaultGpuType = 'L40S_48GB';

export async function launchPrimePod(
	input: PrimeLaunchInput,
	deps: { readonly fetchFn?: FetchFn; readonly secretResolver?: SecretResolver } = {}
): Promise<TrainingActionResult> {
	const fetchFn = deps.fetchFn ?? fetch;
	const apiKey = await resolvePrimeApiKey(input, deps.secretResolver);
	if (!apiKey) return failure('Prime Intellect apiKeyRef is required', input.checkedAt, null);

	const settings = primeSettings(input);
	if (!settings.customTemplateId && settings.image === 'custom_template') {
		return failure('Prime Intellect customTemplateId is required for custom_template pods', input.checkedAt, null);
	}

	const envVars = {
		RUN_ID: input.runId,
		PROVIDER_ID: input.providerId,
		NUMERAI_DASHBOARD_JOB: 'true',
		...settings.envVars,
	};

	if (settings.dryRun) {
		return {
			ok: true,
			status: 'queued',
			providerJobId: `prime-dry-run-${input.runId}`,
			checkedAt: input.checkedAt,
			logTail: `Prime Intellect dry run prepared ${settings.gpuType}x${settings.gpuCount} ${settings.image} pod for run ${input.runId}.`,
			error: null,
			costUsd: null,
			metricsJson: { dryRun: true, gpuType: settings.gpuType, gpuCount: settings.gpuCount },
			artifactUri: null,
		};
	}

	let offer: AvailabilityOffer | null;
	let payload: Record<string, unknown>;
	let resp: Response;
	let body: PrimePod | null;
	try {
		offer = await selectOffer(fetchFn, input, settings, apiKey);
		payload = buildCreatePodPayload(input, settings, offer, envVars);
		resp = await primeFetch(fetchFn, input, apiKey, '/api/v1/pods/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		body = (await resp.json().catch(() => null)) as PrimePod | null;
	} catch (e) {
		return failure(e instanceof Error ? e.message : String(e), input.checkedAt, null);
	}
	if (!resp.ok) return failure(`Prime Intellect create pod failed (${resp.status}): ${bodySummary(body)}`, input.checkedAt, null);

	const podId = stringOrNull(body?.id);
	if (!podId) return failure('Prime Intellect create pod returned no pod id', input.checkedAt, null);

	return {
		ok: true,
		status: mapPrimeStatus(stringOrNull(body?.status)),
		providerJobId: podId,
		checkedAt: input.checkedAt,
		logTail: `Prime Intellect pod ${podId} created for run ${input.runId}.`,
		error: null,
		costUsd: null,
		metricsJson: {
			providerStatus: stringOrNull(body?.status),
			installationStatus: stringOrNull(body?.installationStatus),
			installationProgress: numberOrNull(body?.installationProgress),
			priceHr: numberOrNull(body?.priceHr),
		},
		artifactUri: null,
	};
}

export async function pollPrimePod(
	input: PrimeStatusInput,
	deps: { readonly fetchFn?: FetchFn; readonly secretResolver?: SecretResolver } = {}
): Promise<TrainingActionResult> {
	if (!input.providerJobId) return success(input, 'queued', 'Run is queued; no Prime Intellect pod id has been recorded.');
	const settings = primeSettings(input);
	if (settings.dryRun || input.providerJobId.startsWith('prime-dry-run-')) {
		return {
			ok: true,
			status: 'running',
			providerJobId: input.providerJobId,
			checkedAt: input.checkedAt,
			logTail: `Prime Intellect dry run status checked for run ${input.runId}.`,
			error: null,
			costUsd: null,
			metricsJson: { dryRun: true, gpuType: settings.gpuType, gpuCount: settings.gpuCount },
			artifactUri: null,
		};
	}
	const fetchFn = deps.fetchFn ?? fetch;
	const apiKey = await resolvePrimeApiKey(input, deps.secretResolver);
	if (!apiKey) return failure('Prime Intellect apiKeyRef is required', input.checkedAt, input.providerJobId);

	const podResp = await primeFetch(fetchFn, input, apiKey, `/api/v1/pods/${encodeURIComponent(input.providerJobId)}`);
	const pod = (await podResp.json().catch(() => null)) as PrimePod | null;
	if (!podResp.ok) {
		return failure(`Prime Intellect pod poll failed (${podResp.status}): ${bodySummary(pod)}`, input.checkedAt, input.providerJobId);
	}

	const logTail = await getPrimeLogTail(fetchFn, input, apiKey);
	const providerStatus = stringOrNull(pod?.status);
	const status = statusFromPodAndLogs(providerStatus, logTail);
	const artifactUri = parseArtifactUri(logTail);
	const metricsJson = {
		providerStatus,
		installationStatus: stringOrNull(pod?.installationStatus),
		installationFailure: stringOrNull(pod?.installationFailure),
		installationProgress: numberOrNull(pod?.installationProgress),
		priceHr: numberOrNull(pod?.priceHr),
		...parseMetricsJson(logTail),
	};

	return {
		ok: true,
		status,
		providerJobId: input.providerJobId,
		checkedAt: input.checkedAt,
		logTail: logTail || `Prime Intellect pod ${input.providerJobId}: ${providerStatus ?? 'unknown'}.`,
		error: null,
		costUsd: null,
		metricsJson,
		artifactUri,
	};
}

export async function cancelPrimePod(
	input: PrimeStatusInput,
	deps: { readonly fetchFn?: FetchFn; readonly secretResolver?: SecretResolver } = {}
): Promise<TrainingActionResult> {
	if (!input.providerJobId) return success(input, 'cancelled', `Cancelled queued run ${input.runId} before a Prime pod was recorded.`);
	if (primeSettings(input).dryRun || input.providerJobId.startsWith('prime-dry-run-')) {
		return success(input, 'cancelled', `Prime Intellect dry run cancelled for run ${input.runId}.`);
	}
	const fetchFn = deps.fetchFn ?? fetch;
	const apiKey = await resolvePrimeApiKey(input, deps.secretResolver);
	if (!apiKey) return failure('Prime Intellect apiKeyRef is required', input.checkedAt, input.providerJobId);

	const resp = await primeFetch(fetchFn, input, apiKey, `/api/v1/pods/${encodeURIComponent(input.providerJobId)}`, {
		method: 'DELETE',
	});
	const body = (await resp.json().catch(() => null)) as PrimePod | null;
	if (!resp.ok) {
		return failure(`Prime Intellect delete pod failed (${resp.status}): ${bodySummary(body)}`, input.checkedAt, input.providerJobId);
	}
	return success(input, 'cancelled', `Prime Intellect delete requested for pod ${input.providerJobId}.`);
}

export async function resolvePrimeApiKey(
	input: PrimeProviderInput,
	secretResolver: SecretResolver = getSecret
): Promise<string | null> {
	if (input.apiKey?.trim()) return input.apiKey.trim();
	if (!input.apiKeyRef?.trim()) return null;
	return secretResolver(input.apiKeyRef.trim());
}

function primeSettings(input: PrimeProviderInput): PrimeSettings {
	const raw = settingsRecord(input.providerConfigJson);
	const gpuCount = numberFrom(raw.gpuCount) ?? 1;
	const customTemplateId = stringFrom(raw.customTemplateId);
	return {
		dryRun: raw.dryRun === true,
		gpuType: stringFrom(raw.gpuType) ?? defaultGpuType,
		gpuCount,
		image: stringFrom(raw.image) ?? stringFrom(raw.environmentType) ?? (customTemplateId ? 'custom_template' : defaultDirectImage),
		customTemplateId,
		providerType: stringFrom(raw.providerType),
		cloudId: stringFrom(raw.cloudId),
		socket: stringFrom(raw.socket),
		dataCenterId: stringFrom(raw.dataCenterId) ?? stringFrom(raw.dataCenter),
		country: stringFrom(raw.country),
		security: stringFrom(raw.security) ?? 'secure_cloud',
		diskSize: numberFrom(raw.diskSize),
		maxPrice: numberFrom(raw.maxPrice),
		sshKeyId: stringFrom(raw.sshKeyId),
		autoRestart: raw.autoRestart === true,
		teamId: stringFrom(raw.teamId) ?? input.workspaceId?.trim() ?? null,
		sharedWithTeam: raw.sharedWithTeam === true,
		envVars: envVarsFrom(raw.envVars),
	};
}

function settingsRecord(value: unknown): Record<string, unknown> {
	const root = asRecord(value);
	if (!root) return {};
	const nested = asRecord(root.primeIntellect) ?? asRecord(root.prime_intellect);
	return nested ?? root;
}

async function selectOffer(
	fetchFn: FetchFn,
	input: PrimeProviderInput,
	settings: PrimeSettings,
	apiKey: string
): Promise<AvailabilityOffer | null> {
	if (settings.cloudId && settings.socket && settings.providerType) return null;
	const params = new URLSearchParams({
		gpu_type: settings.gpuType,
		gpu_count: String(settings.gpuCount),
	});
	const resp = await primeFetch(fetchFn, input, apiKey, `/api/v1/availability/gpus?${params.toString()}`);
	const body = (await resp.json().catch(() => null)) as { readonly items?: AvailabilityOffer[] } | null;
	if (!resp.ok) throw new Error(`Prime Intellect availability failed (${resp.status}): ${bodySummary(body)}`);

	const availableOffers = body?.items ?? [];
	const offers = availableOffers
		.filter((offer) => compatibleOfferForImage(offer, settings.image))
		.filter((offer) => settings.maxPrice === null || (numberOrNull(offer.prices?.onDemand) ?? Infinity) <= settings.maxPrice)
		.sort((a, b) => (numberOrNull(a.prices?.onDemand) ?? Infinity) - (numberOrNull(b.prices?.onDemand) ?? Infinity));
	if (!offers.length && availableOffers.length) {
		throw new Error(`No Prime Intellect availability compatible with ${settings.image} for ${settings.gpuType}x${settings.gpuCount}`);
	}
	if (!offers.length) throw new Error(`No Prime Intellect availability found for ${settings.gpuType}x${settings.gpuCount}`);
	return offers[0];
}

function compatibleOfferForImage(offer: AvailabilityOffer, image: string): boolean {
	const provider = stringFrom(offer.provider)?.toLowerCase();
	if (isDirectCudaImage(image) && provider === 'massedcompute') return false;
	return true;
}

function isDirectCudaImage(image: string): boolean {
	const normalized = image.toLowerCase();
	return normalized === 'ubuntu_22_cuda_12' || normalized.startsWith('cuda_');
}

function buildCreatePodPayload(
	input: PrimeLaunchInput,
	settings: PrimeSettings,
	offer: AvailabilityOffer | null,
	envVars: Record<string, string>
): Record<string, unknown> {
	const cloudId = settings.cloudId ?? stringFrom(offer?.cloudId);
	const socket = settings.socket ?? stringFrom(offer?.socket);
	const providerType = settings.providerType ?? stringFrom(offer?.provider);
	if (!cloudId || !socket || !providerType) {
		throw new Error('Prime Intellect pod creation needs cloudId, socket, and providerType from config or availability.');
	}

	const pod: Record<string, unknown> = {
		name: podName(input.runId),
		cloudId,
		gpuType: settings.gpuType,
		socket,
		gpuCount: settings.gpuCount,
		image: settings.image,
		security: settings.security,
		envVars: Object.entries(envVars).map(([key, value]) => ({ key, value })),
		autoRestart: settings.autoRestart,
	};
	const customTemplateId = settings.customTemplateId;
	if (customTemplateId) pod.customTemplateId = customTemplateId;
	const dataCenterId = settings.dataCenterId ?? stringFrom(offer?.dataCenterId) ?? stringFrom(offer?.dataCenter);
	if (dataCenterId) pod.dataCenterId = dataCenterId;
	const country = settings.country ?? stringFrom(offer?.country);
	if (country) pod.country = country;
	if (settings.diskSize !== null) pod.diskSize = settings.diskSize;
	if (settings.maxPrice !== null) pod.maxPrice = settings.maxPrice;
	if (settings.sshKeyId) pod.sshKeyId = settings.sshKeyId;

	const payload: Record<string, unknown> = {
		pod,
		provider: { type: providerType },
		shared_with_team: settings.sharedWithTeam,
	};
	if (settings.teamId) payload.team = { teamId: settings.teamId };
	return payload;
}

async function primeFetch(
	fetchFn: FetchFn,
	input: PrimeProviderInput,
	apiKey: string,
	path: string,
	init: RequestInit = {}
): Promise<Response> {
	const baseUrl = (input.baseUrl ?? '').replace(/\/$/, '') || 'https://api.primeintellect.ai';
	return fetchFn(`${baseUrl}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...init.headers,
		},
	});
}

async function getPrimeLogTail(fetchFn: FetchFn, input: PrimeStatusInput, apiKey: string): Promise<string | null> {
	if (!input.providerJobId) return null;
	const resp = await primeFetch(fetchFn, input, apiKey, `/api/v1/pods/${encodeURIComponent(input.providerJobId)}/log?tail=80`);
	if (!resp.ok) return null;
	const body = await resp.text();
	return body.trim() || null;
}

function statusFromPodAndLogs(providerStatus: string | null, logTail: string | null): string {
	if (logTail && /NUMERAI_DASHBOARD_TRAINING_COMPLETED|TRAINING_COMPLETE/i.test(logTail)) return 'completed';
	if (logTail && /NUMERAI_DASHBOARD_TRAINING_FAILED|TRAINING_FAILED/i.test(logTail)) return 'failed';
	return mapPrimeStatus(providerStatus);
}

function mapPrimeStatus(status: string | null): string {
	switch (status) {
		case 'PROVISIONING':
		case 'PENDING':
			return 'queued';
		case 'ACTIVE':
			return 'running';
		case 'ERROR':
		case 'UNKNOWN':
			return 'failed';
		case 'STOPPED':
		case 'DELETING':
		case 'TERMINATED':
			return 'cancelled';
		default:
			return 'queued';
	}
}

function parseArtifactUri(logTail: string | null): string | null {
	return /NUMERAI_ARTIFACT_URI=([^\s]+)/.exec(logTail ?? '')?.[1] ?? null;
}

function parseMetricsJson(logTail: string | null): Record<string, unknown> {
	const match = /NUMERAI_METRICS_JSON=(\{.*\})/.exec(logTail ?? '');
	if (!match) return {};
	try {
		const parsed = JSON.parse(match[1]);
		return asRecord(parsed) ?? {};
	} catch {
		return {};
	}
}

function bodySummary(body: unknown): string {
	if (!body) return 'empty response';
	return JSON.stringify(body).slice(0, 500);
}

function podName(runId: string): string {
	return `numerai-${runId}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60);
}

function success(input: PrimeStatusInput, status: string, logTail: string): TrainingActionResult {
	return {
		ok: true,
		status,
		providerJobId: input.providerJobId,
		checkedAt: input.checkedAt,
		logTail,
		error: null,
		costUsd: null,
		metricsJson: null,
		artifactUri: null,
	};
}

function failure(error: string, checkedAt: string, providerJobId: string | null): TrainingActionResult {
	return {
		ok: false,
		status: 'failed',
		providerJobId,
		checkedAt,
		logTail: null,
		error,
		costUsd: null,
		metricsJson: null,
		artifactUri: null,
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringFrom(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function numberFrom(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function envVarsFrom(value: unknown): Record<string, string> {
	const record = asRecord(value);
	if (!record) return {};
	return Object.fromEntries(
		Object.entries(record)
			.filter((entry): entry is [string, string] => typeof entry[1] === 'string')
			.map(([key, val]) => [key, val])
	);
}

async function getSecret(name: string): Promise<string> {
	const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
	if (!result.Parameter?.Value) throw new Error(`Secret reference not found: ${name}`);
	return result.Parameter.Value;
}
