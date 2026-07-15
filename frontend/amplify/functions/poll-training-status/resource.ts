import { defineFunction } from '@aws-amplify/backend';
import { trainingFunctionEnvironment } from '../training-environment';

export const pollTrainingStatus = defineFunction({
	name: 'poll-training-status',
	entry: './handler.ts',
	timeoutSeconds: 30,
	environment: trainingFunctionEnvironment,
});
