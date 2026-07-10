import type { Schema } from '../../data/resource';
import { cancelTrainingJob } from '../training-status';
import { requireCallerSub, secureProviderRuntimeArgs } from '../workflow-security';

export const handler: Schema['cancelTraining']['functionHandler'] = async (event) => {
	const { runId, providerType, providerJobId, apiKeyRef, apiSecretRef, baseUrl, workspaceId, providerConfigJson } = event.arguments;
	const secured = secureProviderRuntimeArgs(
		{ providerType, apiKeyRef, apiSecretRef, baseUrl, providerConfigJson },
		requireCallerSub(event)
	);
	return cancelTrainingJob({ runId, providerType, providerJobId, workspaceId, ...secured });
};
