import type { Schema } from '../../data/resource';
import { launchTrainingJob } from './provider-adapters';

export const handler: Schema['startTraining']['functionHandler'] = async (event) => {
	const { runId, providerId, providerType, apiKeyRef, baseUrl, workspaceId, providerConfigJson } = event.arguments;
	return launchTrainingJob({ runId, providerId, providerType, apiKeyRef, baseUrl, workspaceId, providerConfigJson });
};
