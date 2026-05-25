import { defineFunction } from '@aws-amplify/backend';

export const submitModel = defineFunction({
	name: 'submit-model',
	entry: './handler.ts',
	timeoutSeconds: 30,
});
