import { dataClient } from '$lib/data';
import type { Schema } from '../../../amplify/data/resource';
import { graphSnapshot } from './pipeline-service';

type Client = ReturnType<typeof dataClient>;

export type DemoSeedSummary = {
	readonly created: number;
	readonly reused: number;
	readonly numeraiAccountId: string;
	readonly providerId: string;
	readonly pipelineId: string;
	readonly branchId: string;
	readonly sweepPlanId: string;
	readonly trainingRunId: string;
	readonly computeJobId: string;
	readonly modelId: string;
	readonly submissionId: string;
	readonly roundDatasetId: string;
};

type Pipeline = Schema['Pipeline']['type'];
type ModelBranch = Schema['ModelBranch']['type'];
type SweepPlan = Schema['SweepPlan']['type'];
type TrainingRun = Schema['TrainingRun']['type'];
type ComputeProvider = Schema['ComputeProvider']['type'];
type ComputeJob = Schema['ComputeJob']['type'];
type ModelRegistryItem = Schema['ModelRegistryItem']['type'];
type ModelSubmission = Schema['ModelSubmission']['type'];
type RoundDataset = Schema['RoundDataset']['type'];
type NumeraiAccount = Schema['NumeraiAccount']['type'];

const now = '2026-05-23T00:00:00.000Z';

export const demoSeedNames = {
	numeraiPublicId: 'demo-numerai-public-id',
	provider: 'Demo Local GPU',
	pipeline: 'Demo Numerai baseline pipeline',
	branch: 'demo-baseline-root',
	sweepPlan: 'demo learning_rate sweep',
	model: 'Demo Baseline v1',
	computeJob: 'demo baseline learning_rate=0.01',
} as const;

export function demoPipelineGraph(providerId: string | null) {
	return graphSnapshot(
		'baseline',
		[
			{ id: 'data', type: 'input', position: { x: 0, y: 80 }, data: { label: 'Numerai v5.2 data' } },
			{ id: 'train', type: 'model', position: { x: 280, y: 80 }, data: { label: 'LightGBM baseline' } },
			{
				id: 'submit',
				type: 'predict',
				position: { x: 560, y: 80 },
				data: { label: 'Ranked live predictions' }
			}
		],
		[
			{ id: 'data-train', source: 'data', target: 'train' },
			{ id: 'train-submit', source: 'train', target: 'submit' }
		],
		providerId
	);
}

export async function seedDemoWorkspace(client: Client = dataClient()): Promise<DemoSeedSummary> {
	const counter = { created: 0, reused: 0 };
	const numeraiAccount = await ensureNumeraiAccount(client, counter);
	const provider = await ensureComputeProvider(client, counter);
	const { pipeline, branch } = await ensurePipelineAndBranch(client, provider.id, counter);
	const sweepPlan = await ensureSweepPlan(client, pipeline.id, branch.id, provider.id, counter);
	const trainingRun = await ensureTrainingRun(client, pipeline.id, branch.id, provider.id, sweepPlan.id, counter);
	const computeJob = await ensureComputeJob(client, trainingRun.id, provider.id, counter);
	const model = await ensureModel(client, pipeline.id, branch.id, trainingRun.id, counter);
	const roundDataset = await ensureRoundDataset(client, counter);
	const submission = await ensureModelSubmission(
		client,
		model.id,
		provider.id,
		numeraiAccount.id,
		roundDataset.roundNumber,
		counter
	);

	return {
		created: counter.created,
		reused: counter.reused,
		numeraiAccountId: numeraiAccount.id,
		providerId: provider.id,
		pipelineId: pipeline.id,
		branchId: branch.id,
		sweepPlanId: sweepPlan.id,
		trainingRunId: trainingRun.id,
		computeJobId: computeJob.id,
		modelId: model.id,
		submissionId: submission.id,
		roundDatasetId: roundDataset.id,
	};
}

async function ensureNumeraiAccount(client: Client, counter: Counter): Promise<NumeraiAccount> {
	const { data } = await client.models.NumeraiAccount.list();
	const existing = (data ?? []).find((item) => item.publicId === demoSeedNames.numeraiPublicId);
	if (existing) return reused(existing as NumeraiAccount, counter);
	const created = await createRequired(client.models.NumeraiAccount, {
		label: 'Demo Numerai account',
		publicId: demoSeedNames.numeraiPublicId,
		secretRef: '/numeraidashboard/demo/numerai/secret-key',
		verifiedAt: now,
		lastVerifyError: null,
	});
	return made(created as NumeraiAccount, counter);
}

