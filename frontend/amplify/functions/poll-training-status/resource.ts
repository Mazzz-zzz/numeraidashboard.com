import { defineFunction } from '@aws-amplify/backend';
import { modalFunctionEnvironment } from '../modal-environment';

export const pollTrainingStatus = defineFunction({
	name: 'poll-training-status',
	entry: './handler.ts',
	timeoutSeconds: 30,
	environment: modalFunctionEnvironment,
});
