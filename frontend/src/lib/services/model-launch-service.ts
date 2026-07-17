import { dataClient } from '$lib/data';
import type { Schema } from '../../../amplify/data/resource';
import { updateComputeJobStatus, type ComputeJob, type ComputeProvider } from './compute-service';
import { graphSnapshot, awsJson, type PipelineTemplate, type TrainingRun } from './pipeline-service';
import type { ModelRegistryItem, ModelStage } from './registry-service';
import {
	startTrainingRun,
	pollTrainingRunStatus,
	readLocalTrainingSnapshot,
	terminalActionTimestamp,
	toComputeJobStatus,
	updateTrainingRunFromAction,
	type TrainingActionResult
} from './training-service';
import { assertProviderGpu } from './provider-gpu-catalog';
import { primeOfferConfig, type PrimeOffer } from './prime-offers-service';

type Client = ReturnType<typeof dataClient>;

type Pipeline = Schema['Pipeline']['type'];
type ModelBranch = Schema['ModelBranch']['type'];

export const DEFAULT_MODAL_SMOKE_HYPERPARAMS = {
	feature_set: 'small',
	max_train_eras: 20,
	num_rounds: 10,
	single_target: true,
	target_col: 'target_ender_20',
	target_cols: ['target_ender_20']
} as const;

// Fast, MPS-friendly defaults for a local smoke run on an Apple Silicon Mac.
export const DEFAULT_LOCAL_TRAINING_CONFIG = {
	model_type: 'mlp',
	feature_set: 'small',
	neutralization_pct: 25,
	upload: false,
	hyperparams: {
		max_train_eras: 20,
		single_target_mode: true,
		target_col: 'target_ender_20'
	}
} as const;

export type ModelTrainingResult = {
	readonly model: ModelRegistryItem;
	// null when the TrainingRun bookkeeping row could not be updated during a
	// best-effort refresh — the model stage is still authoritative.
	readonly run: TrainingRun | null;
	readonly job: ComputeJob;
	readonly action: TrainingActionResult;
};

export type LaunchTrainingToast = {
	readonly message: string;
	readonly type: 'success' | 'error';
};

export function launchTrainingToast(input: {
	readonly model: Pick<ModelRegistryItem, 'name'>;
	readonly action: Pick<TrainingActionResult, 'ok' | 'error'>;
}): LaunchTrainingToast {
	if (!input.action.ok) {
		return {
			message: input.action.error ?? `${input.model.name} could not launch.`,
			type: 'error'
		};
	}
	return {
		message: `${input.model.name} is training.`,
		type: 'success'
	};
}

export async function launchModelDraft(
	input: {
		readonly model: ModelRegistryItem;
		readonly provider: ComputeProvider;
		readonly maxSpendUsd: number | null;
		readonly gpuType?: string | null;
		readonly primeOffer?: PrimeOffer | null;
	},
	client: Client = dataClient()
): Promise<ModelTrainingResult> {
	const lineage = jsonRecord(input.model.lineageJson);
	const { pipeline, branch } = await ensurePipelineAndBranch(input.model, lineage, client);
	const run = await createTrainingRun(
		{
			model: input.model,
			provider: input.provider,
			pipeline,
			branch,
			lineage,
			maxSpendUsd: input.maxSpendUsd
		},
		client
	);
	const plannedJob = await createComputeJob(
		{
			model: input.model,
			run,
			provider: input.provider,
			maxSpendUsd: input.maxSpendUsd
		},
		client
	);
	const action = await startTrainingRun(
		{
			runId: run.id,
			provider: input.provider,
			providerConfigJson: providerConfigForLaunch(
				input.provider,
				input.gpuType ?? null,
				jsonRecord(lineage.runConfig),
				input.primeOffer ?? null
			)
		},
		client
	);
	const job = await persistJobAction(plannedJob, action, client);
	const updatedRun = await updateTrainingRunFromAction({ runId: run.id, action }, client);
	const model = await persistModelAction(
		{
			model: input.model,
			pipelineId: pipeline.id,
			branchId: branch.id,
			runId: run.id,
			lineage,
			action
		},
		client
	);

	return { model, run: updatedRun, job, action };
}