async function ensureComputeProvider(client: Client, counter: Counter): Promise<ComputeProvider> {
	const { data } = await client.models.ComputeProvider.list();
	const existing = (data ?? []).find((item) => item.name === demoSeedNames.provider);
	if (existing) return reused(existing as ComputeProvider, counter);
	const created = await createRequired(client.models.ComputeProvider, {
		name: demoSeedNames.provider,
		providerType: 'local',
		status: 'available',
		verifiedAt: now,
		monthlyBudgetUsd: 250,
		defaultRunCapUsd: 18,
		maxConcurrentJobs: 2,
		notes: 'Demo data: local provider placeholder for frontend walkthroughs.',
	});
	return made(created as ComputeProvider, counter);
}

async function ensurePipelineAndBranch(
	client: Client,
	providerId: string,
	counter: Counter
): Promise<{ readonly pipeline: Pipeline; readonly branch: ModelBranch }> {
	const { data: pipelines } = await client.models.Pipeline.list();
	let pipeline = (pipelines ?? []).find((item) => item.name === demoSeedNames.pipeline) as Pipeline | undefined;
	if (pipeline) {
		counter.reused += 1;
	} else {
		pipeline = made(
			(await createRequired(client.models.Pipeline, {
				name: demoSeedNames.pipeline,
				description: 'Demo data: baseline pipeline seeded through Amplify models.',
				status: 'testing',
				template: 'baseline',
				defaultProviderId: providerId,
				graphJson: demoPipelineGraph(providerId),
				lastRunAt: now,
			})) as Pipeline,
			counter
		);
	}
	if (!pipeline) throw new Error('Demo seed could not create or reuse a pipeline');
	const pipelineRecord = pipeline;

	const { data: branches } = await client.models.ModelBranch.list();
	let branch = (branches ?? []).find(
		(item) => item.pipelineId === pipelineRecord.id && item.name === demoSeedNames.branch
	) as ModelBranch | undefined;
	if (branch) {
		counter.reused += 1;
	} else {
		branch = made(
			(await createRequired(client.models.ModelBranch, {
				pipelineId: pipelineRecord.id,
				name: demoSeedNames.branch,
				changeSummary: 'Demo data: root baseline graph.',
				graphJson: demoPipelineGraph(providerId),
				score: 0.0234,
				status: 'completed',
			})) as ModelBranch,
			counter
		);
	}

	if (pipelineRecord.activeBranchId !== branch.id) {
		await client.models.Pipeline.update({ id: pipelineRecord.id, activeBranchId: branch.id });
		pipeline = { ...pipelineRecord, activeBranchId: branch.id };
	}

	return { pipeline, branch };
}

async function ensureSweepPlan(
	client: Client,
	pipelineId: string,
	branchId: string,
	providerId: string,
	counter: Counter
): Promise<SweepPlan> {
	const { data } = await client.models.SweepPlan.list();
	const existing = (data ?? []).find(
		(item) => item.pipelineId === pipelineId && item.branchId === branchId && item.name === demoSeedNames.sweepPlan
	);
	if (existing) return reused(existing as SweepPlan, counter);
	const created = await createRequired(client.models.SweepPlan, {
		pipelineId,
		branchId,
		name: demoSeedNames.sweepPlan,
		parameter: 'learning_rate',
		valuesJson: ['0.01', '0.03', '0.05'],
		maxRuns: 3,
		maxSpendUsd: 54,
		providerId,
		status: 'queued',
		generatedRunCount: 3,
	});
	return made(created as SweepPlan, counter);
}

async function ensureTrainingRun(
	client: Client,
	pipelineId: string,
	branchId: string,
	providerId: string,
	sweepPlanId: string,
	counter: Counter
): Promise<TrainingRun> {
	const { data } = await client.models.TrainingRun.list();
	const existing = (data ?? []).find(
		(item) =>
			item.pipelineId === pipelineId &&
			item.branchId === branchId &&
			(item.configJson as { demoSeed?: boolean } | null)?.demoSeed === true
	);
	if (existing) return reused(existing as TrainingRun, counter);
	const created = await createRequired(client.models.TrainingRun, {
		pipelineId,
		branchId,
		providerId,
		modelTemplate: 'baseline',
		status: 'queued',
		configJson: { demoSeed: true, sweepPlanId, parameter: 'learning_rate', value: '0.01' },
		metricsJson: { validationCorr: 0.0218, validationMmc: 0.0084 },
		costUsd: 18,
		logTail: 'Demo data: queued baseline training run.',
	});
	return made(created as TrainingRun, counter);
}

