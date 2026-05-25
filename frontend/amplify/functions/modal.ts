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
	readonly appHost: string;
	readonly s3Bucket: string;
	readonly gpu: string;
	readonly hyperparams: Record<string, unknown>;
};

const ssm = new SSMClient({});

const DEFAULT_APP_HOST = 'almaz--openoptions-ml';
const DEFAULT_S3_BUCKET = 'openoptions-ml';

export async function launchModalTraining(
	input: ModalTrainingLaunchInput,
	deps: { readonly fetchFn?: FetchFn } = {}
): Promise<ModalActionResult> {
	const fetchFn = deps.fetchFn ?? fetch;
	const settings = modalSettings(input);

	const jobName = trainingJobName(input.runId);
	const payload = {
		gpu: settings.gpu,
		job_name: jobName,
		hyperparams: { ...settings.hyperparams, run_id: input.runId, provider_id: input.providerId },
		s3_bucket: settings.s3Bucket,
	};

	if (settings.dryRun) {
		return {
			ok: true,
			status: 'queued',
			providerJobId: `modal-dry-run-${jobName}`,
			checkedAt: input.checkedAt,
			logTail: `Modal dry run prepared ${settings.gpu} job ${jobName} for run ${input.runId}.`,
			error: null,
			costUsd: null,
			metricsJson: { dryRun: true, gpu: settings.gpu },
			artifactUri: null,
		};
	}

	const url = modalEndpoint(settings.appHost, 'spawn-training', input.baseUrl);
	try {
		const resp = await fetchFn(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		const body = (await resp.json().catch(() => null)) as ModalSpawnResponse | null;
		if (!resp.ok) {
			return failure(`Modal spawn_training failed (${resp.status}): ${bodySummary(body)}`, input.checkedAt, null);
		}
		const callId = stringOrNull(body?.call_id);
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
			metricsJson: { gpu: settings.gpu, jobName },
			artifactUri: null,
		};
	} catch (e) {
		return failure(e instanceof Error ? e.message : String(e), input.checkedAt, null);
	}
}

export async function launchModalInference(
	input: ModalInferenceLaunchInput,
	deps: { readonly fetchFn?: FetchFn } = {}
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

	const url = modalEndpoint(settings.appHost, 'spawn-inference', input.baseUrl);
	const payload = {
		job_name: input.jobName,
		model_artifact_s3: input.modelArtifactUri,
		numerai_public_id: input.numeraiPublicId,
		numerai_secret_key: input.numeraiSecretKey,
		numerai_model_id: input.numeraiModelId,
		s3_bucket: settings.s3Bucket,
	};

	try {
		const resp = await fetchFn(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		const body = (await resp.json().catch(() => null)) as ModalSpawnResponse | null;
		if (!resp.ok) {
			return failure(`Modal spawn_inference failed (${resp.status}): ${bodySummary(body)}`, input.checkedAt, null);
		}
		const callId = stringOrNull(body?.call_id);
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
	deps: { readonly fetchFn?: FetchFn } = {}
): Promise<ModalActionResult> {
	if (!input.providerJobId) {
		return success(input, 'queued', 'Modal call_id not recorded yet; job still queued.');
	}
	const settings = modalSettings(input);
	if (settings.dryRun || input.providerJobId.startsWith('modal-dry-run-')) {
		return success(input, 'running', `Modal dry run status checked for ${input.providerJobId}.`);
	}
	const fetchFn = deps.fetchFn ?? fetch;
	const url = modalEndpoint(settings.appHost, 'job-status', input.baseUrl);

	try {
		const resp = await fetchFn(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ call_id: input.providerJobId }),
		});
		const body = (await resp.json().catch(() => null)) as ModalStatusResponse | null;
		if (!resp.ok) {
			return failure(
				`Modal job_status failed (${resp.status}): ${bodySummary(body)}`,
				input.checkedAt,
				input.providerJobId
			);
		}
		const remoteStatus = stringOrNull(body?.status) ?? 'queued';
		const status = mapModalStatus(remoteStatus);
		const error = stringOrNull(body?.error);
		const result = asRecord(body?.result);
		const innerResult = asRecord(result?.result);
		return {
			ok: status !== 'failed' || error === null,
			status,
			providerJobId: input.providerJobId,
			checkedAt: input.checkedAt,
			logTail: `Modal call ${input.providerJobId} status=${remoteStatus}.`,
			error,
			costUsd: null,
			metricsJson: innerResult ?? result ?? null,
			artifactUri: parseArtifactUri(innerResult ?? result),
		};
	} catch (e) {
		return failure(e instanceof Error ? e.message : String(e), input.checkedAt, input.providerJobId);
	}
}

