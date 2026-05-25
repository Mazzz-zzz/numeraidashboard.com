import { dataClient } from '$lib/data';
import type { Schema } from '../../../amplify/data/resource';

type Client = ReturnType<typeof dataClient>;

export const modelStages = ['draft', 'training', 'success', 'failed', 'testing', 'live', 'retired'] as const;
export type ModelStage = (typeof modelStages)[number];
export type ModelRegistryItem = Schema['ModelRegistryItem']['type'];

export const modelStageLabels: Record<ModelStage, string> = {
	draft: 'Draft',
	training: 'Training',
	success: 'Success',
	failed: 'Failed',
	testing: 'Testing',
	live: 'Live',
	retired: 'Retired'
};

export type RegistryModelDraft = {
	readonly name: string;
	readonly stage: ModelStage;
	readonly numeraiModelId: string;
	readonly parentModelId: string;
	readonly changeSummary: string;
	readonly pipelineId?: string | null;
	readonly branchId?: string | null;
	readonly runId?: string | null;
	readonly lineageJson?: unknown;
};

export function registryPayload(input: RegistryModelDraft) {
	const payload: {
		name: string;
		stage: ModelStage;
		numeraiModelId: string | null;
		parentModelId: string | null;
		changeSummary: string | null;
		pipelineId?: string | null;
		branchId?: string | null;
		runId?: string | null;
		lineageJson?: string;
	} = {
		name: input.name.trim(),
		stage: input.stage,
		numeraiModelId: input.numeraiModelId.trim() || null,
		parentModelId: input.parentModelId || null,
		changeSummary: input.changeSummary.trim() || null
	};
	if (input.pipelineId !== undefined) payload.pipelineId = input.pipelineId || null;
	if (input.branchId !== undefined) payload.branchId = input.branchId || null;
	if (input.runId !== undefined) payload.runId = input.runId || null;
	if (input.lineageJson !== undefined) payload.lineageJson = JSON.stringify(input.lineageJson);
	return payload;
}

export async function listRegistryModels(client: Client = dataClient()): Promise<ModelRegistryItem[]> {
	const { data } = await client.models.ModelRegistryItem.list();
	return (data ?? []) as ModelRegistryItem[];
}

export async function createRegistryModel(input: RegistryModelDraft, client: Client = dataClient()) {
	return client.models.ModelRegistryItem.create(registryPayload(input));
}

export async function updateRegistryModel(
	id: string,
	input: RegistryModelDraft,
	client: Client = dataClient()
) {
	return client.models.ModelRegistryItem.update({ id, ...registryPayload(input) });
}

export async function updateRegistryModelStage(id: string, stage: ModelStage, client: Client = dataClient()) {
	return client.models.ModelRegistryItem.update({ id, stage });
}

export async function deleteRegistryModel(id: string, client: Client = dataClient()) {
	return client.models.ModelRegistryItem.delete({ id });
}