export async function refreshModelTraining(
	input: {
		readonly model: ModelRegistryItem;
		readonly job: ComputeJob;
		readonly provider: ComputeProvider;
	},
	client: Client = dataClient()
): Promise<ModelTrainingResult> {
	if (!input.job.runId) throw new Error('Model training job is missing a run id.');
	if (input.provider.providerType === 'local') {
		const snapshot = await readLocalTrainingSnapshot(
			{
				runId: input.job.runId,
				providerJobId: input.job.providerJobId ?? null
			},
			client
		);
		if (!snapshot.job) throw new Error(`Local training run ${input.job.runId} is missing its compute job.`);
		const model = await persistModelAction(
			{
				model: input.model,
				pipelineId: input.model.pipelineId ?? null,
				branchId: input.model.branchId ?? null,
				runId: input.job.runId,
				lineage: jsonRecord(input.model.lineageJson),
				action: snapshot.action
			},
			client
		);
		return { model, run: snapshot.run, job: snapshot.job, action: snapshot.action };
	}
	const action = await pollTrainingRunStatus(
		{
			runId: input.job.runId,
			provider: input.provider,
			providerJobId: input.job.providerJobId ?? null
		},
		client
	);

	// Write the user-visible model stage FIRST. The ComputeJob / TrainingRun rows
	// below are bookkeeping — a failure updating either must never throw before
	// the model flips, or a finished run stays stuck on "Training" forever.
	const model = await persistModelAction(
		{
			model: input.model,
			pipelineId: input.model.pipelineId ?? null,
			branchId: input.model.branchId ?? null,
			runId: input.job.runId,
			lineage: jsonRecord(input.model.lineageJson),
			action
		},
		client
	);

	let job = input.job;
	try {
		job = await persistJobAction(input.job, action, client);
	} catch (error) {
		console.warn(`ComputeJob.update failed for job ${input.job.id}; model stage already applied.`, error);
	}

	let run: TrainingRun | null = null;
	try {
		run = await updateTrainingRunFromAction(
			{
				runId: input.job.runId,
				action,
				currentStartedAt: input.job.startedAt ?? null
			},
			client
		);
	} catch (error) {
		console.warn(`TrainingRun.update failed for run ${input.job.runId}; model stage already applied.`, error);
	}

	return { model, run, job, action };
}

function modelStageFromAction(action: TrainingActionResult): ModelStage {
	switch (toComputeJobStatus(action.status)) {
		case 'completed':
			return 'success';
		case 'failed':
		case 'cancelled':
			return 'failed';
		case 'planned':
		case 'queued':
		case 'running':
			return 'training';
	}
}

async function ensurePipelineAndBranch(
	model: ModelRegistryItem,
	lineage: Record<string, unknown>,
	client: Client
): Promise<{ readonly pipeline: Pipeline; readonly branch: ModelBranch }> {
	const template = templateFromLineage(lineage);
	if (model.pipelineId && model.branchId) {
		const [pipelineResult, branchResult] = await Promise.all([
			client.models.Pipeline.get({ id: model.pipelineId }),
			client.models.ModelBranch.get({ id: model.branchId })
		]);
		if (pipelineResult.data && branchResult.data) {
			return { pipeline: pipelineResult.data as Pipeline, branch: branchResult.data as ModelBranch };
		}
	}

	const graph = graphSnapshot(template, [], [], null);
	const { data: pipeline, errors: pipelineErrors } = await client.models.Pipeline.create({
		name: model.name,
		description: model.changeSummary ?? 'Model draft launched from Launch.',
		status: 'testing',
		template,
		graphJson: awsJson({ ...graph, lineage })
	});
	throwGraphQLError(pipelineErrors, 'Pipeline.create failed');
	if (!pipeline) throw new Error('Pipeline.create returned no data');

	const { data: branch, errors: branchErrors } = await client.models.ModelBranch.create({
		pipelineId: pipeline.id,
		name: `${model.name}-draft`,
		changeSummary: model.changeSummary ?? 'Model draft launch branch.',
		graphJson: awsJson({ ...graph, lineage }),
		status: 'queued'
	});
	throwGraphQLError(branchErrors, 'ModelBranch.create failed');
	if (!branch) throw new Error('ModelBranch.create returned no data');

	const { errors: updateErrors } = await client.models.Pipeline.update({
		id: pipeline.id,
		activeBranchId: branch.id
	});
	throwGraphQLError(updateErrors, 'Pipeline.update failed');

	return { pipeline: pipeline as Pipeline, branch: branch as ModelBranch };
}