export async function cancelModalJob(
	input: ModalStatusInput,
	deps: { readonly fetchFn?: FetchFn } = {}
): Promise<ModalActionResult> {
	if (!input.providerJobId) {
		return success(input, 'cancelled', `Cancelled before Modal call_id was recorded.`);
	}
	const settings = modalSettings(input);
	if (settings.dryRun || input.providerJobId.startsWith('modal-dry-run-')) {
		return success(input, 'cancelled', `Modal dry run cancelled for ${input.providerJobId}.`);
	}
	const fetchFn = deps.fetchFn ?? fetch;
	const url = modalEndpoint(settings.appHost, 'job-cancel', input.baseUrl);

	try {
		const resp = await fetchFn(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ call_id: input.providerJobId }),
		});
		const body = (await resp.json().catch(() => null)) as ModalStatusResponse | null;
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

type ModalSpawnResponse = {
	readonly status?: unknown;
	readonly call_id?: unknown;
	readonly detail?: unknown;
};

type ModalStatusResponse = {
	readonly status?: unknown;
	readonly error?: unknown;
	readonly detail?: unknown;
	readonly result?: unknown;
};

function modalSettings(input: ModalProviderInput): ModalSettings {
	const raw = settingsRecord(input.providerConfigJson);
	const hyperparams = asRecord(raw.hyperparams) ?? {};
	return {
		dryRun: raw.dryRun === true,
		appHost: stringFrom(raw.appHost) ?? stringFrom(raw.app_host) ?? DEFAULT_APP_HOST,
		s3Bucket: stringFrom(raw.s3Bucket) ?? stringFrom(raw.s3_bucket) ?? DEFAULT_S3_BUCKET,
		gpu: stringFrom(raw.gpu) ?? 'a10g',
		hyperparams,
	};
}

function settingsRecord(value: unknown): Record<string, unknown> {
	const root = asRecord(value);
	if (!root) return {};
	const nested = asRecord(root.modal);
	return nested ?? root;
}

function modalEndpoint(appHost: string, fnSlug: string, baseUrl: string | null | undefined): string {
	if (baseUrl?.trim()) {
		// If a fully-qualified baseUrl is provided, swap the function slug in the host segment.
		const trimmed = baseUrl.trim().replace(/\/$/, '');
		if (/^https?:\/\//i.test(trimmed)) {
			return trimmed.replace(/-(spawn-training|spawn-inference|job-status|job-cancel)\.modal\.run/, `-${fnSlug}.modal.run`);
		}
	}
	return `https://${appHost}-${fnSlug}.modal.run`;
}

function trainingJobName(runId: string): string {
	const safe = runId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
	const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 8);
	return `numerai-${safe}-${suffix}`;
}

function mapModalStatus(status: string): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
	switch (status) {
		case 'completed':
		case 'success':
		case 'succeeded':
			return 'completed';
		case 'failed':
		case 'error':
			return 'failed';
		case 'cancelled':
		case 'canceled':
			return 'cancelled';
		case 'running':
			return 'running';
		default:
			return 'queued';
	}
}

function parseArtifactUri(result: Record<string, unknown> | null): string | null {
	if (!result) return null;
	const direct = stringFrom(result.artifact_uri);
	if (direct) return direct;
	return null;
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
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringFrom(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

async function getSecret(name: string): Promise<string> {
	const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
	if (!result.Parameter?.Value) throw new Error(`Secret reference not found: ${name}`);
	return result.Parameter.Value;
}
