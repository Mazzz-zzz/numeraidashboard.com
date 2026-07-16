import { defineBackend } from '@aws-amplify/backend';
import { Duration, Stack } from 'aws-cdk-lib';
import { CfnUserPoolClient, CfnUserPoolDomain } from 'aws-cdk-lib/aws-cognito';
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

const authStack = Stack.of(backend.auth.resources.userPool);
const mcpOAuthDomainPrefix = 'numeraidashboard-mcp-dald5tic4n22y';
new CfnUserPoolDomain(authStack, 'McpOAuthDomain', {
	domain: mcpOAuthDomainPrefix,
	userPoolId: backend.auth.resources.userPool.userPoolId,
});
const mcpOAuthClient = new CfnUserPoolClient(authStack, 'McpOAuthClient', {
	userPoolId: backend.auth.resources.userPool.userPoolId,
	clientName: 'numeraidashboard-claude-mcp',
	generateSecret: false,
	allowedOAuthFlowsUserPoolClient: true,
	allowedOAuthFlows: ['code'],
	allowedOAuthScopes: ['openid'],
	callbackUrLs: ['https://claude.ai/api/mcp/auth_callback'],
	supportedIdentityProviders: ['COGNITO'],
	preventUserExistenceErrors: 'ENABLED',
	enableTokenRevocation: true,
	accessTokenValidity: 60,
	idTokenValidity: 60,
	refreshTokenValidity: 30,
	tokenValidityUnits: {
		accessToken: 'minutes',
		idToken: 'minutes',
		refreshToken: 'days',
	},
});
backend.mcpServer.resources.lambda.addEnvironment('MCP_OAUTH_CLIENT_ID', mcpOAuthClient.ref);

const cognitoIssuer = `https://cognito-idp.${authStack.region}.${authStack.urlSuffix}/${backend.auth.resources.userPool.userPoolId}`;
const cognitoDomain = `https://${mcpOAuthDomainPrefix}.auth.${authStack.region}.amazoncognito.com`;

backend.addOutput({
	custom: {
		mcpUrl: mcpFunctionUrl.url,
		mcpOAuthClientId: mcpOAuthClient.ref,
		mcpOAuthAuthorizationServer: cognitoIssuer,
		mcpOAuthDomain: cognitoDomain,
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
