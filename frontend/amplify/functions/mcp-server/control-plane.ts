import { createHash } from 'node:crypto';
import type { Schema } from '../../data/resource';

type ApiKey = Schema['ApiKey']['type'];
type ComputeJob = Schema['ComputeJob']['type'];
type ComputeProvider = Schema['ComputeProvider']['type'];
type ModelBranch = Schema['ModelBranch']['type'];
type ModelRegistryItem = Schema['ModelRegistryItem']['type'];
type ModelSubmission = Schema['ModelSubmission']['type'];
type Pipeline = Schema['Pipeline']['type'];
type TrainingActionResult = NonNullable<Schema['TrainingActionResult']['type']>;
type TrainingRun = Schema['TrainingRun']['type'];

type DataError = { readonly message?: string | null };
type DataResult<T> = Promise<{
	readonly data?: T | null;
	readonly errors?: readonly DataError[];
}>;

export type McpDataClient = {
	readonly models: {
		readonly ApiKey: {
			apiKeyByHash(args: unknown): DataResult<ApiKey[]>;
			update(args: unknown): DataResult<ApiKey>;
		};
		readonly TrainingRun: {
			list(args: unknown): DataResult<TrainingRun[]>;
			get(args: unknown): DataResult<TrainingRun>;
			create(args: unknown): DataResult<TrainingRun>;
			update(args: unknown): DataResult<TrainingRun>;
		};
		readonly Pipeline: {
			get(args: unknown): DataResult<Pipeline>;
			create(args: unknown): DataResult<Pipeline>;
			update(args: unknown): DataResult<Pipeline>;
		};
		readonly ModelBranch: {
			get(args: unknown): DataResult<ModelBranch>;
			create(args: unknown): DataResult<ModelBranch>;
			update(args: unknown): DataResult<ModelBranch>;
		};
		readonly ModelRegistryItem: {
			list(args: unknown): DataResult<ModelRegistryItem[]>;
			get(args: unknown): DataResult<ModelRegistryItem>;
			create(args: unknown): DataResult<ModelRegistryItem>;
			update(args: unknown): DataResult<ModelRegistryItem>;
			delete(args: unknown): DataResult<ModelRegistryItem>;
		};
		readonly ComputeProvider: {
			get(args: unknown): DataResult<ComputeProvider>;
			list(args: unknown): DataResult<ComputeProvider[]>;
			update(args: unknown): DataResult<ComputeProvider>;
		};
		readonly ComputeJob: {
			list(args: unknown): DataResult<ComputeJob[]>;
			create(args: unknown): DataResult<ComputeJob>;
			update(args: unknown): DataResult<ComputeJob>;
		};
		readonly ModelSubmission: {
			list(args: unknown): DataResult<ModelSubmission[]>;
		};
	};
	readonly mutations: {
		startTraining(args: unknown): DataResult<TrainingActionResult>;
		pollTrainingStatus(args: unknown): DataResult<TrainingActionResult>;
		cancelTraining(args: unknown): DataResult<TrainingActionResult>;
	};
};

export type McpPrincipal = {
	readonly ownerSub: string;
};

export type CreateModelInput = {
	readonly name?: string;
	readonly modelType: string;
	readonly runConfig?: Record<string, unknown>;
	readonly changeSummary?: string;
	readonly parentModelId?: string;
	readonly template?: string;
	readonly sweep?: {
		readonly parameter: string;
		readonly values: readonly (string | number | boolean)[];
		readonly maxRuns?: number;
	};
};

export type UpdateModelInput = {
	readonly modelId: string;
	readonly name?: string;
	readonly stage?: string;
	readonly changeSummary?: string | null;
	readonly parentModelId?: string | null;
	readonly numeraiModelId?: string | null;
	readonly runConfig?: Record<string, unknown>;
};

export class McpControlPlane {
	constructor(private readonly client: McpDataClient) {}

	async authenticate(rawKey: string | null | undefined): Promise<McpPrincipal | null> {
		if (!isMcpApiKey(rawKey)) return null;
		const { data, errors } = await this.client.models.ApiKey.apiKeyByHash({
			keyHash: hashMcpApiKey(rawKey),
		});
		throwDataErrors(errors, 'ApiKey lookup failed');
		const matches = (data ?? []).filter((record) => !record.revokedAt);
		if (matches.length !== 1) return null;

		const key = matches[0] as ApiKey;
		const ownerSub = ownerSubFromRecord(key);
		if (!ownerSub) return null;
		await this.client.models.ApiKey.update({ id: key.id, lastUsedAt: new Date().toISOString() });
		return { ownerSub };
	}

	async listTrainingRuns(
		principal: McpPrincipal,
		input: { readonly status?: string; readonly limit?: number } = {}
	) {
		const limit = boundedLimit(input.limit);
		const filter = ownedFilter(
			principal,
			input.status?.trim() ? { status: { eq: input.status.trim() } } : undefined
		);
		const { data, errors } = await this.client.models.TrainingRun.list({ filter, limit });
		throwDataErrors(errors, 'TrainingRun list failed');
		return (data ?? [])
			.filter((record) => ownedBy(record, principal))
			.map(publicTrainingRun);
	}

	async listModels(
		principal: McpPrincipal,
		input: { readonly stage?: string; readonly limit?: number } = {}
	) {
		const limit = boundedLimit(input.limit);
		const filter = ownedFilter(
			principal,
			input.stage?.trim() ? { stage: { eq: input.stage.trim() } } : undefined
		);
		const { data, errors } = await this.client.models.ModelRegistryItem.list({ filter, limit });
		throwDataErrors(errors, 'ModelRegistryItem list failed');
		return (data ?? [])
			.filter((record) => ownedBy(record, principal))
			.map(publicModel);
	}

