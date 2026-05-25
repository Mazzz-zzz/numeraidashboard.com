import { defineFunction } from '@aws-amplify/backend';

export const cancelTraining = defineFunction({
	name: 'cancel-training',
	entry: './handler.ts',
	timeoutSeconds: 30,
});
