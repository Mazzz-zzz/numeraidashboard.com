import { defineFunction } from '@aws-amplify/backend';
import { trainingFunctionEnvironment } from '../training-environment';

export const startTraining = defineFunction({
	name: 'start-training',
	entry: './handler.ts',
	timeoutSeconds: 30,
	environment: trainingFunctionEnvironment,
});
