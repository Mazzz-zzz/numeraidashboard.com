import { defineFunction } from '@aws-amplify/backend';

export const fetchPrimeOffers = defineFunction({
	name: 'fetch-prime-offers',
	entry: './handler.ts',
	timeoutSeconds: 20,
});
