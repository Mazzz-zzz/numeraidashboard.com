import { dataClient } from '$lib/data';
import { listNumeraiAccounts, type NumeraiAccount } from './account-service';
import { listComputeJobs, listComputeProviders, type ComputeJob, type ComputeProvider } from './compute-service';
import { listRegistryModels, type ModelRegistryItem } from './registry-service';
import { listTrainingRuns, type TrainingRun } from './pipeline-service';

type Client = ReturnType<typeof dataClient>;

export type DashboardData = {
	readonly numeraiAccounts: NumeraiAccount[];
	readonly computeProviders: ComputeProvider[];
	readonly trainingRuns: TrainingRun[];
	readonly computeJobs: ComputeJob[];
	readonly registeredModels: ModelRegistryItem[];
};

export async function loadDashboardData(client: Client = dataClient()): Promise<DashboardData> {
	const [numeraiAccounts, computeProviders, trainingRuns, computeJobs, registeredModels] =
		await Promise.all([
			listNumeraiAccounts(client),
			listComputeProviders(client),
			listTrainingRuns(client),
			listComputeJobs(client),
			listRegistryModels(client)
		]);

	return {
		numeraiAccounts,
		computeProviders,
		trainingRuns,
		computeJobs,
		registeredModels
	};
}
