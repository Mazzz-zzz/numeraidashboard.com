import { defineBackend } from '@aws-amplify/backend';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { verifyNumeraiAccount } from './functions/verify-numerai-account/resource';
import { verifyComputeProvider } from './functions/verify-compute-provider/resource';
import { startTraining } from './functions/start-training/resource';
import { cancelTraining } from './functions/cancel-training/resource';
import { pollTrainingStatus } from './functions/poll-training-status/resource';
import { submitModel } from './functions/submit-model/resource';
import { refreshRoundMetrics } from './functions/refresh-round-metrics/resource';
import { syncPrimeTemplate } from './functions/sync-prime-template/resource';
import { fetchNumeraiSubmissions } from './functions/fetch-numerai-submissions/resource';

const backend = defineBackend({
	auth,
	data,
	verifyNumeraiAccount,
	verifyComputeProvider,
	startTraining,
	cancelTraining,
	pollTrainingStatus,
	submitModel,
	refreshRoundMetrics,
	syncPrimeTemplate,
	fetchNumeraiSubmissions,
});

const secretPolicy = new PolicyStatement({
	actions: ['ssm:GetParameter', 'ssm:PutParameter'],
	resources: ['*'],
});

backend.verifyNumeraiAccount.resources.lambda.addToRolePolicy(secretPolicy);
backend.verifyComputeProvider.resources.lambda.addToRolePolicy(secretPolicy);
backend.startTraining.resources.lambda.addToRolePolicy(secretPolicy);
backend.pollTrainingStatus.resources.lambda.addToRolePolicy(secretPolicy);
backend.cancelTraining.resources.lambda.addToRolePolicy(secretPolicy);
backend.syncPrimeTemplate.resources.lambda.addToRolePolicy(secretPolicy);
backend.submitModel.resources.lambda.addToRolePolicy(secretPolicy);
backend.fetchNumeraiSubmissions.resources.lambda.addToRolePolicy(secretPolicy);
