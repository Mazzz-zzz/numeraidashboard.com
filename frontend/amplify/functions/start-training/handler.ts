import type { Schema } from '../../data/resource';
import { requireCallerSub, secureProviderRuntimeArgs } from '../workflow-security';
import { launchTrainingJob } from './provider-adapters';

export const handler: Schema['startTraining']['functionHandler'] = async (event) => {
	const { runId, providerId, providerType, apiKeyRef, apiSecretRef, baseUrl, workspaceId, providerConfigJson } = event.arguments;
	const secured = secureProviderRuntimeArgs(
		{ providerType, apiKeyRef, apiSecretRef, baseUrl, providerConfigJson },
		requireCallerSub(event)
	);
	return launchTrainingJob({ runId, providerId, providerType, workspaceId, ...secured });
};
