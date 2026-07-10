import { defineFunction } from '@aws-amplify/backend';
import { modalFunctionEnvironment } from '../modal-environment';

export const startTraining = defineFunction({
	name: 'start-training',
	entry: './handler.ts',
	timeoutSeconds: 30,
	environment: modalFunctionEnvironment,
});