async function ensureComputeJob(
	client: Client,
	runId: string,
	providerId: string,
	counter: Counter
): Promise<ComputeJob> {
	const { data } = await client.models.ComputeJob.list();
	const existing = (data ?? []).find((item) => item.runId === runId && item.name === demoSeedNames.computeJob);
	if (existing) return reused(existing as ComputeJob, counter);
	const created = await createRequired(client.models.ComputeJob, {
		providerId,
		runId,
		name: demoSeedNames.computeJob,
		status: 'planned',
		estimatedCostUsd: 18,
		logTail: 'Demo data: planned local provider job.',
	});
	return made(created as ComputeJob, counter);
}

async function ensureModel(
	client: Client,
	pipelineId: string,
	branchId: string,
	runId: string,
	counter: Counter
): Promise<ModelRegistryItem> {
	const { data } = await client.models.ModelRegistryItem.list();
	const existing = (data ?? []).find((item) => item.name === demoSeedNames.model);
	if (existing) return reused(existing as ModelRegistryItem, counter);
	const created = await createRequired(client.models.ModelRegistryItem, {
		name: demoSeedNames.model,
		stage: 'testing',
		pipelineId,
		branchId,
		runId,
		changeSummary: 'Demo data: baseline model seeded for UI walkthroughs.',
		numeraiModelId: 'demo-numerai-model-id',
		liveCorr: 0.0234,
		liveMmc: 0.0111,
		payoutNmr: 1.25,
		lastSubmittedRound: 842,
		lastSubmittedAt: now,
		lineageJson: { demoSeed: true, parent: null },
	});
	return made(created as ModelRegistryItem, counter);
}

async function ensureRoundDataset(client: Client, counter: Counter): Promise<RoundDataset> {
	const { data } = await client.models.RoundDataset.list();
	const existing = (data ?? []).find((item) => item.roundNumber === 842);
	if (existing) return reused(existing as RoundDataset, counter);
	const created = await createRequired(client.models.RoundDataset, {
		roundNumber: 842,
		status: 'scored',
		openAt: '2026-05-21T00:00:00.000Z',
		closeAt: '2026-05-28T00:00:00.000Z',
		datasetVersion: 'v5.2',
		liveDataUri: 'numerai://rounds/842/live.parquet',
		cachedAt: now,
		staleAfter: '2026-05-30T00:00:00.000Z',
	});
	return made(created as RoundDataset, counter);
}

async function ensureModelSubmission(
	client: Client,
	modelId: string,
	providerId: string,
	numeraiAccountId: string,
	roundNumber: number,
	counter: Counter
): Promise<ModelSubmission> {
	const { data } = await client.models.ModelSubmission.list();
	const existing = (data ?? []).find((item) => item.modelId === modelId && item.roundNumber === roundNumber);
	if (existing) return reused(existing as ModelSubmission, counter);
	const created = await createRequired(client.models.ModelSubmission, {
		modelId,
		providerId,
		numeraiAccountId,
		externalSubmissionId: 'demo-submission-842',
		roundNumber,
		status: 'completed',
		predictionSet: 'live',
		neutralizationPct: 50,
		validationMode: 'schema_range_rank',
		uploadEnabled: false,
		artifactUri: 'artifact://numeraidashboard/demo/model-1/round-842/predictions.csv',
		notes: 'Demo data: completed export-only submission history.',
		submittedAt: now,
	});
	return made(created as ModelSubmission, counter);
}

type Counter = { created: number; reused: number };

function made<T>(value: T, counter: Counter): T {
	counter.created += 1;
	return value;
}

function reused<T>(value: T, counter: Counter): T {
	counter.reused += 1;
	return value;
}

async function createRequired<TModel extends { create(input: unknown): Promise<{ data?: unknown }> }>(
	model: TModel,
	input: unknown
): Promise<unknown> {
	const { data } = await model.create(input);
	if (!data) throw new Error('Demo seed create returned no data');
	return data;
}
