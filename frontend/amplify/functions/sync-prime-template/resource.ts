import { defineFunction } from '@aws-amplify/backend';

export const syncPrimeTemplate = defineFunction({
	name: 'sync-prime-template',
	entry: './handler.ts',
	timeoutSeconds: 30,
});