	async createModel(principal: McpPrincipal, input: CreateModelInput) {
		const modelType = requiredText(input.modelType, 'model_type').toLowerCase();
		const suppliedConfig = input.runConfig ?? {};
		const suppliedModelType = stringOr(suppliedConfig.model_type) ?? stringOr(suppliedConfig.modelType);
		if (suppliedModelType && suppliedModelType.toLowerCase() !== modelType) {
			throw new Error('model_type must match run_config.model_type/modelType.');
		}
		const parentModelId = input.parentModelId?.trim() || null;
		if (parentModelId) await this.ownedModel(principal, parentModelId);

		const baseName = input.name?.trim() || `${modelTypeLabel(modelType)} draft`;
		const template = validatedModelTemplate(input.template);
		const baseRunConfig: Record<string, unknown> = {
			mode: 'train',
			tournament: 'classic',
			feature_set: 'small',
			neutralization_pct: 25,
			upload: false,
			...suppliedConfig,
			model_type: modelType,
		};
		delete baseRunConfig.modelType;

		const sweep = normalizedSweep(input.sweep);
		const candidates = sweep
			? sweep.values.map((value) => ({
				name: `${baseName} ${sweep.parameter}=${displaySweepValue(value)}`,
				runConfig: { ...baseRunConfig, [sweep.parameter]: value },
				sweep: { parameter: sweep.parameter, value, values: sweep.values },
			}))
			: [{ name: baseName, runConfig: baseRunConfig, sweep: null }];

		const created: ModelRegistryItem[] = [];
		for (const candidate of candidates) {
			const changeSummary = input.changeSummary?.trim() ||
				`${modelTypeLabel(modelType)} ${candidate.sweep ? `${candidate.sweep.parameter}=${displaySweepValue(candidate.sweep.value)}` : 'base'} draft`;
			const { data, errors } = await this.client.models.ModelRegistryItem.create({
				owner: principal.ownerSub,
				name: candidate.name,
				stage: 'draft',
				parentModelId,
				changeSummary,
				numeraiModelId: null,
				lineageJson: {
					source: 'mcp',
					template,
					runConfig: candidate.runConfig,
					sweep: candidate.sweep,
				},
			});
			throwDataErrors(errors, 'ModelRegistryItem create failed');
			if (!data || !ownedBy(data, principal)) {
				throw new Error('ModelRegistryItem create returned no owned data.');
			}
			created.push(data as ModelRegistryItem);
		}
		return { count: created.length, models: created.map(publicModel) };
	}

	async updateModelDraft(principal: McpPrincipal, input: UpdateModelInput) {
		const model = await this.ownedModel(principal, input.modelId);
		const patch: Record<string, unknown> = {};
		if (input.name !== undefined) patch.name = requiredText(input.name, 'name');
		if (input.stage !== undefined) patch.stage = validatedModelStage(input.stage);
		if (input.changeSummary !== undefined) patch.changeSummary = optionalText(input.changeSummary);
		if (input.numeraiModelId !== undefined) patch.numeraiModelId = optionalText(input.numeraiModelId);
		if (input.parentModelId !== undefined) {
			const parentModelId = optionalText(input.parentModelId);
			if (parentModelId === model.id) throw new Error('A model cannot be its own parent.');
			if (parentModelId) await this.ownedModel(principal, parentModelId);
			patch.parentModelId = parentModelId;
		}
		if (input.runConfig !== undefined) {
			const modelType = stringOr(input.runConfig.model_type) ?? stringOr(input.runConfig.modelType);
			if (!modelType) throw new Error('run_config requires model_type or modelType.');
			const lineage = parsedRecord(model.lineageJson) ?? {};
			const runConfig = { ...input.runConfig, model_type: modelType.toLowerCase() };
			delete runConfig.modelType;
			patch.lineageJson = { ...lineage, runConfig };
		}
		if (!Object.keys(patch).length) throw new Error('At least one model field must be provided.');
		return publicModel(await this.updateModel(principal, model, patch));
	}

	async deleteModel(principal: McpPrincipal, input: { readonly modelId: string }) {
		const model = await this.ownedModel(principal, input.modelId);
		const { data, errors } = await this.client.models.ModelRegistryItem.delete({ id: model.id });
		throwDataErrors(errors, 'ModelRegistryItem delete failed');
		if (!data || !ownedBy(data, principal)) throw new Error('ModelRegistryItem delete returned no owned data.');
		return { deleted: true, model: publicModel(data as ModelRegistryItem) };
	}

	async listComputeProviders(
		principal: McpPrincipal,
		input: { readonly providerType?: string; readonly status?: string; readonly limit?: number } = {}
	) {
		const conditions: Record<string, unknown>[] = [];
		if (input.providerType?.trim()) conditions.push({ providerType: { eq: input.providerType.trim() } });
		if (input.status?.trim()) conditions.push({ status: { eq: input.status.trim() } });
		const { data, errors } = await this.client.models.ComputeProvider.list({
			filter: ownedFilter(principal, ...conditions),
			limit: boundedLimit(input.limit),
		});
		throwDataErrors(errors, 'ComputeProvider list failed');
		return (data ?? [])
			.filter((record) => ownedBy(record, principal))
			.map(publicComputeProvider);
	}

