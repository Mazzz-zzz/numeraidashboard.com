import { defineFunction } from '@aws-amplify/backend';
import { modalFunctionEnvironment } from '../modal-environment';

export const submitModel = defineFunction({
	name: 'submit-model',
	entry: './handler.ts',
	timeoutSeconds: 60,
	environment: modalFunctionEnvironment,
});
