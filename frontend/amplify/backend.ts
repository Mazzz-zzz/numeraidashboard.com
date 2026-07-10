import { defineBackend } from '@aws-amplify/backend';
import { Stack } from 'aws-cdk-lib';
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

const secretParameterArn = Stack.of(backend.verifyNumeraiAccount.resources.lambda).formatArn({
	service: 'ssm',
	resource: 'parameter',
	resourceName: 'numeraidashboard/*',
});

const secretReadPolicy = new PolicyStatement({
	actions: ['ssm:GetParameter'],
	resources: [secretParameterArn],
});
const secretWritePolicy = new PolicyStatement({
	actions: ['ssm:PutParameter'],
	resources: [secretParameterArn],
});

backend.verifyNumeraiAccount.resources.lambda.addToRolePolicy(secretReadPolicy);
backend.verifyNumeraiAccount.resources.lambda.addToRolePolicy(secretWritePolicy);
backend.verifyComputeProvider.resources.lambda.addToRolePolicy(secretReadPolicy);
backend.verifyComputeProvider.resources.lambda.addToRolePolicy(secretWritePolicy);
backend.startTraining.resources.lambda.addToRolePolicy(secretReadPolicy);
backend.pollTrainingStatus.resources.lambda.addToRolePolicy(secretReadPolicy);
backend.cancelTraining.resources.lambda.addToRolePolicy(secretReadPolicy);
backend.syncPrimeTemplate.resources.lambda.addToRolePolicy(secretReadPolicy);
backend.submitModel.resources.lambda.addToRolePolicy(secretReadPolicy);
backend.fetchNumeraiSubmissions.resources.lambda.addToRolePolicy(secretReadPolicy);