	async launchTrainingRun(
		principal: McpPrincipal,
		input: { readonly runId: string; readonly providerId?: string; readonly computeType?: string }
	) {
		const run = await this.ownedRun(principal, input.runId);
		if (run.status === 'running' || run.status === 'completed') {
			throw new Error(`Training run ${run.id} is already ${run.status}.`);
		}
		const provider = await this.ownedProvider(principal, input.providerId ?? run.providerId);
		if (provider.status === 'disabled') throw new Error(`Compute provider ${provider.id} is disabled.`);
		const computeType = input.computeType?.trim().toLowerCase() || null;
		if (computeType && provider.providerType !== 'modal') {
			throw new Error('compute_type is currently supported only for Modal providers.');
		}

		// Local runs are executed by the user's daemon, which claims queued runs
		// through /daemon/poll — the cloud mutation can't reach that machine.
		if (isLocalProvider(provider)) {
			const job = await this.jobForRun(principal, run.id);
			return this.persistAction(
				principal,
				run,
				provider,
				syntheticAction('queued', job, 'Run queued for the local training daemon.'),
				job
			);
		}
		const action = await this.invokeTrainingMutation('start', principal, run, provider, null, computeType);
		return this.persistAction(principal, run, provider, action);
	}

	async launchModelTraining(
		principal: McpPrincipal,
		input: {
			readonly modelId: string;
			readonly providerId: string;
			readonly computeType?: string;
			readonly maxSpendUsd?: number;
		}
	) {
		const model = await this.ownedModel(principal, input.modelId);
		const provider = await this.ownedProvider(principal, input.providerId);
		if (provider.status === 'disabled') throw new Error(`Compute provider ${provider.id} is disabled.`);
		const computeType = input.computeType?.trim().toLowerCase() || undefined;
		if (computeType && provider.providerType !== 'modal') {
			throw new Error('compute_type is currently supported only for Modal providers.');
		}
		const lineage = parsedRecord(model.lineageJson) ?? {};
		const runConfig = parsedRecord(lineage.runConfig) ?? {};
		if (!stringOr(runConfig.model_type) && !stringOr(runConfig.modelType)) {
			throw new Error(`Model ${model.id} has no model_type in lineageJson.runConfig.`);
		}

		const { pipeline, branch } = await this.ensureModelPipeline(principal, model, lineage);
		const { data: run, errors: runErrors } = await this.client.models.TrainingRun.create({
			owner: principal.ownerSub,
			pipelineId: pipeline.id,
			branchId: branch.id,
			providerId: provider.id,
			modelTemplate: modelTemplate(lineage),
			status: 'queued',
			configJson: {
				...runConfig,
				modelId: model.id,
				modelName: model.name,
				sweep: parsedRecord(lineage.sweep) ?? {},
			},
			costUsd: finiteNumber(input.maxSpendUsd),
		});
		throwDataErrors(runErrors, 'TrainingRun create failed');
		if (!run || !ownedBy(run, principal)) throw new Error('TrainingRun create returned no owned data.');

		const linkedModel = await this.updateModel(principal, model, {
			stage: 'training',
			pipelineId: pipeline.id,
			branchId: branch.id,
			runId: run.id,
		});
		const launched = await this.launchTrainingRun(principal, {
			runId: run.id,
			providerId: provider.id,
			computeType,
		});
		const updatedModel = await this.updateModel(principal, linkedModel, {
			stage: modelStage(launched.action.status),
			lineageJson: {
				...lineage,
				lastTrainingAction: launched.action,
			},
		});
		return { model: publicModel(updatedModel), ...launched };
	}

	async pollTrainingStatus(principal: McpPrincipal, input: { readonly runId: string }) {
		const run = await this.ownedRun(principal, input.runId);
		const job = await this.jobForRun(principal, run.id);
		const provider = await this.ownedProvider(principal, job?.providerId ?? run.providerId);
		// Local state is pushed by the daemon; re-invoking the cloud mutation would
		// overwrite it with a synthetic 'queued'. Report what the daemon last wrote.
		if (isLocalProvider(provider)) {
			return {
				action: publicAction(syntheticAction(run.status ?? 'queued', job, run.logTail ?? null, run)),
				run: publicTrainingRun(run),
				job: job ? publicComputeJob(job) : null,
			};
		}
		const action = await this.invokeTrainingMutation('poll', principal, run, provider, job?.providerJobId ?? null);
		return this.persistAction(principal, run, provider, action, job);
	}

