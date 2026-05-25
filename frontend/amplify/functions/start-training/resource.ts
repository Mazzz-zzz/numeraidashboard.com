import { defineFunction } from '@aws-amplify/backend';

export const startTraining = defineFunction({
	name: 'start-training',
	entry: './handler.ts',
	timeoutSeconds: 30,
});
