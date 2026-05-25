import type { Schema } from '../../data/resource';
import { refreshRoundMetricsSnapshot } from './round-metrics';

export const handler: Schema['refreshRoundMetrics']['functionHandler'] = async (event) => {
	const { modelId, submissionId, roundNumber } = event.arguments;
	return refreshRoundMetricsSnapshot({ modelId, submissionId, roundNumber });
};
