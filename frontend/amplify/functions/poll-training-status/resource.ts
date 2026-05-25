import { defineFunction } from '@aws-amplify/backend';

export const pollTrainingStatus = defineFunction({
	name: 'poll-training-status',
	entry: './handler.ts',
	timeoutSeconds: 30,
});
