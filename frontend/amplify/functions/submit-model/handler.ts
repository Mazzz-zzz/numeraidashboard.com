import type { Schema } from '../../data/resource';
import { planSubmission } from './submission-workflow';

export const handler: Schema['submitModel']['functionHandler'] = async (event) => {
	const args = event.arguments;
	return planSubmission(args);
};
