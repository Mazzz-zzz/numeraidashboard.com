import { defineFunction } from '@aws-amplify/backend';

export const fetchNumeraiSubmissions = defineFunction({
	name: 'fetch-numerai-submissions',
	entry: './handler.ts',
	timeoutSeconds: 30,
});
