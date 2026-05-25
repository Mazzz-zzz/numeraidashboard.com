import type { Schema } from '../../data/resource';
import { runSubmission } from './submission-workflow';

export const handler: Schema['submitModel']['functionHandler'] = async (event) => {
	return runSubmission(event.arguments);
};
