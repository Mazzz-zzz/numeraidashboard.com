import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
	readonly maxRuntimeMinutes: number;
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
	readonly createdAt?: unknown;
};

const ssm = new SSMClient({});
const s3 = new S3Client({});
const defaultGpuType = 'L40S_48GB';
const defaultMaxRuntimeMinutes = 180;

export async function launchPrimePod(
	input: PrimeLaunchInput,
	deps: { readonly fetchFn?: FetchFn; readonly secretResolver?: SecretResolver } = {}
): Promise<TrainingActionResult> {
	const fetchFn = deps.fetchFn ?? fetch;
	const apiKey = await resolvePrimeApiKey(input, deps.secretResolver);
	if (!apiKey) return failure('Prime Intellect apiKeyRef is required', input.checkedAt, null);

	const settings = primeSettings(input);
	if (!settings.customTemplateId) {
		return failure(
			'Prime Intellect managed worker template is not configured. Set PRIME_DEFAULT_TEMPLATE_ID or add a custom template ID in provider settings.',
			input.checkedAt,
			null
		);
	}

	const baseEnvVars = {
		...settings.envVars,
		RUN_ID: input.runId,
		PROVIDER_ID: input.providerId,
		NUMERAI_DASHBOARD_JOB: 'true',
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

	let payload: Record<string, unknown>;
	let resp: Response;
	let body: PrimePod | null;
	try {
		const envVars = { ...baseEnvVars, ...(await primeArtifactUpload(input.runId)) };
		payload = buildCreatePodPayload(input, settings, envVars);
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
	const createdAt = dateOrNull(pod?.createdAt);
	const priceHr = numberOrNull(pod?.priceHr);
	const elapsedHours = createdAt ? Math.max(0, (Date.parse(input.checkedAt) - createdAt.getTime()) / 3_600_000) : null;
	const timedOut = elapsedHours !== null && elapsedHours * 60 >= settings.maxRuntimeMinutes;
	if (timedOut && status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
		const terminated = await deletePrimePod(fetchFn, input, apiKey);
		if (!terminated) {
			return {
				ok: true,
				status: 'running',
				providerJobId: input.providerJobId,
				checkedAt: input.checkedAt,
				logTail: `${logTail ?? ''}\nRuntime limit reached; pod cleanup will be retried on the next status check.`.trim(),
				error: null,
				costUsd: elapsedHours !== null && priceHr !== null ? elapsedHours * priceHr : null,
				metricsJson: { providerStatus, cleanupPending: true, timedOut: true },
				artifactUri,
			};
		}
		return {
			ok: false,
			status: 'failed',
			providerJobId: input.providerJobId,
			checkedAt: input.checkedAt,
			logTail: logTail ?? `Prime Intellect pod exceeded its ${settings.maxRuntimeMinutes} minute runtime limit and was terminated.`,
			error: `Prime Intellect training exceeded its ${settings.maxRuntimeMinutes} minute runtime limit.`,
			costUsd: elapsedHours !== null && priceHr !== null ? elapsedHours * priceHr : null,
			metricsJson: { providerStatus, timedOut: true, maxRuntimeMinutes: settings.maxRuntimeMinutes },
			artifactUri,
		};
	}
	if (status === 'completed' || status === 'failed') {
		const terminated = await deletePrimePod(fetchFn, input, apiKey);
		if (!terminated) {
			return {
				ok: true,
				status: 'running',
				providerJobId: input.providerJobId,
				checkedAt: input.checkedAt,
				logTail: `${logTail ?? ''}\nTraining ended; pod cleanup will be retried on the next status check.`.trim(),
				error: null,
				costUsd: elapsedHours !== null && priceHr !== null ? elapsedHours * priceHr : null,
				metricsJson: { providerStatus, cleanupPending: true, trainingStatus: status },
				artifactUri,
			};
		}
	}
	const metricsJson = {
		providerStatus,
		installationStatus: stringOrNull(pod?.installationStatus),
		installationFailure: stringOrNull(pod?.installationFailure),
		installationProgress: numberOrNull(pod?.installationProgress),
		priceHr,
		...parseMetricsJson(logTail),
	};

	return {
		ok: true,
		status,
		providerJobId: input.providerJobId,
		checkedAt: input.checkedAt,
		logTail: logTail || `Prime Intellect pod ${input.providerJobId}: ${providerStatus ?? 'unknown'}.`,
		error: null,
		costUsd: elapsedHours !== null && priceHr !== null ? elapsedHours * priceHr : null,
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
	const gpuCount = Math.min(8, Math.max(1, Math.trunc(numberFrom(raw.gpuCount) ?? 1)));
	const maxRuntimeMinutes = Math.min(1_440, Math.max(5, numberFrom(raw.maxRuntimeMinutes) ?? defaultMaxRuntimeMinutes));
	const customTemplateId = stringFrom(raw.customTemplateId) ?? stringFrom(process.env.PRIME_DEFAULT_TEMPLATE_ID);
	return {
		dryRun: raw.dryRun === true,
		gpuType: stringFrom(raw.gpuType) ?? defaultGpuType,
		gpuCount,
		image: 'custom_template',
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
		autoRestart: false,
		teamId: stringFrom(raw.teamId) ?? input.workspaceId?.trim() ?? null,
		sharedWithTeam: raw.sharedWithTeam === true,
		envVars: envVarsFrom(raw.envVars),
		maxRuntimeMinutes,
	};
}

function settingsRecord(value: unknown): Record<string, unknown> {
	const root = asRecord(value);
	if (!root) return {};
	const nested = asRecord(root.primeIntellect) ?? asRecord(root.prime_intellect);
	return nested ?? root;
}

function buildCreatePodPayload(
	input: PrimeLaunchInput,
	settings: PrimeSettings,
	envVars: Record<string, string>
): Record<string, unknown> {
	const cloudId = settings.cloudId;
	const socket = settings.socket;
	const providerType = settings.providerType;
	if (!cloudId || !socket || !providerType) {
		throw new Error('Select an available Prime Intellect GPU offer before launching.');
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
	const dataCenterId = settings.dataCenterId;
	if (dataCenterId) pod.dataCenterId = dataCenterId;
	const country = settings.country;
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

async function deletePrimePod(fetchFn: FetchFn, input: PrimeStatusInput, apiKey: string): Promise<boolean> {
	if (!input.providerJobId) return true;
	try {
		const response = await primeFetch(fetchFn, input, apiKey, `/api/v1/pods/${encodeURIComponent(input.providerJobId)}`, { method: 'DELETE' });
		return response.ok || response.status === 404;
	} catch {
		return false;
	}
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

function dateOrNull(value: unknown): Date | null {
	if (typeof value !== 'string') return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
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

async function primeArtifactUpload(runId: string): Promise<Record<string, string>> {
	const bucket = stringFrom(process.env.ML_ARTIFACT_BUCKET);
	if (!bucket) return {};
	const key = `prime/${runId.replace(/[^a-zA-Z0-9._-]/g, '-')}/model.tar.gz`;
	const uploadUrl = await getSignedUrl(
		s3,
		new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'application/gzip' }),
		{ expiresIn: 26 * 60 * 60 }
	);
	return {
		NUMERAI_ARTIFACT_UPLOAD_URL: uploadUrl,
		NUMERAI_ARTIFACT_URI: `s3://${bucket}/${key}`,
	};
}
