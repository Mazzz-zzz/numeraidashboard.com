import type { Schema } from '../../data/resource';
import { pollTrainingJob } from '../training-status';

export const handler: Schema['pollTrainingStatus']['functionHandler'] = async (event) => {
	const { runId, providerType, providerJobId, apiKeyRef, apiSecretRef, baseUrl, workspaceId, providerConfigJson } = event.arguments;
	return pollTrainingJob({ runId, providerType, providerJobId, apiKeyRef, apiSecretRef, baseUrl, workspaceId, providerConfigJson });
};
