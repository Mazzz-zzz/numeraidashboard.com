import { dataClient } from '$lib/data';
import type { Schema } from '../../../amplify/data/resource';
import { listNumeraiAccounts, type NumeraiAccount } from './account-service';
import { listComputeProviders, type ComputeProvider } from './compute-service';
import { listRegistryModels, type ModelRegistryItem } from './registry-service';

type Client = ReturnType<typeof dataClient>;

export type ValidationMode = 'schema' | 'schema_range' | 'schema_range_rank';
export type ModelSubmission = Schema['ModelSubmission']['type'];
export type RoundDataset = Schema['RoundDataset']['type'];
export type SubmitModelResult = NonNullable<Schema['SubmitModelResult']['type']>;
export type RefreshRoundMetricsResult = NonNullable<Schema['RefreshRoundMetricsResult']['type']>;

export type SubmissionSetup = {
	readonly models: ModelRegistryItem[];
	readonly providers: ComputeProvider[];
	readonly numeraiAccount: NumeraiAccount | null;
	readonly submissions: ModelSubmission[];
	readonly rounds: RoundDataset[];
};

export type SubmissionPlanDraft = {
	readonly selectedModelId: string;
	readonly selectedProviderId: string;
	readonly numeraiAccountId: string | null;
	readonly roundNumber: string;
	readonly predictionSet: string;
	readonly neutralizationPct: number;
	readonly validationMode: ValidationMode;
	readonly uploadEnabled: boolean;
	readonly modelName: string | null;
	readonly providerName: string | null;
};

export type SubmitModelDraft = SubmissionPlanDraft;

