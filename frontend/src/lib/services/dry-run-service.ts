import { dataClient } from '$lib/data';
import { listNumeraiAccounts } from './account-service';
import { listComputeJobs, listComputeProviders } from './compute-service';
import { listModelBranches, listPipelines, listSweepPlans, listTrainingRuns } from './pipeline-service';
import { listRegistryModels } from './registry-service';
import { listModelSubmissions } from './submission-service';

type Client = ReturnType<typeof dataClient>;

export type DryRunStepId =
	| 'auth'
	| 'numerai'
	| 'compute'
	| 'pipeline'
	| 'sweep'
	| 'training'
	| 'job-sync'
	| 'registry'
	| 'submission';

export type DryRunStep = {
	readonly id: DryRunStepId;
	readonly label: string;
	readonly ok: boolean;
	readonly evidence: string;
};

export type DryRunWorkspace = {
	readonly authenticated: boolean;
	readonly numeraiAccounts: readonly NumeraiDryRunRecord[];
	readonly computeProviders: readonly ComputeProviderDryRunRecord[];
	readonly pipelines: readonly PipelineDryRunRecord[];
	readonly branches: readonly BranchDryRunRecord[];
	readonly sweepPlans: readonly SweepDryRunRecord[];
	readonly trainingRuns: readonly TrainingRunDryRunRecord[];
	readonly computeJobs: readonly ComputeJobDryRunRecord[];
	readonly models: readonly ModelDryRunRecord[];
	readonly submissions: readonly SubmissionDryRunRecord[];
};

export type DryRunReport = {
	readonly ok: boolean;
	readonly steps: readonly DryRunStep[];
	readonly failures: readonly DryRunStep[];
};

type NumeraiDryRunRecord = {
	readonly verifiedAt?: string | null;
	readonly lastVerifyError?: string | null;
};

type ComputeProviderDryRunRecord = {
	readonly status?: string | null;
	readonly providerType?: string | null;
	readonly verifiedAt?: string | null;
};

type PipelineDryRunRecord = {
	readonly id: string;
	readonly name?: string | null;
};

type BranchDryRunRecord = {
	readonly pipelineId?: string | null;
};

type SweepDryRunRecord = {
	readonly name?: string | null;
	readonly status?: string | null;
};

type TrainingRunDryRunRecord = {
	readonly id: string;
	readonly status?: string | null;
};

type ComputeJobDryRunRecord = {
	readonly name?: string | null;
	readonly runId?: string | null;
	readonly status?: string | null;
};

type ModelDryRunRecord = {
	readonly name?: string | null;
	readonly runId?: string | null;
	readonly numeraiModelId?: string | null;
};

type SubmissionDryRunRecord = {
	readonly id: string;
	readonly status?: string | null;
	readonly roundNumber?: number | null;
};

export async function loadDryRunWorkspace(client: Client = dataClient()): Promise<DryRunWorkspace> {
	const [
		numeraiAccounts,
		computeProviders,
		pipelines,
		branches,
		sweepPlans,
		trainingRuns,
		computeJobs,
		models,
		submissions
	] = await Promise.all([
		listNumeraiAccounts(client),
		listComputeProviders(client),
		listPipelines(client),
		listModelBranches(client),
		listSweepPlans(client),
		listTrainingRuns(client),
		listComputeJobs(client),
		listRegistryModels(client),
		listModelSubmissions(client)
	]);

	return {
		authenticated: true,
		numeraiAccounts,
		computeProviders,
		pipelines,
		branches,
		sweepPlans,
		trainingRuns,
		computeJobs,
		models,
		submissions
	};
}

export function evaluateFrontendDryRun(workspace: DryRunWorkspace): DryRunReport {
	const verifiedNumerai = workspace.numeraiAccounts.filter(
		(account) => !!account.verifiedAt && !account.lastVerifyError
	);
	const usableProviders = workspace.computeProviders.filter(
		(provider) => provider.status !== 'disabled' && (provider.providerType === 'local' || !!provider.verifiedAt)
	);
	const pipelineWithBranch = workspace.pipelines.find((pipeline) =>
		workspace.branches.some((branch) => branch.pipelineId === pipeline.id)
	);
	const queuedSweep = workspace.sweepPlans.find((sweep) => sweep.status === 'queued' || sweep.status === 'running');
	const runnableTraining = workspace.trainingRuns.find((run) =>
		['queued', 'running', 'completed'].includes(run.status ?? '')
	);
	const syncedJob = workspace.computeJobs.find(
		(job) => !!job.runId && ['planned', 'queued', 'running', 'completed'].includes(job.status ?? '')
	);
	const registeredModel = workspace.models.find((model) => !!model.runId || !!model.numeraiModelId);
	const submittedModel = workspace.submissions.find((submission) =>
		['planned', 'queued', 'submitted', 'completed'].includes(submission.status ?? '')
	);

	const steps: DryRunStep[] = [
		step('auth', 'Sign in', workspace.authenticated, 'Authenticated workspace context is available.'),
		step(
			'numerai',
			'Connect Numerai account',
			verifiedNumerai.length > 0,
			`${verifiedNumerai.length} verified Numerai account${verifiedNumerai.length === 1 ? '' : 's'} found.`
		),
		step(
			'compute',
			'Connect compute provider',
			usableProviders.length > 0,
			`${usableProviders.length} usable compute provider${usableProviders.length === 1 ? '' : 's'} found.`
		),
		step(
			'pipeline',
			'Create pipeline',
			!!pipelineWithBranch,
			pipelineWithBranch ? `Pipeline ${pipelineWithBranch.name} has a branch.` : 'No pipeline with branch found.'
		),
		step(
			'sweep',
			'Queue sweep',
			!!queuedSweep,
			queuedSweep ? `Sweep ${queuedSweep.name} is ${queuedSweep.status}.` : 'No queued/running sweep found.'
		),
		step(
			'training',
			'Start training action',
			!!runnableTraining,
			runnableTraining
				? `Training run ${runnableTraining.id} is ${runnableTraining.status}.`
				: 'No queued/running/completed training run found.'
		),
		step(
			'job-sync',
			'ComputeJob + TrainingRun update',
			!!syncedJob,
			syncedJob ? `Compute job ${syncedJob.name} is linked to run ${syncedJob.runId}.` : 'No linked compute job found.'
		),
		step(
			'registry',
			'Register model',
			!!registeredModel,
			registeredModel ? `Model ${registeredModel.name} is registered.` : 'No registry model found.'
		),
		step(
			'submission',
			'Prepare or queue submission',
			!!submittedModel,
			submittedModel
				? `Submission ${submittedModel.id} is ${submittedModel.status} for round ${submittedModel.roundNumber ?? 'next'}.`
				: 'No planned/queued/submitted/completed submission found.'
		)
	];

	const failures = steps.filter((item) => !item.ok);
	return { ok: failures.length === 0, steps, failures };
}

function step(id: DryRunStepId, label: string, ok: boolean, evidence: string): DryRunStep {
	return { id, label, ok, evidence };
}
