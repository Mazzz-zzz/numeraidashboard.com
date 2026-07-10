import { createHash } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export type ModalActionResult = {
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

export type ModalProviderInput = {
	readonly apiKey?: string | null;
	readonly apiSecret?: string | null;
	readonly apiKeyRef?: string | null;
	readonly apiSecretRef?: string | null;
	readonly baseUrl?: string | null;
	readonly workspaceId?: string | null;
	readonly providerConfigJson?: unknown;
};

export type ModalTrainingLaunchInput = ModalProviderInput & {
	readonly runId: string;
	readonly providerId: string;
	readonly checkedAt: string;
};

export type ModalInferenceLaunchInput = ModalProviderInput & {
	readonly jobName: string;
	readonly modelArtifactUri: string;
	readonly numeraiPublicId: string;
	readonly numeraiSecretKey: string;
	readonly numeraiModelId: string;
	readonly checkedAt: string;
};

export type ModalStatusInput = ModalProviderInput & {
	readonly runId?: string;
	readonly providerJobId: string | null;
	readonly checkedAt: string;
};

type FetchFn = typeof fetch;
type SecretResolver = (name: string) => Promise<string>;

type ModalSettings = {
	readonly dryRun: boolean;
	readonly appHost: string | null;
	readonly s3Bucket: string | null;
	readonly gpu: string;
	readonly gpuCount: number;
	readonly launchUrl: string | null;
	readonly statusUrl: string | null;
	readonly cancelUrl: string | null;
	readonly hyperparams: Record<string, unknown>;
	readonly envVars: Record<string, string>;
};

type ModalCredentials = {
	readonly tokenId: string;
	readonly tokenSecret: string;
};

type ModalSpawnResponse = {
	readonly status?: unknown;
	readonly call_id?: unknown;
	readonly jobId?: unknown;
	readonly id?: unknown;
	readonly callId?: unknown;
	readonly functionCallId?: unknown;
	readonly detail?: unknown;
};

type ModalStatusResponse = {
	readonly status?: unknown;
	readonly error?: unknown;
	readonly detail?: unknown;
	readonly result?: unknown;
	readonly logTail?: unknown;
	readonly logs?: unknown;
	readonly artifactUri?: unknown;
	readonly artifact_uri?: unknown;
	readonly costUsd?: unknown;
	readonly metricsJson?: unknown;
};

const ssm = new SSMClient({});

const MODAL_HEALTHCHECK_CALL_ID = 'numeraidashboard-healthcheck';

export async function launchModalTraining(
	input: ModalTrainingLaunchInput,
	deps: { readonly fetchFn?: FetchFn; readonly secretResolver?: SecretResolver } = {}
): Promise<ModalActionResult> {
	const fetchFn = deps.fetchFn ?? fetch;
	const settings = modalSettings(input);

	const jobName = trainingJobName(input.runId);
	if (settings.dryRun) {
		return {
			ok: true,
			status: 'queued',
			providerJobId: `modal-dry-run-${jobName}`,
			checkedAt: input.checkedAt,
			logTail: `Modal dry run prepared ${settings.gpu} job ${jobName} for run ${input.runId}.`,
			error: null,
			costUsd: null,
			metricsJson: { dryRun: true, gpu: settings.gpu, gpuType: settings.gpu, gpuCount: settings.gpuCount },
			artifactUri: null,
		};
	}

	try {
		const s3Bucket = requireModalSetting(settings.s3Bucket, 'ML_ARTIFACT_BUCKET');
		const payload = {
			gpu: settings.gpu,
			gpu_type: settings.gpu,
			gpu_count: settings.gpuCount,
			job_name: jobName,
			hyperparams: { ...settings.hyperparams, run_id: input.runId, provider_id: input.providerId },
			env_vars: {
				RUN_ID: input.runId,
				PROVIDER_ID: input.providerId,
				NUMERAI_DASHBOARD_JOB: 'true',
				...settings.envVars,
			},
			s3_bucket: s3Bucket,
		};
		const url = settings.launchUrl ?? modalEndpoint(settings.appHost, 'spawn-training', input.baseUrl);
		const credentials = await resolveModalCredentials(input, deps.secretResolver);
		const healthBaseUrl = modalHealthBaseUrl(settings.launchUrl, input.baseUrl);
		if (healthBaseUrl !== null) {
			const health = await verifyModalControlEndpoints({
				fetchFn,
					credentials,
					appHost: settings.appHost,
					baseUrl: healthBaseUrl,
					checkedAt: input.checkedAt,
				});
			if (!health.ok) return health;
		}
		const resp = await fetchFn(url, {
			method: 'POST',
			headers: modalHeaders(credentials, { 'Content-Type': 'application/json' }),
			body: JSON.stringify(payload),
		});
		const body = (await resp.json().catch(() => null)) as ModalSpawnResponse | null;
		if (!resp.ok) {
			return failure(`Modal spawn_training failed (${resp.status}): ${bodySummary(body)}`, input.checkedAt, null);
		}
		const callId =
			stringFrom(body?.call_id) ??
			stringFrom(body?.jobId) ??
			stringFrom(body?.id) ??
			stringFrom(body?.callId) ??
			stringFrom(body?.functionCallId);
		if (!callId) {
			return failure(`Modal spawn_training returned no call_id: ${bodySummary(body)}`, input.checkedAt, null);
		}
		return {
			ok: true,
			status: 'queued',
			providerJobId: callId,
			checkedAt: input.checkedAt,
			logTail: `Modal job ${jobName} spawned with call_id ${callId}.`,
			error: null,
			costUsd: null,
			metricsJson: { gpu: settings.gpu, gpuType: settings.gpu, gpuCount: settings.gpuCount, jobName },
			artifactUri: null,
		};
	} catch (e) {
		return failure(e instanceof Error ? e.message : String(e), input.checkedAt, null);
	}
}

export async function launchModalInference(
	input: ModalInferenceLaunchInput,
	deps: { readonly fetchFn?: FetchFn; readonly secretResolver?: SecretResolver } = {}
): Promise<ModalActionResult> {
	const fetchFn = deps.fetchFn ?? fetch;
	const settings = modalSettings(input);

	if (settings.dryRun) {
		return {
			ok: true,
			status: 'queued',
			providerJobId: `modal-dry-run-${input.jobName}`,
			checkedAt: input.checkedAt,
			logTail: `Modal dry run prepared inference for ${input.numeraiModelId} (job ${input.jobName}).`,
			error: null,
			costUsd: null,
			metricsJson: { dryRun: true, mode: 'inference' },
			artifactUri: null,
		};
	}

	try {
		const s3Bucket = requireModalSetting(settings.s3Bucket, 'ML_ARTIFACT_BUCKET');
		const url = modalEndpoint(settings.appHost, 'spawn-inference', input.baseUrl);
		const payload = {
			job_name: input.jobName,
			model_artifact_s3: input.modelArtifactUri,
			numerai_public_id: input.numeraiPublicId,
			numerai_secret_key: input.numeraiSecretKey,
			numerai_model_id: input.numeraiModelId,
			s3_bucket: s3Bucket,
		};
		const credentials = await resolveModalCredentials(input, deps.secretResolver);
		const resp = await fetchFn(url, {
			method: 'POST',
			headers: modalHeaders(credentials, { 'Content-Type': 'application/json' }),
			body: JSON.stringify(payload),
		});
		const body = (await resp.json().catch(() => null)) as ModalSpawnResponse | null;
		if (!resp.ok) {
			return failure(`Modal spawn_inference failed (${resp.status}): ${bodySummary(body)}`, input.checkedAt, null);
		}
		const callId =
			stringFrom(body?.call_id) ??
			stringFrom(body?.jobId) ??
			stringFrom(body?.id) ??
			stringFrom(body?.callId) ??
			stringFrom(body?.functionCallId);
		if (!callId) {
			return failure(`Modal spawn_inference returned no call_id: ${bodySummary(body)}`, input.checkedAt, null);
		}
		return {
			ok: true,
			status: 'queued',
			providerJobId: callId,
			checkedAt: input.checkedAt,
			logTail: `Modal inference job ${input.jobName} spawned with call_id ${callId}.`,
			error: null,
			costUsd: null,
			metricsJson: { mode: 'inference', jobName: input.jobName },
			artifactUri: null,
		};
	} catch (e) {
		return failure(e instanceof Error ? e.message : String(e), input.checkedAt, null);
	}
}

export async function pollModalJob(
	input: ModalStatusInput,
	deps: { readonly fetchFn?: FetchFn; readonly secretResolver?: SecretResolver } = {}
): Promise<ModalActionResult> {
	if (!input.providerJobId) {
		return success(input, 'queued', 'Modal call_id not recorded yet; job still queued.');
	}
	const settings = modalSettings(input);
	if (settings.dryRun || input.providerJobId.startsWith('modal-dry-run-')) {
		return {
			...success(input, 'running', `Modal dry run status checked for ${input.providerJobId}.`),
			metricsJson: { dryRun: true, gpu: settings.gpu, gpuType: settings.gpu, gpuCount: settings.gpuCount },
		};
	}
	const fetchFn = deps.fetchFn ?? fetch;
	const explicitStatusUrl = settings.statusUrl;

	try {
		const credentials = await resolveModalCredentials(input, deps.secretResolver);
		const url = explicitStatusUrl
			? explicitStatusUrl.replace('{jobId}', encodeURIComponent(input.providerJobId))
			: modalEndpoint(settings.appHost, 'job-status', input.baseUrl);
		const s3Bucket = explicitStatusUrl
			? null
			: requireModalSetting(settings.s3Bucket, 'ML_ARTIFACT_BUCKET');
		const resp = await fetchFn(
			url,
			explicitStatusUrl
				? { headers: modalHeaders(credentials) }
				: {
						method: 'POST',
						headers: modalHeaders(credentials, { 'Content-Type': 'application/json' }),
						body: JSON.stringify({
							call_id: input.providerJobId,
							job_name: input.runId ? trainingJobName(input.runId) : undefined,
							s3_bucket: s3Bucket,
						}),
					}
		);
		const text = await resp.text();
		const body = parseJsonBody(text) as ModalStatusResponse | null;
		if (!resp.ok) {
			if (resp.status === 404 && !text.trim()) {
				return success(input, 'queued', `Modal job ${input.providerJobId} is not visible to status polling yet (404 empty response).`);
			}
			return failure(
				`Modal job_status failed (${resp.status}): ${bodySummary(body)}`,
				input.checkedAt,
				input.providerJobId
			);
		}
		const remoteStatus = stringFrom(body?.status) ?? 'queued';
		const status = mapModalStatus(remoteStatus);
		const error = stringFrom(body?.error);
		const result = asRecord(body?.result);
		const innerResult = asRecord(result?.result);
		const metrics = asRecord(body?.metricsJson) ?? innerResult ?? result ?? { providerStatus: remoteStatus };
		return {
			ok: status !== 'failed' && (error === null || status === 'cancelled'),
			status: error && status !== 'cancelled' ? 'failed' : status,
			providerJobId: input.providerJobId,
			checkedAt: input.checkedAt,
			logTail: logTailFromStatusBody(body) ?? `Modal call ${input.providerJobId} status=${remoteStatus}.`,
			error,
			costUsd: numberFrom(body?.costUsd),
			metricsJson: metrics,
			artifactUri: stringFrom(body?.artifactUri) ?? stringFrom(body?.artifact_uri) ?? parseArtifactUri(innerResult ?? result),
		};
	} catch (e) {
		return failure(e instanceof Error ? e.message : String(e), input.checkedAt, input.providerJobId);
	}
}

async function verifyModalControlEndpoints(input: {
	readonly fetchFn: FetchFn;
	readonly credentials: ModalCredentials | null;
	readonly appHost: string | null;
	readonly baseUrl?: string | null;
	readonly checkedAt: string;
}): Promise<ModalActionResult> {
	const endpoints = [
		{ name: 'job-status', url: modalEndpoint(input.appHost, 'job-status', input.baseUrl) },
		{ name: 'job-cancel', url: modalEndpoint(input.appHost, 'job-cancel', input.baseUrl) },
	] as const;

	for (const endpoint of endpoints) {
		const resp = await input.fetchFn(endpoint.url, {
			method: 'POST',
			headers: modalHeaders(input.credentials, { 'Content-Type': 'application/json' }),
			body: JSON.stringify({ call_id: MODAL_HEALTHCHECK_CALL_ID }),
		});
		if (resp.status === 404) {
			return failure(
				`Modal endpoint ${endpoint.name} is missing. Redeploy ml/sagemaker/modal_runner.py before launching training.`,
				input.checkedAt,
				null
			);
		}
	}

	return {
		ok: true,
		status: 'queued',
		providerJobId: null,
		checkedAt: input.checkedAt,
		logTail: 'Modal control endpoints are reachable.',
		error: null,
		costUsd: null,
		metricsJson: null,
		artifactUri: null,
	};
}

export async function cancelModalJob(
	input: ModalStatusInput,
	deps: { readonly fetchFn?: FetchFn; readonly secretResolver?: SecretResolver } = {}
): Promise<ModalActionResult> {
	if (!input.providerJobId) {
		return success(input, 'cancelled', `Cancelled before Modal call_id was recorded.`);
	}
	const settings = modalSettings(input);
	if (settings.dryRun || input.providerJobId.startsWith('modal-dry-run-')) {
		return success(input, 'cancelled', `Modal dry run cancelled for ${input.providerJobId}.`);
	}
	const fetchFn = deps.fetchFn ?? fetch;
	const explicitCancelUrl = settings.cancelUrl;

	try {
		const credentials = await resolveModalCredentials(input, deps.secretResolver);
		const url = explicitCancelUrl
			? explicitCancelUrl.replace('{jobId}', encodeURIComponent(input.providerJobId))
			: modalEndpoint(settings.appHost, 'job-cancel', input.baseUrl);
		const resp = await fetchFn(url, {
			method: 'POST',
			headers: modalHeaders(credentials, { 'Content-Type': 'application/json' }),
			body: explicitCancelUrl ? undefined : JSON.stringify({ call_id: input.providerJobId }),
		});
		const text = await resp.text();
		const body = parseJsonBody(text) as ModalStatusResponse | null;
		if (!resp.ok) {
			return failure(
				`Modal job_cancel failed (${resp.status}): ${bodySummary(body)}`,
				input.checkedAt,
				input.providerJobId
			);
		}
		return success(input, 'cancelled', `Modal cancel requested for ${input.providerJobId}.`);
	} catch (e) {
		return failure(e instanceof Error ? e.message : String(e), input.checkedAt, input.providerJobId);
	}
}

export async function resolveSecretRef(
	value: string | null | undefined,
	secretResolver: SecretResolver = getSecret
): Promise<string | null> {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	return secretResolver(trimmed);
}

export async function resolveModalCredentials(
	input: ModalProviderInput,
	secretResolver: SecretResolver = getSecret
): Promise<ModalCredentials | null> {
	const tokenId = input.apiKey?.trim() || (input.apiKeyRef ? await resolveSecretRef(input.apiKeyRef, secretResolver) : null);
	const tokenSecret = input.apiSecret?.trim() || (input.apiSecretRef ? await resolveSecretRef(input.apiSecretRef, secretResolver) : null);
	return tokenId && tokenSecret ? { tokenId, tokenSecret } : null;
}

function modalSettings(input: ModalProviderInput): ModalSettings {
	const raw = settingsRecord(input.providerConfigJson);
	const hyperparams = asRecord(raw.hyperparams) ?? {};
	return {
		dryRun: raw.dryRun === true,
		appHost: stringFrom(raw.appHost) ?? stringFrom(raw.app_host) ?? stringFrom(process.env.MODAL_APP_HOST),
		s3Bucket:
			stringFrom(raw.s3Bucket) ??
			stringFrom(raw.s3_bucket) ??
			stringFrom(process.env.ML_ARTIFACT_BUCKET),
		gpu: stringFrom(raw.gpuType) ?? stringFrom(raw.gpu) ?? 'a10g',
		gpuCount: numberFrom(raw.gpuCount) ?? 1,
		launchUrl: stringFrom(raw.launchUrl),
		statusUrl: stringFrom(raw.statusUrl),
		cancelUrl: stringFrom(raw.cancelUrl),
		hyperparams,
		envVars: envVarsFrom(raw.envVars),
	};
}

function settingsRecord(value: unknown): Record<string, unknown> {
	const root = asRecord(value);
	if (!root) return {};
	const nested = asRecord(root.modal);
	return nested ?? root;
}

function modalEndpoint(appHost: string | null, fnSlug: string, baseUrl: string | null | undefined): string {
	if (baseUrl?.trim()) {
		const trimmed = baseUrl.trim().replace(/\/$/, '');
		if (/^https?:\/\//i.test(trimmed)) {
			return trimmed.replace(/-(spawn-training|spawn-inference|job-status|job-cancel)\.modal\.run/, `-${fnSlug}.modal.run`);
		}
	}
	if (!appHost) {
		throw new Error('Modal endpoint is not configured: set MODAL_APP_HOST or provide a Modal base URL');
	}
	if (!/^[a-z0-9](?:[a-z0-9-]{0,251}[a-z0-9])?$/i.test(appHost)) {
		throw new Error('MODAL_APP_HOST must be a valid Modal host prefix');
	}
	return `https://${appHost}-${fnSlug}.modal.run`;
}

function requireModalSetting(value: string | null, environmentName: string): string {
	if (value) return value;
	throw new Error(`Modal storage is not configured: set ${environmentName} or provide modal.s3Bucket`);
}

function modalHealthBaseUrl(launchUrl: string | null, baseUrl: string | null | undefined): string | null | undefined {
	if (!launchUrl) return baseUrl;
	return /-spawn-training\.modal\.run\/?$/i.test(launchUrl.trim()) ? launchUrl : null;
}

function modalHeaders(credentials: ModalCredentials | null, extra: HeadersInit = {}): HeadersInit {
	return credentials
		? {
				Authorization: `Bearer ${credentials.tokenSecret}`,
				'X-Modal-Token-Id': credentials.tokenId,
				'X-Modal-Token-Secret': credentials.tokenSecret,
				...extra,
			}
		: extra;
}

function trainingJobName(runId: string): string {
	const safe = runId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
	const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 8);
	return `numerai-${safe}-${suffix}`;
}