async function createTrainingRun(
	input: {
		readonly model: ModelRegistryItem;
		readonly provider: ComputeProvider;
		readonly pipeline: Pipeline;
		readonly branch: ModelBranch;
		readonly lineage: Record<string, unknown>;
		readonly maxSpendUsd: number | null;
	},
	client: Client
): Promise<TrainingRun> {
	const runConfig = jsonRecord(input.lineage.runConfig);
	const sweep = jsonRecord(input.lineage.sweep);
	const { data, errors } = await client.models.TrainingRun.create({
		pipelineId: input.pipeline.id,
		branchId: input.branch.id,
		providerId: input.provider.id,
		modelTemplate: templateFromLineage(input.lineage),
		status: 'queued',
		configJson: awsJson({
			...runConfig,
			modelId: input.model.id,
			modelName: input.model.name,
			sweep
		}),
		costUsd: input.maxSpendUsd
	});
	throwGraphQLError(errors, 'TrainingRun.create failed');
	if (!data) throw new Error('TrainingRun.create returned no data');
	return data as TrainingRun;
}

async function createComputeJob(
	input: {
		readonly model: ModelRegistryItem;
		readonly run: TrainingRun;
		readonly provider: ComputeProvider;
		readonly maxSpendUsd: number | null;
	},
	client: Client
): Promise<ComputeJob> {
	const { data, errors } = await client.models.ComputeJob.create({
		providerId: input.provider.id,
		runId: input.run.id,
		name: input.model.name,
		status: 'planned',
		estimatedCostUsd: input.maxSpendUsd
	});
	throwGraphQLError(errors, 'ComputeJob.create failed');
	if (!data) throw new Error('ComputeJob.create returned no data');
	return data as ComputeJob;
}

async function persistJobAction(
	job: ComputeJob,
	action: TrainingActionResult,
	client: Client
): Promise<ComputeJob> {
	return updateComputeJobStatus(
		{
			jobId: job.id,
			status: toComputeJobStatus(action.status),
			startedAt: toComputeJobStatus(action.status) === 'running' ? action.checkedAt : job.startedAt,
			finishedAt: terminalActionTimestamp(action.status, action.checkedAt),
			providerJobId: action.providerJobId ?? job.providerJobId ?? null,
			logTail: action.logTail ?? action.error ?? null,
			actualCostUsd: action.costUsd ?? null
		},
		client
	);
}

async function persistModelAction(
	input: {
		readonly model: ModelRegistryItem;
		readonly pipelineId: string | null;
		readonly branchId: string | null;
		readonly runId: string;
		readonly lineage: Record<string, unknown>;
		readonly action: TrainingActionResult;
	},
	client: Client
): Promise<ModelRegistryItem> {
	const { data, errors } = await client.models.ModelRegistryItem.update({
		id: input.model.id,
		stage: modelStageFromAction(input.action),
		pipelineId: input.pipelineId,
		branchId: input.branchId,
		runId: input.runId,
		lineageJson: awsJson({
			...input.lineage,
			lastTrainingAction: {
				status: input.action.status,
				providerJobId: input.action.providerJobId,
				checkedAt: input.action.checkedAt,
				error: input.action.error,
				artifactUri: input.action.artifactUri
			}
		})
	});
	throwGraphQLError(errors, 'ModelRegistryItem.update failed');
	if (!data) throw new Error('ModelRegistryItem.update returned no data');
	return data as ModelRegistryItem;
}

function templateFromLineage(lineage: Record<string, unknown>): PipelineTemplate {
	const template = lineage.template;
	return template === 'baseline' || template === 'challenger' || template === 'ensemble'
		? template
		: 'custom';
}

function jsonRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== 'string') return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

// Top-level local training fields; everything else in runConfig is forwarded
// as a hyperparam (the daemon ignores keys it doesn't recognise).
const LOCAL_TOP_LEVEL_KEYS = new Set([
	'mode',
	'tournament',
	'model_type',
	'feature_set',
	'neutralization_pct',
	'upload'
]);