	async cancelRun(principal: McpPrincipal, input: { readonly runId: string }) {
		const run = await this.ownedRun(principal, input.runId);
		if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
			throw new Error(`Training run ${run.id} is already ${run.status}.`);
		}
		const job = await this.jobForRun(principal, run.id);
		const provider = await this.ownedProvider(principal, job?.providerId ?? run.providerId);
		if (isLocalProvider(provider)) {
			return this.persistAction(
				principal,
				run,
				provider,
				syntheticAction('cancelled', job, 'Cancellation requested; the local daemon will stop the job.'),
				job
			);
		}
		const action = await this.invokeTrainingMutation(
			'cancel',
			principal,
			run,
			provider,
			job?.providerJobId ?? null
		);
		return this.persistAction(principal, run, provider, action, job);
	}

	/**
	 * Work feed for the local daemon: queued runs on local providers to launch,
	 * and cancelled runs whose local job hasn't reached a terminal state yet.
	 */
	async pollDaemonWork(principal: McpPrincipal) {
		const localProviders = await this.localProviders(principal);
		if (!localProviders.size) return { launches: [], cancels: [] };

		const [queued, cancelled] = await Promise.all([
			this.runsByStatus(principal, 'queued'),
			this.runsByStatus(principal, 'cancelled'),
		]);

		const launches = [];
		for (const run of queued) {
			if (!run.providerId || !localProviders.has(run.providerId)) continue;
			launches.push({
				runId: run.id,
				providerId: run.providerId,
				request: localLaunchRequest(run.id, run.configJson),
			});
		}

		const cancels = [];
		for (const run of cancelled) {
			if (!run.providerId || !localProviders.has(run.providerId)) continue;
			// MCP-launched runs have no ComputeJob row, so the cloud can't tell
			// whether the daemon already acted — the daemon skips cancels whose
			// local job is terminal (or absent), making repeats cheap no-ops.
			const job = await this.jobForRun(principal, run.id);
			if (job && isTerminalStatus(job.status)) continue;
			cancels.push({ runId: run.id, providerJobId: job?.providerJobId ?? null });
		}

		return { launches, cancels };
	}

	/** Persist a status report pushed by the local daemon for an owned local run. */
	async reportDaemonAction(
		principal: McpPrincipal,
		input: { readonly runId?: unknown; readonly action?: unknown }
	) {
		const run = await this.ownedRun(principal, typeof input.runId === 'string' ? input.runId : '');
		const provider = await this.ownedProvider(principal, run.providerId);
		if (!isLocalProvider(provider)) {
			throw new Error(`Training run ${run.id} does not use a local compute provider.`);
		}
		const job = await this.jobForRun(principal, run.id);
		const action = sanitizeReportedAction(input.action, job);
		// A user cancel must stay visible until the daemon acts on it: progress
		// reports that raced the cancel would otherwise resurrect the run and the
		// daemon would never see the cancellation in its work feed.
		if (run.status === 'cancelled' && !isTerminalStatus(action.status)) {
			return {
				action: publicAction(syntheticAction('cancelled', job, run.logTail ?? null, run)),
				run: publicTrainingRun(run),
				job: job ? publicComputeJob(job) : null,
			};
		}
		return this.persistAction(principal, run, provider, action, job);
	}

	private async localProviders(principal: McpPrincipal): Promise<Set<string>> {
		const { data, errors } = await this.client.models.ComputeProvider.list({
			filter: ownedFilter(principal, { providerType: { eq: 'local' } }),
			limit: 50,
		});
		throwDataErrors(errors, 'ComputeProvider list failed');
		const providers = (data ?? []).filter((record) => ownedBy(record, principal)) as ComputeProvider[];
		await Promise.all(providers.map((provider) => this.touchDaemonHeartbeat(provider)));
		return new Set(providers.map((provider) => provider.id));
	}

	private async ensureModelPipeline(
		principal: McpPrincipal,
		model: ModelRegistryItem,
		lineage: Record<string, unknown>
	): Promise<{ readonly pipeline: Pipeline; readonly branch: ModelBranch }> {
		if (model.pipelineId && model.branchId) {
			const [pipelineResult, branchResult] = await Promise.all([
				this.client.models.Pipeline.get({ id: model.pipelineId }),
				this.client.models.ModelBranch.get({ id: model.branchId }),
			]);
			throwDataErrors(pipelineResult.errors, 'Pipeline lookup failed');
			throwDataErrors(branchResult.errors, 'ModelBranch lookup failed');
			if (
				pipelineResult.data && ownedBy(pipelineResult.data, principal) &&
				branchResult.data && ownedBy(branchResult.data, principal)
			) {
				return { pipeline: pipelineResult.data as Pipeline, branch: branchResult.data as ModelBranch };
			}
		}

		const graphJson = { lineage };
		const pipelineResult = await this.client.models.Pipeline.create({
			owner: principal.ownerSub,
			name: model.name,
			description: model.changeSummary ?? 'Model draft launched through MCP.',
			status: 'testing',
			template: modelTemplate(lineage),
			graphJson,
		});
		throwDataErrors(pipelineResult.errors, 'Pipeline create failed');
		if (!pipelineResult.data || !ownedBy(pipelineResult.data, principal)) {
			throw new Error('Pipeline create returned no owned data.');
		}
		const pipeline = pipelineResult.data as Pipeline;

		const branchResult = await this.client.models.ModelBranch.create({
			owner: principal.ownerSub,
			pipelineId: pipeline.id,
			name: `${model.name}-mcp`,
			changeSummary: model.changeSummary ?? 'Model draft launch branch created through MCP.',
			graphJson,
			status: 'queued',
		});
		throwDataErrors(branchResult.errors, 'ModelBranch create failed');
		if (!branchResult.data || !ownedBy(branchResult.data, principal)) {
			throw new Error('ModelBranch create returned no owned data.');
		}
		const branch = branchResult.data as ModelBranch;

		const updateResult = await this.client.models.Pipeline.update({ id: pipeline.id, activeBranchId: branch.id });
		throwDataErrors(updateResult.errors, 'Pipeline update failed');
		if (!updateResult.data || !ownedBy(updateResult.data, principal)) {
			throw new Error('Pipeline update returned no owned data.');
		}
		return { pipeline: updateResult.data as Pipeline, branch };
	}

	private async ownedModel(principal: McpPrincipal, modelId: string): Promise<ModelRegistryItem> {
		const { data, errors } = await this.client.models.ModelRegistryItem.get({ id: requiredId(modelId, 'model_id') });
		throwDataErrors(errors, 'ModelRegistryItem lookup failed');
		if (!data || !ownedBy(data, principal)) throw new Error('Model not found.');
		return data as ModelRegistryItem;
	}

	private async updateModel(
		principal: McpPrincipal,
		model: ModelRegistryItem,
		patch: Record<string, unknown>
	): Promise<ModelRegistryItem> {
		const { data, errors } = await this.client.models.ModelRegistryItem.update({ id: model.id, ...patch });
		throwDataErrors(errors, 'ModelRegistryItem update failed');
		if (!data || !ownedBy(data, principal)) throw new Error('ModelRegistryItem update returned no owned data.');
		return data as ModelRegistryItem;
	}

	/**
	 * Each daemon poll refreshes the provider's verifiedAt so the settings UI
	 * can show a live "daemon is polling" indicator. Throttled to one write per
	 * minute per provider; a stale verifiedAt means the daemon is offline.
	 */
	private async touchDaemonHeartbeat(provider: ComputeProvider): Promise<void> {
		const last = provider.verifiedAt ? Date.parse(provider.verifiedAt) : 0;
		if (Number.isFinite(last) && Date.now() - last < 60_000) return;
		const { errors } = await this.client.models.ComputeProvider.update({
			id: provider.id,
			verifiedAt: new Date().toISOString(),
			lastVerifyError: null,
		});
		throwDataErrors(errors, 'ComputeProvider heartbeat failed');
	}

	private async runsByStatus(principal: McpPrincipal, status: string): Promise<TrainingRun[]> {
		const { data, errors } = await this.client.models.TrainingRun.list({
			filter: ownedFilter(principal, { status: { eq: status } }),
			limit: 50,
		});
		throwDataErrors(errors, 'TrainingRun list failed');
		return (data ?? []).filter((record) => ownedBy(record, principal)) as TrainingRun[];
	}

	async listSubmissions(
		principal: McpPrincipal,
		input: { readonly modelId?: string; readonly status?: string; readonly limit?: number } = {}
	) {
		const conditions: Record<string, unknown>[] = [];
		if (input.modelId?.trim()) conditions.push({ modelId: { eq: input.modelId.trim() } });
		if (input.status?.trim()) conditions.push({ status: { eq: input.status.trim() } });
		const filter = ownedFilter(principal, ...conditions);
		const { data, errors } = await this.client.models.ModelSubmission.list({
			filter,
			limit: boundedLimit(input.limit),
		});
		throwDataErrors(errors, 'ModelSubmission list failed');
		return (data ?? [])
			.filter((record) => ownedBy(record, principal))
			.map(publicSubmission);
	}

	private async ownedRun(principal: McpPrincipal, id: string): Promise<TrainingRun> {
		const runId = requiredId(id, 'run_id');
		const { data, errors } = await this.client.models.TrainingRun.get({ id: runId });
		throwDataErrors(errors, 'TrainingRun lookup failed');
		if (!data || !ownedBy(data, principal)) throw new Error(`Training run ${runId} was not found.`);
		return data as TrainingRun;
	}

	private async ownedProvider(
		principal: McpPrincipal,
		id: string | null | undefined
	): Promise<ComputeProvider> {
		const providerId = requiredId(id, 'provider_id');
		const { data, errors } = await this.client.models.ComputeProvider.get({ id: providerId });
		throwDataErrors(errors, 'ComputeProvider lookup failed');
		if (!data || !ownedBy(data, principal)) throw new Error(`Compute provider ${providerId} was not found.`);
		return data as ComputeProvider;
	}

	private async jobForRun(principal: McpPrincipal, runId: string): Promise<ComputeJob | null> {
		const { data, errors } = await this.client.models.ComputeJob.list({
			filter: ownedFilter(principal, { runId: { eq: runId } }),
			limit: 20,
		});
		throwDataErrors(errors, 'ComputeJob lookup failed');
		return (
			(data ?? [])
				.filter((record) => ownedBy(record, principal))
				.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))[0] ?? null
		) as ComputeJob | null;
	}

	private async invokeTrainingMutation(
		operation: 'start' | 'poll' | 'cancel',
		principal: McpPrincipal,
		run: TrainingRun,
		provider: ComputeProvider,
		providerJobId: string | null,
		computeType: string | null = null
	): Promise<TrainingActionResult> {
		const baseArgs = {
			runId: run.id,
			providerId: provider.id,
			providerType: provider.providerType ?? 'custom',
			apiKeyRef: provider.apiKeyRef ?? null,
			apiSecretRef: provider.apiSecretRef ?? null,
			baseUrl: provider.baseUrl ?? null,
			workspaceId: provider.workspaceId ?? null,
			providerConfigJson:
				operation === 'start'
					? providerConfigForMcpLaunch(run, provider, computeType)
					: serializeAwsJson(provider.credentialsJson),
			ownerSub: principal.ownerSub,
		};
		const result =
			operation === 'start'
				? await this.client.mutations.startTraining(baseArgs)
				: operation === 'poll'
					? await this.client.mutations.pollTrainingStatus({ ...baseArgs, providerJobId })
					: await this.client.mutations.cancelTraining({ ...baseArgs, providerJobId });
		throwDataErrors(result.errors, `${operation} training mutation failed`);
		if (!result.data) throw new Error(`${operation} training mutation returned no data.`);
		return result.data as TrainingActionResult;
	}

	private async persistAction(
		principal: McpPrincipal,
		run: TrainingRun,
		provider: ComputeProvider,
		action: TrainingActionResult,
		existingJob?: ComputeJob | null
	) {
		const runPatch = trainingRunPatch(run, provider, action);
		const { data: updatedRun, errors: runErrors } = await this.client.models.TrainingRun.update(runPatch);
		throwDataErrors(runErrors, 'TrainingRun update failed');
		if (!updatedRun || !ownedBy(updatedRun, principal)) throw new Error('TrainingRun update returned no data.');

		// Update the run's ComputeJob when the browser created one. The Lambda
		// cannot create job rows itself: CreateComputeJobInput has no owner field
		// (owner is auto-set only for user-pool writes), so an IAM-side create
		// either fails or produces an unowned row. The TrainingRun row carries
		// all state the UI and MCP tools read.
		const job = existingJob ?? (await this.jobForRun(principal, run.id));
		let updatedJob: ComputeJob | null = null;
		if (job) {
			const jobResult = await this.client.models.ComputeJob.update({
				id: job.id,
				providerId: provider.id,
				...computeJobPatch(action),
			});
			throwDataErrors(jobResult.errors, 'ComputeJob write failed');
			if (!jobResult.data || !ownedBy(jobResult.data, principal)) throw new Error('ComputeJob write returned no data.');
			updatedJob = jobResult.data as ComputeJob;
		}

		return {
			action: publicAction(action),
			run: publicTrainingRun(updatedRun as TrainingRun),
			job: updatedJob ? publicComputeJob(updatedJob) : null,
		};
	}
}

