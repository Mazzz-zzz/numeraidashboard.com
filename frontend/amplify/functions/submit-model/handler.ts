import type { Schema } from '../../data/resource';
import { ownedSecretRef, requireCallerSub, secureProviderRuntimeArgs } from '../workflow-security';
import { runSubmission } from './submission-workflow';

export const handler: Schema['submitModel']['functionHandler'] = async (event) => {
	const owner = requireCallerSub(event);
	const secured = secureProviderRuntimeArgs(event.arguments, owner);
	return runSubmission({
		...event.arguments,
		numeraiSecretRef: ownedSecretRef(
			event.arguments.numeraiSecretRef,
			owner,
			'Numerai secret reference'
		),
		baseUrl: secured.baseUrl,
		providerConfigJson: secured.providerConfigJson,
	});
};
