import { defineFunction } from '@aws-amplify/backend';
import { modalFunctionEnvironment } from '../modal-environment';

export const cancelTraining = defineFunction({
	name: 'cancel-training',
	entry: './handler.ts',
	timeoutSeconds: 30,
	environment: modalFunctionEnvironment,
});