export function providerConfigForLaunch(
	provider: ComputeProvider,
	gpuType: string | null,
	runConfig?: Record<string, unknown> | null,
	primeOffer?: PrimeOffer | null
): unknown {
	const config = jsonObjectValue(provider.credentialsJson);
	if (provider.providerType === 'local') {
		// Local runs go to the on-machine daemon. Build the request from the
		// model's runConfig (model_type/feature_set/hyperparams chosen in the
		// builder), falling back to MPS-friendly defaults and any provider-level
		// overrides under a `local` key.
		const rc = runConfig ?? {};
		const local = recordOrNull(config?.local) ?? {};
		const rcHyperparams = Object.fromEntries(
			Object.entries(rc).filter(([key]) => !LOCAL_TOP_LEVEL_KEYS.has(key))
		);
		return jsonObjectValue({
			...config,
			local: {
				model_type: rc.model_type ?? local.model_type ?? DEFAULT_LOCAL_TRAINING_CONFIG.model_type,
				feature_set: rc.feature_set ?? local.feature_set ?? DEFAULT_LOCAL_TRAINING_CONFIG.feature_set,
				neutralization_pct:
					rc.neutralization_pct ?? local.neutralization_pct ?? DEFAULT_LOCAL_TRAINING_CONFIG.neutralization_pct,
				upload: (rc.upload ?? local.upload ?? DEFAULT_LOCAL_TRAINING_CONFIG.upload) === true,
				hyperparams: {
					...DEFAULT_LOCAL_TRAINING_CONFIG.hyperparams,
					...rcHyperparams,
					...(recordOrNull(local.hyperparams) ?? {})
				}
			}
		});
	}
	const selectedGpu = assertProviderGpu(provider, gpuType);
	if (!selectedGpu) return config;
	if (provider.providerType === 'prime_intellect') {
		const prime = recordOrNull(config?.primeIntellect) ?? recordOrNull(config?.prime_intellect) ?? {};
		const envVars = recordOrNull(prime.envVars) ?? {};
		return jsonObjectValue({
			...config,
			primeIntellect: {
				...prime,
				...(primeOffer ? primeOfferConfig(primeOffer) : {}),
				gpuType: selectedGpu,
				envVars: {
					...envVars,
					NUMERAI_RUN_CONFIG_JSON: JSON.stringify(runConfig ?? {})
				}
			}
		});
	}
	if (provider.providerType === 'modal') {
		const modal = recordOrNull(config?.modal) ?? {};
		const hyperparams = recordOrNull(modal.hyperparams);
		return jsonObjectValue({
			...config,
			modal: {
				...modal,
				hyperparams: {
					...DEFAULT_MODAL_SMOKE_HYPERPARAMS,
					...hyperparams
				},
				gpuType: selectedGpu
			}
		});
	}
	return config;
}

function jsonObjectValue(value: unknown): Record<string, unknown> | null {
	const record = jsonRecord(value);
	if (!record) return null;
	return {
		...Object.fromEntries(
			Object.entries(record)
				.map(([key, val]) => [key, jsonCompatibleValue(val)] as const)
				.filter((entry): entry is readonly [string, Exclude<ReturnType<typeof jsonCompatibleValue>, undefined>] => entry[1] !== undefined)
		)
	};
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function jsonCompatibleValue(value: unknown): unknown {
	if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
	if (Array.isArray(value)) return value.map(jsonCompatibleValue).filter((item) => item !== undefined);
	const record = recordOrNull(value);
	if (!record) return undefined;
	return Object.fromEntries(
		Object.entries(record)
			.map(([key, val]) => [key, jsonCompatibleValue(val)] as const)
			.filter((entry): entry is readonly [string, Exclude<ReturnType<typeof jsonCompatibleValue>, undefined>] => entry[1] !== undefined)
	);
}

function throwGraphQLError(errors: readonly { message?: string }[] | undefined, fallback: string): void {
	if (!errors?.length) return;
	throw new Error(errors.map((error) => error.message).filter(Boolean).join('; ') || fallback);
}