export function hashMcpApiKey(rawKey: string): string {
	return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

function isLocalProvider(provider: ComputeProvider): boolean {
	return (provider.providerType ?? 'custom') === 'local';
}

function isTerminalStatus(status: string | null | undefined): boolean {
	return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function syntheticAction(
	status: string,
	job: ComputeJob | null,
	logTail: string | null,
	run?: TrainingRun
): TrainingActionResult {
	return {
		ok: status !== 'failed',
		status: normalizeStatus(status),
		providerJobId: job?.providerJobId ?? null,
		checkedAt: new Date().toISOString(),
		logTail,
		error: null,
		costUsd: run?.costUsd ?? null,
		metricsJson: run?.metricsJson ?? null,
		artifactUri: run?.artifactUri ?? null,
	} as TrainingActionResult;
}

/**
 * Build the daemon /launch request from a run's configJson — mirrors the
 * frontend's localLaunchRequest so browser- and daemon-claimed runs behave
 * identically. Config may nest local settings under a `local` key.
 */
export function localLaunchRequest(runId: string, configJson: unknown): Record<string, unknown> {
	const root = parsedRecord(configJson) ?? {};
	const local = parsedRecord(root.local) ?? root;
	const inferredHyperparams = Object.fromEntries(
		Object.entries(local).filter(([key]) => !LOCAL_RUN_CONFIG_FIELDS.has(key))
	);
	return {
		runId,
		model_type: stringOr(local.model_type) ?? stringOr(local.modelType) ?? 'mlp',
		feature_set: stringOr(local.feature_set) ?? stringOr(local.featureSet) ?? 'small',
		neutralization_pct: numberOr(local.neutralization_pct) ?? numberOr(local.neutralizationPct) ?? 25,
		hyperparams: {
			...inferredHyperparams,
			...(parsedRecord(local.hyperparams) ?? {}),
		},
		upload: local.upload === true,
	};
}

const LOCAL_RUN_CONFIG_FIELDS = new Set([
	'mode',
	'tournament',
	'model_type',
	'modelType',
	'feature_set',
	'featureSet',
	'neutralization_pct',
	'neutralizationPct',
	'upload',
	'hyperparams',
	'modelId',
	'modelName',
	'sweep',
]);

const MAX_REPORT_TEXT = 8000;

function sanitizeReportedAction(raw: unknown, job: ComputeJob | null): TrainingActionResult {
	const record = asRecord(raw);
	if (!record || typeof record.status !== 'string') {
		throw new Error('A daemon report requires an action with a status.');
	}
	return {
		ok: record.ok !== false,
		status: normalizeStatus(record.status),
		providerJobId: stringOr(record.providerJobId) ?? job?.providerJobId ?? null,
		checkedAt: stringOr(record.checkedAt) ?? new Date().toISOString(),
		logTail: clampText(record.logTail),
		error: clampText(record.error),
		costUsd: numberOr(record.costUsd),
		metricsJson: asRecord(record.metricsJson),
		artifactUri: clampText(record.artifactUri),
	} as TrainingActionResult;
}

function clampText(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	return value.length > MAX_REPORT_TEXT ? value.slice(-MAX_REPORT_TEXT) : value;
}

function parsedRecord(value: unknown): Record<string, unknown> | null {
	const direct = asRecord(value);
	if (direct) return direct;
	if (typeof value !== 'string') return null;
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function stringOr(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOr(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredText(value: string | null | undefined, name: string): string {
	const text = value?.trim();
	if (!text) throw new Error(`${name} is required.`);
	return text;
}

function optionalText(value: string | null | undefined): string | null {
	return value?.trim() || null;
}

function validatedModelTemplate(value: string | null | undefined): 'baseline' | 'challenger' | 'ensemble' | 'custom' {
	const normalized = value?.trim().toLowerCase() || 'custom';
	if (normalized === 'baseline' || normalized === 'challenger' || normalized === 'ensemble' || normalized === 'custom') {
		return normalized;
	}
	throw new Error('template must be baseline, challenger, ensemble, or custom.');
}

function validatedModelStage(value: string): 'draft' | 'training' | 'success' | 'failed' | 'testing' | 'live' | 'retired' {
	const normalized = value.trim().toLowerCase();
	if (
		normalized === 'draft' || normalized === 'training' || normalized === 'success' ||
		normalized === 'failed' || normalized === 'testing' || normalized === 'live' || normalized === 'retired'
	) return normalized;
	throw new Error('stage must be draft, training, success, failed, testing, live, or retired.');
}

function normalizedSweep(input: CreateModelInput['sweep']): {
	readonly parameter: string;
	readonly values: readonly (string | number | boolean)[];
} | null {
	if (!input) return null;
	const parameter = requiredText(input.parameter, 'sweep.parameter');
	const maxRuns = Math.max(1, Math.min(64, Math.trunc(input.maxRuns ?? input.values.length)));
	const values = input.values.slice(0, maxRuns);
	if (!values.length) throw new Error('sweep.values requires at least one value.');
	if (values.some((value) => typeof value === 'number' && !Number.isFinite(value))) {
		throw new Error('sweep.values numbers must be finite.');
	}
	return { parameter, values };
}

function displaySweepValue(value: string | number | boolean): string {
	return typeof value === 'string' ? value : String(value);
}

function modelTypeLabel(modelType: string): string {
	const labels: Record<string, string> = {
		lgbm: 'LightGBM',
		xgboost: 'XGBoost',
		catboost: 'CatBoost',
		mlp: 'MLP',
		ft_transformer: 'FT-Transformer',
		modern_nca: 'ModernNCA',
		tabm: 'TabM',
		tabpfn: 'TabPFN',
		tabicl: 'TabICL',
	};
	return labels[modelType] ?? modelType;
}

function modelTemplate(lineage: Record<string, unknown>): 'baseline' | 'challenger' | 'ensemble' | 'custom' {
	const template = lineage.template;
	return template === 'baseline' || template === 'challenger' || template === 'ensemble'
		? template
		: 'custom';
}

function modelStage(status: string): 'training' | 'success' | 'failed' {
	const normalized = normalizeStatus(status);
	if (normalized === 'completed') return 'success';
	if (normalized === 'failed' || normalized === 'cancelled') return 'failed';
	return 'training';
}

export function ownerSub(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const sub = value.split('::', 1)[0]?.trim();
	return sub || null;
}

function ownerSubFromRecord(record: unknown): string | null {
	return ownerSub(asRecord(record)?.owner);
}

function ownedBy(record: unknown, principal: McpPrincipal): boolean {
	return ownerSubFromRecord(record) === principal.ownerSub;
}

function ownedFilter(
	principal: McpPrincipal,
	...conditions: (Record<string, unknown> | undefined)[]
): Record<string, unknown> {
	const owner = {
		or: [
			{ owner: { eq: principal.ownerSub } },
			{ owner: { beginsWith: `${principal.ownerSub}::` } },
		],
	};
	const active = conditions.filter((condition): condition is Record<string, unknown> => Boolean(condition));
	return active.length ? { and: [owner, ...active] } : owner;
}

function isMcpApiKey(value: string | null | undefined): value is string {
	return typeof value === 'string' && /^nd_mcp_[A-Za-z0-9_-]{32,}$/.test(value);
}

function boundedLimit(value: number | undefined): number {
	if (!Number.isFinite(value)) return 20;
	return Math.max(1, Math.min(100, Math.trunc(value ?? 20)));
}

function requiredId(value: string | null | undefined, name: string): string {
	const id = value?.trim();
	if (!id) throw new Error(`${name} is required.`);
	return id;
}

function normalizeStatus(status: string): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
	switch (status) {
		case 'running':
		case 'started':
			return 'running';
		case 'completed':
		case 'complete':
		case 'succeeded':
		case 'success':
			return 'completed';
		case 'failed':
		case 'error':
			return 'failed';
		case 'cancelled':
		case 'canceled':
			return 'cancelled';
		default:
			return 'queued';
	}
}

function trainingRunPatch(run: TrainingRun, provider: ComputeProvider, action: TrainingActionResult) {
	const status = normalizeStatus(action.status);
	const terminal = ['completed', 'failed', 'cancelled'].includes(status);
	return {
		id: run.id,
		// provider_id is an explicit launch override. Persist it so later polls,
		// cancellation, UI state, and local-daemon claims use the actual provider.
		providerId: provider.id,
		status,
		...(status === 'running' ? { startedAt: run.startedAt ?? action.checkedAt } : {}),
		...(terminal ? { finishedAt: action.checkedAt } : {}),
		logTail: action.logTail ?? action.error ?? null,
		costUsd: action.costUsd ?? null,
		metricsJson: action.metricsJson ?? null,
		artifactUri: action.artifactUri ?? null,
	};
}

function computeJobPatch(action: TrainingActionResult) {
	const status = normalizeStatus(action.status);
	const terminal = ['completed', 'failed', 'cancelled'].includes(status);
	return {
		status,
		providerJobId: action.providerJobId ?? null,
		...(status === 'running' ? { startedAt: action.checkedAt } : {}),
		...(terminal ? { finishedAt: action.checkedAt } : {}),
		logTail: action.logTail ?? action.error ?? null,
		actualCostUsd: action.costUsd ?? null,
	};
}

function publicTrainingRun(run: TrainingRun) {
	return {
		id: run.id,
		pipelineId: run.pipelineId,
		branchId: run.branchId ?? null,
		providerId: run.providerId ?? null,
		modelTemplate: run.modelTemplate ?? null,
		status: run.status ?? null,
		configJson: run.configJson ?? null,
		metricsJson: run.metricsJson ?? null,
		costUsd: run.costUsd ?? null,
		startedAt: run.startedAt ?? null,
		finishedAt: run.finishedAt ?? null,
		logTail: run.logTail ?? null,
		artifactUri: run.artifactUri ?? null,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
	};
}

function publicModel(model: ModelRegistryItem) {
	const lineage = parsedRecord(model.lineageJson) ?? {};
	const runConfig = parsedRecord(lineage.runConfig) ?? {};
	return {
		id: model.id,
		name: model.name,
		stage: model.stage ?? null,
		pipelineId: model.pipelineId ?? null,
		branchId: model.branchId ?? null,
		runId: model.runId ?? null,
		parentModelId: model.parentModelId ?? null,
		changeSummary: model.changeSummary ?? null,
		modelType: stringOr(runConfig.model_type) ?? stringOr(runConfig.modelType),
		runConfig,
		createdAt: model.createdAt,
		updatedAt: model.updatedAt,
	};
}

function publicComputeProvider(provider: ComputeProvider) {
	return {
		id: provider.id,
		name: provider.name,
		providerType: provider.providerType ?? null,
		status: provider.status ?? null,
		baseUrl: provider.baseUrl ?? null,
		workspaceId: provider.workspaceId ?? null,
		awsRegion: provider.awsRegion ?? null,
		verifiedAt: provider.verifiedAt ?? null,
		lastVerifyError: provider.lastVerifyError ?? null,
		monthlyBudgetUsd: provider.monthlyBudgetUsd ?? null,
		defaultRunCapUsd: provider.defaultRunCapUsd ?? null,
		maxConcurrentJobs: provider.maxConcurrentJobs ?? null,
		notes: provider.notes ?? null,
		createdAt: provider.createdAt,
		updatedAt: provider.updatedAt,
	};
}

function publicComputeJob(job: ComputeJob) {
	return {
		id: job.id,
		runId: job.runId ?? null,
		providerId: job.providerId ?? null,
		providerJobId: job.providerJobId ?? null,
		name: job.name,
		status: job.status ?? null,
		actualCostUsd: job.actualCostUsd ?? null,
		startedAt: job.startedAt ?? null,
		finishedAt: job.finishedAt ?? null,
		logTail: job.logTail ?? null,
		updatedAt: job.updatedAt,
	};
}

function publicSubmission(submission: ModelSubmission) {
	return {
		id: submission.id,
		modelId: submission.modelId,
		providerId: submission.providerId ?? null,
		roundNumber: submission.roundNumber ?? null,
		status: submission.status ?? null,
		externalSubmissionId: submission.externalSubmissionId ?? null,
		artifactUri: submission.artifactUri ?? null,
		notes: submission.notes ?? null,
		submittedAt: submission.submittedAt ?? null,
		createdAt: submission.createdAt,
		updatedAt: submission.updatedAt,
	};
}

function publicAction(action: TrainingActionResult) {
	return {
		ok: action.ok,
		status: action.status,
		providerJobId: action.providerJobId ?? null,
		checkedAt: action.checkedAt,
		logTail: action.logTail ?? null,
		error: action.error ?? null,
		costUsd: action.costUsd ?? null,
		metricsJson: action.metricsJson ?? null,
		artifactUri: action.artifactUri ?? null,
	};
}

function serializeAwsJson(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return typeof value === 'string' ? value : JSON.stringify(value);
}

const RUN_CONFIG_METADATA_KEYS = new Set([
	'modelId',
	'modelName',
	'sweep',
	'modal',
	'local',
	'primeIntellect',
	'prime_intellect',
	'computeType',
	'gpuType',
	'gpu',
	'hyperparams',
]);

/**
 * MCP launches do not pass through the browser's providerConfigForLaunch.
 * Compose the Modal launch payload here so the run keeps its hyperparameters
 * and the MCP caller can explicitly request CPU compute.
 */
function providerConfigForMcpLaunch(
	run: TrainingRun,
	provider: ComputeProvider,
	computeType: string | null
): string | null {
	if (provider.providerType !== 'modal') return serializeAwsJson(provider.credentialsJson);

	const providerRoot = parsedRecord(provider.credentialsJson) ?? {};
	const providerModal = parsedRecord(providerRoot.modal) ?? {};
	const runRoot = parsedRecord(run.configJson) ?? {};
	const runModal = parsedRecord(runRoot.modal) ?? {};
	const topLevelHyperparams = Object.fromEntries(
		Object.entries(runRoot).filter(([key]) => !RUN_CONFIG_METADATA_KEYS.has(key))
	);
	const hyperparams = {
		...(parsedRecord(providerModal.hyperparams) ?? {}),
		...topLevelHyperparams,
		...(parsedRecord(runRoot.hyperparams) ?? {}),
		...(parsedRecord(runModal.hyperparams) ?? {}),
	};
	const selectedCompute =
		computeType ??
		stringOr(runModal.computeType) ??
		stringOr(runModal.gpuType) ??
		stringOr(runModal.gpu) ??
		stringOr(runRoot.computeType) ??
		stringOr(runRoot.gpuType) ??
		stringOr(runRoot.gpu);

	return JSON.stringify({
		...providerRoot,
		modal: {
			...providerModal,
			...runModal,
			...(selectedCompute ? { gpuType: selectedCompute.toLowerCase() } : {}),
			hyperparams,
		},
	});
}

function timestamp(value: string | null | undefined): number {
	const parsed = value ? Date.parse(value) : 0;
	return Number.isFinite(parsed) ? parsed : 0;
}

function throwDataErrors(errors: readonly { readonly message?: string | null }[] | undefined, fallback: string): void {
	if (!errors?.length) return;
	throw new Error(errors.map((error) => error.message).filter(Boolean).join('; ') || fallback);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
