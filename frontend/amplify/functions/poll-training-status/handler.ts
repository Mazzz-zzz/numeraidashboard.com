import type { Schema } from '../../data/resource';
import { pollTrainingJob } from '../training-status';
import { requireWorkflowOwner, secureProviderRuntimeArgs } from '../workflow-security';

export const handler: Schema['pollTrainingStatus']['functionHandler'] = async (event) => {
	const { runId, providerType, providerJobId, apiKeyRef, apiSecretRef, baseUrl, workspaceId, providerConfigJson } = event.arguments;
	const secured = secureProviderRuntimeArgs(
		{ providerType, apiKeyRef, apiSecretRef, baseUrl, providerConfigJson },
		requireWorkflowOwner(event)
	);
	return pollTrainingJob({ runId, providerType, providerJobId, workspaceId, ...secured });
};
