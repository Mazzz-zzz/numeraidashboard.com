import { defineFunction } from '@aws-amplify/backend';
import { trainingFunctionEnvironment } from '../training-environment';

export const mcpServer = defineFunction({
	name: 'mcp-server',
	entry: './handler.ts',
	timeoutSeconds: 60,
	memoryMB: 512,
	environment: trainingFunctionEnvironment,
});
