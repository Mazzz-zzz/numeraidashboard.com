import { dataClient } from '$lib/data';
import { requireAuthSession } from '$lib/auth';
import type { Schema } from '../../../amplify/data/resource';

type Client = ReturnType<typeof dataClient>;

export type ComputeProvider = Schema['ComputeProvider']['type'];
export type ComputeJob = Schema['ComputeJob']['type'];
export type ComputeJobStatus = NonNullable<ComputeJob['status']>;

export type ProviderCard = {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly type: string;
	readonly body: string;
	readonly monthlyBudgetUsd: number | null;
	readonly defaultRunCapUsd: number | null;
	readonly maxConcurrentJobs: number | null;
};

export type ComputeJobRow = {
	readonly id: string;
	readonly runId: string | null;
	readonly providerId: string | null;
	readonly providerJobId: string | null;
	readonly name: string;
	readonly provider: string;
	readonly startedAt: string;
	readonly status: ComputeJobStatus;
	readonly canCancel: boolean;
	readonly canRetry: boolean;
};

export async function listComputeProviders(client: Client = dataClient()): Promise<ComputeProvider[]> {
	await requireAuthSession();
	const { data } = await client.models.ComputeProvider.list();
	return (data ?? []) as ComputeProvider[];
}

export async function listComputeJobs(client: Client = dataClient()): Promise<ComputeJob[]> {
	await requireAuthSession();
	const { data } = await client.models.ComputeJob.list();
	return (data ?? []) as ComputeJob[];
}

export function providerTypeLabel(provider: ComputeProvider): string {
	switch (provider.providerType) {
		case 'prime_intellect':
			return 'decentralized GPU';
		case 'modal':
			return 'serverless GPU';
		case 'sagemaker':
			return 'managed cloud';
		case 'local':
			return 'owned hardware';
		case 'custom':
			return 'custom provider';
		default:
			return 'compute provider';
	}
}

export function providerBody(provider: ComputeProvider): string {
	if (provider.notes) return provider.notes;
	if (provider.status === 'disabled') return 'Disabled for new training jobs.';
	if (provider.verifiedAt) return 'Verified and available for queued training workloads.';
	if (provider.lastVerifyError) return provider.lastVerifyError;
	return 'Configured provider awaiting verification before live workloads.';
}

export function providerCards(providers: readonly ComputeProvider[]): ProviderCard[] {
	return providers.map((provider) => ({
		id: provider.id,
		name: provider.name,
		status: provider.status ?? 'planned',
		type: providerTypeLabel(provider),
		body: providerBody(provider),
		monthlyBudgetUsd: provider.monthlyBudgetUsd ?? null,
		defaultRunCapUsd: provider.defaultRunCapUsd ?? null,
		maxConcurrentJobs: provider.maxConcurrentJobs ?? null
	}));
}

export function formatCurrency(value: number | null | undefined): string {
	if (typeof value !== 'number') return 'unset';
	return `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
}

export function computeJobRows(
	jobs: readonly ComputeJob[],
	providers: readonly ComputeProvider[]
): ComputeJobRow[] {
	return jobs.map((job) => {
		const status = job.status ?? 'planned';
		return {
			id: job.id,
			runId: job.runId ?? null,
			providerId: job.providerId ?? null,
			providerJobId: job.providerJobId ?? null,
			name: job.name,
			provider: providers.find((provider) => provider.id === job.providerId)?.name ?? 'No provider',
			startedAt: job.startedAt ? new Date(job.startedAt).toLocaleString() : 'not started',
			status,
			canCancel: status === 'planned' || status === 'queued' || status === 'running',
			canRetry: status === 'failed' || status === 'cancelled'
		};
	});
}

export async function updateComputeProviderBudget(
	input: {
		readonly providerId: string;
		readonly monthlyBudgetUsd: number | null;
		readonly defaultRunCapUsd: number | null;
		readonly maxConcurrentJobs: number | null;
	},
	client: Client = dataClient()
): Promise<ComputeProvider> {
	await requireAuthSession();
	const { data } = await client.models.ComputeProvider.update({
		id: input.providerId,
		monthlyBudgetUsd: input.monthlyBudgetUsd,
		defaultRunCapUsd: input.defaultRunCapUsd,
		maxConcurrentJobs: input.maxConcurrentJobs
	});
	if (!data) throw new Error('ComputeProvider.update returned no data');
	return data as ComputeProvider;
}

export async function updateComputeJobStatus(
	input: {
		readonly jobId: string;
		readonly status: ComputeJobStatus;
		readonly startedAt?: string | null;
		readonly finishedAt?: string | null;
		readonly providerJobId?: string | null;
		readonly logTail?: string | null;
		readonly actualCostUsd?: number | null;
	},
	client: Client = dataClient()
): Promise<ComputeJob> {
	await requireAuthSession();
	const update: {
		id: string;
		status: ComputeJobStatus;
		startedAt?: string | null;
		finishedAt?: string | null;
		providerJobId?: string | null;
		logTail?: string | null;
		actualCostUsd?: number | null;
	} = {
		id: input.jobId,
		status: input.status
	};
	if (input.startedAt !== undefined) update.startedAt = input.startedAt;
	if (input.finishedAt !== undefined) update.finishedAt = input.finishedAt;
	if (input.providerJobId !== undefined) update.providerJobId = input.providerJobId;
	if (input.logTail !== undefined) update.logTail = input.logTail;
	if (input.actualCostUsd !== undefined) update.actualCostUsd = input.actualCostUsd;

	const { data } = await client.models.ComputeJob.update(update);
	if (!data) throw new Error('ComputeJob.update returned no data');
	return data as ComputeJob;
}
