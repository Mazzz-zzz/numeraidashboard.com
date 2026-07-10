import { defineFunction } from '@aws-amplify/backend';

export const verifyComputeProvider = defineFunction({
	name: 'verify-compute-provider',
	entry: './handler.ts',
	timeoutSeconds: 15,
});
