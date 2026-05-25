import { defineFunction } from '@aws-amplify/backend';

export const refreshRoundMetrics = defineFunction({
	name: 'refresh-round-metrics',
	entry: './handler.ts',
	timeoutSeconds: 30,
});
