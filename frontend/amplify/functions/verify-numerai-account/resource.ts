import { defineFunction } from '@aws-amplify/backend';

export const verifyNumeraiAccount = defineFunction({
	name: 'verify-numerai-account',
	entry: './handler.ts',
	timeoutSeconds: 15,
});
