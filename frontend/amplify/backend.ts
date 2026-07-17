import { defineBackend } from '@aws-amplify/backend';
import { Duration, Stack } from 'aws-cdk-lib';
import { CfnUserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { FunctionUrlAuthType, HttpMethod } from 'aws-cdk-lib/aws-lambda';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { verifyNumeraiAccount } from './functions/verify-numerai-account/resource';
import { verifyComputeProvider } from './functions/verify-compute-provider/resource';
import { startTraining } from './functions/start-training/resource';
import { cancelTraining } from './functions/cancel-training/resource';
import { pollTrainingStatus } from './functions/poll-training-status/resource';
import { submitModel } from './functions/submit-model/resource';
import { refreshRoundMetrics } from './functions/refresh-round-metrics/resource';
import { fetchPrimeOffers } from './functions/fetch-prime-offers/resource';
import { fetchNumeraiSubmissions } from './functions/fetch-numerai-submissions/resource';
import { mcpServer } from './functions/mcp-server/resource';

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
	fetchPrimeOffers,
	fetchNumeraiSubmissions,
	mcpServer,
});

const mcpFunctionUrl = backend.mcpServer.resources.lambda.addFunctionUrl({
	authType: FunctionUrlAuthType.NONE,
	cors: {
		allowedOrigins: ['*'],
		allowedMethods: [HttpMethod.GET, HttpMethod.POST],
		allowedHeaders: [
			'content-type',
			'authorization',
			'x-api-key',
			'mcp-protocol-version',
			'mcp-session-id',
		],
		exposedHeaders: ['mcp-protocol-version', 'mcp-session-id'],
		maxAge: Duration.hours(1),
	},
});

// The hosted-UI domain stays: Auth0's OIDC federation authenticates users
// through the pool's /oauth2/* endpoints, which only exist on a domain.
new CfnUserPoolDomain(Stack.of(backend.auth.resources.userPool), 'McpOAuthDomain', {
	domain: 'numeraidashboard-mcp-dald5tic4n22y',
	userPoolId: backend.auth.resources.userPool.userPoolId,
});

// The MCP endpoint is an OAuth resource server; the authorization server is an
// external MCP-capable IdP (Auth0 tenant federating to the Cognito pool). Set
// MCP_OAUTH_ISSUER as an Amplify build environment variable once the tenant
// exists; until then the endpoint deploys API-key-only.
const mcpOAuthIssuer = process.env.MCP_OAUTH_ISSUER?.trim();
if (mcpOAuthIssuer) {
	backend.mcpServer.resources.lambda.addEnvironment('MCP_OAUTH_ISSUER', mcpOAuthIssuer);
}

backend.addOutput({
	custom: {
		mcpUrl: mcpFunctionUrl.url,
		...(mcpOAuthIssuer ? { mcpOAuthAuthorizationServer: mcpOAuthIssuer } : {}),
	},
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
backend.fetchPrimeOffers.resources.lambda.addToRolePolicy(secretReadPolicy);
backend.submitModel.resources.lambda.addToRolePolicy(secretReadPolicy);
backend.fetchNumeraiSubmissions.resources.lambda.addToRolePolicy(secretReadPolicy);
backend.mcpServer.resources.lambda.addToRolePolicy(secretReadPolicy);

const artifactBucketName = process.env.ML_ARTIFACT_BUCKET?.trim();
if (artifactBucketName) {
	backend.startTraining.resources.lambda.addToRolePolicy(new PolicyStatement({
		actions: ['s3:PutObject'],
		resources: [`arn:${Stack.of(backend.startTraining.resources.lambda).partition}:s3:::${artifactBucketName}/prime/*`],
	}));
}