function mapModalStatus(status: string): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
	switch (status.toLowerCase()) {
		case 'completed':
		case 'complete':
		case 'success':
		case 'succeeded':
		case 'done':
			return 'completed';
		case 'failed':
		case 'error':
			return 'failed';
		case 'cancelled':
		case 'canceled':
			return 'cancelled';
		case 'running':
		case 'started':
			return 'running';
		default:
			return 'queued';
	}
}

function parseArtifactUri(result: Record<string, unknown> | null): string | null {
	if (!result) return null;
	return stringFrom(result.artifact_uri) ?? stringFrom(result.artifactUri);
}

function logTailFromStatusBody(body: ModalStatusResponse | null): string | null {
	const direct = stringFrom(body?.logTail) ?? stringFrom(body?.logs);
	if (direct) return direct;
	const logs = Array.isArray(body?.logs) ? body.logs : null;
	if (!logs) return null;
	const lines = logs
		.map((item) => {
			if (typeof item === 'string') return item;
			const row = asRecord(item);
			return stringFrom(row?.log) ?? stringFrom(row?.message) ?? stringFrom(row?.text);
		})
		.filter((item): item is string => item !== null);
	return lines.length ? lines.join('\n') : null;
}

function parseJsonBody(value: string): unknown {
	if (!value.trim()) return null;
	try {
		return JSON.parse(value);
	} catch {
		return { logs: value };
	}
}

function bodySummary(body: unknown): string {
	if (!body) return 'empty response';
	return JSON.stringify(body).slice(0, 500);
}

function success(input: ModalStatusInput, status: string, logTail: string): ModalActionResult {
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

function failure(error: string, checkedAt: string, providerJobId: string | null): ModalActionResult {
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

function numberFrom(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}

function envVarsFrom(value: unknown): Record<string, string> {
	const record = asRecord(value);
	if (!record) return {};
	return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

async function getSecret(name: string): Promise<string> {
	const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
	if (!result.Parameter?.Value) throw new Error(`Secret reference not found: ${name}`);
	return result.Parameter.Value;
}
