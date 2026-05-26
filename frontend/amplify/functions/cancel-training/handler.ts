import type { Schema } from '../../data/resource';
import { cancelTrainingJob } from '../training-status';

export const handler: Schema['cancelTraining']['functionHandler'] = async (event) => {
	const { runId, providerType, providerJobId, apiKeyRef, apiSecretRef, baseUrl, workspaceId, providerConfigJson } = event.arguments;
	return cancelTrainingJob({ runId, providerType, providerJobId, apiKeyRef, apiSecretRef, baseUrl, workspaceId, providerConfigJson });
};
