import type { Schema } from '../../data/resource';
import { requireWorkflowOwner, secureProviderRuntimeArgs } from '../workflow-security';
import { launchTrainingJob } from './provider-adapters';

export const handler: Schema['startTraining']['functionHandler'] = async (event) => {
	const { runId, providerId, providerType, apiKeyRef, apiSecretRef, baseUrl, workspaceId, providerConfigJson } = event.arguments;
	const secured = secureProviderRuntimeArgs(
		{ providerType, apiKeyRef, apiSecretRef, baseUrl, providerConfigJson },
		requireWorkflowOwner(event)
	);
	return launchTrainingJob({ runId, providerId, providerType, workspaceId, ...secured });
};