export function parseRoundNumber(value: string): number | null {
	const parsed = Number.parseInt(value.trim(), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function submissionPlanPayload(input: SubmissionPlanDraft) {
	return {
		modelId: input.selectedModelId,
		providerId: input.selectedProviderId || null,
		numeraiAccountId: input.numeraiAccountId,
		roundNumber: parseRoundNumber(input.roundNumber),
		status: 'planned' as const,
		predictionSet: input.predictionSet,
		neutralizationPct: input.neutralizationPct,
		validationMode: input.validationMode,
		uploadEnabled: input.uploadEnabled,
		notes: `Prepared submission plan for ${input.modelName ?? 'model'} on ${input.providerName ?? 'provider'}`
	};
}

export function latestSubmissionForModel(
	modelId: string,
	submissions: readonly ModelSubmission[]
): ModelSubmission | null {
	return (
		[...submissions]
			.filter((submission) => submission.modelId === modelId)
			.sort((a, b) => timestamp(b.submittedAt ?? b.createdAt) - timestamp(a.submittedAt ?? a.createdAt))[0] ??
		null
	);
}

export function roundLabel(round: RoundDataset | null | undefined): string {
	if (!round) return 'No cached round';
	const version = round.datasetVersion ? ` · ${round.datasetVersion}` : '';
	return `Round ${round.roundNumber}${version}`;
}

export function latestRoundDataset(rounds: readonly RoundDataset[]): RoundDataset | null {
	return [...rounds].sort((a, b) => (b.roundNumber ?? 0) - (a.roundNumber ?? 0))[0] ?? null;
}

export function roundFreshnessLabel(
	round: RoundDataset | null | undefined,
	now: string | Date = new Date()
): string {
	if (!round) return 'No round cache';
	if (!round.staleAfter) return 'Freshness unknown';
	const nowTime = typeof now === 'string' ? Date.parse(now) : now.getTime();
	const staleTime = Date.parse(round.staleAfter);
	if (!Number.isFinite(staleTime) || !Number.isFinite(nowTime)) return 'Freshness unknown';
	return staleTime < nowTime ? 'Round cache stale' : 'Round cache fresh';
}

export function submissionStatusLabel(submission: ModelSubmission | null | undefined): string {
	if (!submission) return 'No submission yet';
	const round = submission.roundNumber ? ` r${submission.roundNumber}` : '';
	return `${submission.status ?? 'planned'}${round}`;
}

export function normalizeSubmissionResultStatus(status: string): NonNullable<ModelSubmission['status']> {
	switch (status) {
		case 'planned':
		case 'queued':
		case 'submitted':
		case 'failed':
		case 'completed':
			return status;
		default:
			return 'planned';
	}
}

export function submissionRecordPayloadFromResult(input: SubmitModelDraft, result: SubmitModelResult) {
	const planned = submissionPlanPayload(input);
	const roundNumber = result.roundNumber ?? planned.roundNumber;
	return {
		...planned,
		roundNumber,
		status: normalizeSubmissionResultStatus(result.status),
		externalSubmissionId: result.submissionId ?? null,
		artifactUri: result.artifactUri ?? null,
		submittedAt: result.checkedAt,
		notes: result.logTail ?? result.error ?? planned.notes
	};
}

export function roundDatasetPayloadFromRefresh(result: RefreshRoundMetricsResult) {
	return {
		roundNumber: result.roundNumber ?? 0,
		status: normalizeRoundStatus(result.roundStatus),
		openAt: result.openAt ?? null,
		closeAt: result.closeAt ?? null,
		datasetVersion: result.datasetVersion ?? null,
		liveDataUri: result.liveDataUri ?? null,
		cachedAt: result.checkedAt,
		staleAfter: result.staleAfter ?? null
	};
}

export function submissionPayloadFromRefresh(result: RefreshRoundMetricsResult) {
	return {
		status: normalizeSubmissionResultStatus(result.submissionStatus ?? 'planned'),
		roundNumber: result.roundNumber ?? null,
		notes: result.notes ?? result.error ?? null,
		submittedAt: result.checkedAt
	};
}

export function registryPayloadFromRefresh(result: RefreshRoundMetricsResult) {
	return {
		lastSubmittedRound: result.roundNumber ?? null,
		lastSubmittedAt: result.checkedAt,
		liveCorr: result.liveCorr ?? null,
		liveMmc: result.liveMmc ?? null,
		payoutNmr: result.payoutNmr ?? null
	};
}

function normalizeRoundStatus(status: string | null | undefined): NonNullable<RoundDataset['status']> {
	switch (status) {
		case 'planned':
		case 'open':
		case 'closed':
		case 'scored':
			return status;
		default:
			return 'planned';
	}
}

function timestamp(value: string | null | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

export async function loadSubmissionSetup(client: Client = dataClient()): Promise<SubmissionSetup> {
	const [models, providers, accounts, submissions, rounds] = await Promise.all([
		listRegistryModels(client),
		listComputeProviders(client),
		listNumeraiAccounts(client),
		listModelSubmissions(client),
		listRoundDatasets(client)
	]);

	return {
		models,
		providers,
		numeraiAccount: accounts[0] ?? null,
		submissions,
		rounds
	};
}

export async function createSubmissionPlan(input: SubmissionPlanDraft, client: Client = dataClient()) {
	return client.models.ModelSubmission.create(submissionPlanPayload(input));
}

export async function listModelSubmissions(client: Client = dataClient()): Promise<ModelSubmission[]> {
	const { data } = await client.models.ModelSubmission.list();
	return (data ?? []) as ModelSubmission[];
}

export async function listRoundDatasets(client: Client = dataClient()): Promise<RoundDataset[]> {
	const { data } = await client.models.RoundDataset.list();
	return (data ?? []) as RoundDataset[];
}

export async function refreshRoundMetricsForModel(
	input: {
		readonly modelId: string;
		readonly submissionId?: string | null;
		readonly roundNumber: number;
	},
	client: Client = dataClient()
) {
	const { data, errors } = await client.mutations.refreshRoundMetrics({
		modelId: input.modelId,
		submissionId: input.submissionId ?? null,
		roundNumber: input.roundNumber
	});
	if (errors?.length) throw new Error(errors[0].message);
	if (!data) throw new Error('refreshRoundMetrics returned no data');
	const result = data as RefreshRoundMetricsResult;
	if (!result.ok) throw new Error(result.error ?? 'Round metrics refresh failed');

	const existingRounds = await listRoundDatasets(client);
	const existingRound = existingRounds.find((round) => round.roundNumber === result.roundNumber);
	const roundPayload = roundDatasetPayloadFromRefresh(result);
	const roundWrite = existingRound
		? await client.models.RoundDataset.update({ id: existingRound.id, ...roundPayload })
		: await client.models.RoundDataset.create(roundPayload);

	const submissionWrite =
		input.submissionId && result.submissionStatus
			? await client.models.ModelSubmission.update({
					id: input.submissionId,
					...submissionPayloadFromRefresh(result)
				})
			: null;

	const modelWrite = await client.models.ModelRegistryItem.update({
		id: input.modelId,
		...registryPayloadFromRefresh(result)
	});

	return { result, round: roundWrite, submission: submissionWrite, model: modelWrite };
}

export async function submitModel(input: SubmitModelDraft, client: Client = dataClient()) {
	const roundNumber = parseRoundNumber(input.roundNumber);
	const context = input.uploadEnabled
		? await loadSubmissionContext(input, client)
		: null;

	const { data, errors } = await client.mutations.submitModel({
		modelId: input.selectedModelId,
		providerId: input.selectedProviderId || null,
		providerType: context?.providerType ?? null,
		numeraiAccountId: input.numeraiAccountId,
		numeraiModelId: context?.numeraiModelId ?? null,
		numeraiPublicId: context?.numeraiPublicId ?? null,
		numeraiSecretRef: context?.numeraiSecretRef ?? null,
		modelArtifactUri: context?.modelArtifactUri ?? null,
		roundNumber,
		predictionSet: input.predictionSet,
		neutralizationPct: input.neutralizationPct,
		validationMode: input.validationMode,
		uploadEnabled: input.uploadEnabled,
		baseUrl: context?.baseUrl ?? null,
		providerConfigJson: context?.providerConfigJson ?? null
	});
	if (errors?.length) throw new Error(errors[0].message);
	if (!data) throw new Error('submitModel returned no data');
	const result = data as SubmitModelResult;
	const payload = submissionRecordPayloadFromResult(input, result);
	const created = await client.models.ModelSubmission.create(payload);
	if (input.selectedModelId && input.uploadEnabled && result.ok) {
		await client.models.ModelRegistryItem.update({
			id: input.selectedModelId,
			lastSubmittedRound: result.roundNumber ?? roundNumber,
			lastSubmittedAt: result.checkedAt
		});
	}
	return { result, created };
}

type SubmissionContext = {
	readonly providerType: string | null;
	readonly numeraiModelId: string | null;
	readonly numeraiPublicId: string | null;
	readonly numeraiSecretRef: string | null;
	readonly modelArtifactUri: string | null;
	readonly baseUrl: string | null;
	readonly providerConfigJson: unknown;
};

async function loadSubmissionContext(input: SubmitModelDraft, client: Client): Promise<SubmissionContext> {
	const [model, provider, numeraiAccount] = await Promise.all([
		input.selectedModelId
			? client.models.ModelRegistryItem.get({ id: input.selectedModelId }).then((res) => res.data)
			: Promise.resolve(null),
		input.selectedProviderId
			? client.models.ComputeProvider.get({ id: input.selectedProviderId }).then((res) => res.data)
			: Promise.resolve(null),
		input.numeraiAccountId
			? client.models.NumeraiAccount.get({ id: input.numeraiAccountId }).then((res) => res.data)
			: Promise.resolve(null)
	]);

	let modelArtifactUri: string | null = null;
	if (model?.runId) {
		const runRes = await client.models.TrainingRun.get({ id: model.runId });
		modelArtifactUri = runRes.data?.artifactUri ?? null;
	}

	return {
		providerType: provider?.providerType ?? null,
		numeraiModelId: model?.numeraiModelId ?? null,
		numeraiPublicId: numeraiAccount?.publicId ?? null,
		numeraiSecretRef: numeraiAccount?.secretRef ?? null,
		modelArtifactUri,
		baseUrl: provider?.baseUrl ?? null,
		providerConfigJson: provider?.credentialsJson ?? null
	};
}
