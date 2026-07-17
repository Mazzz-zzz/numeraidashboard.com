import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { verifyNumeraiAccount } from '../functions/verify-numerai-account/resource';
import { verifyComputeProvider } from '../functions/verify-compute-provider/resource';
import { startTraining } from '../functions/start-training/resource';
import { cancelTraining } from '../functions/cancel-training/resource';
import { pollTrainingStatus } from '../functions/poll-training-status/resource';
import { submitModel } from '../functions/submit-model/resource';
import { refreshRoundMetrics } from '../functions/refresh-round-metrics/resource';
import { fetchPrimeOffers } from '../functions/fetch-prime-offers/resource';
import { fetchNumeraiSubmissions } from '../functions/fetch-numerai-submissions/resource';
import { mcpServer } from '../functions/mcp-server/resource';

const schema = a.schema({
	Pipeline: a
		.model({
			// Explicitly declare Amplify's owner field so the owner-scoped MCP
			// resource can create workflow rows for its authenticated principal.
			owner: a.string(),
			name: a.string().required(),
			description: a.string(),
			status: a.enum(['draft', 'testing', 'live', 'retired']),
			template: a.enum(['baseline', 'challenger', 'ensemble', 'custom']),
			graphJson: a.json(),
			activeBranchId: a.id(),
			defaultProviderId: a.id(),
			lastRunAt: a.datetime(),
			branches: a.hasMany('ModelBranch', 'pipelineId'),
			runs: a.hasMany('TrainingRun', 'pipelineId'),
		})
		.authorization((allow) => [allow.owner()]),

	ModelBranch: a
		.model({
			owner: a.string(),
			pipelineId: a.id().required(),
			pipeline: a.belongsTo('Pipeline', 'pipelineId'),
			parentBranchId: a.id(),
			name: a.string().required(),
			changeSummary: a.string(),
			graphJson: a.json(),
			score: a.float(),
			status: a.enum(['draft', 'queued', 'running', 'completed', 'failed', 'promoted']),
			runs: a.hasMany('TrainingRun', 'branchId'),
		})
		.authorization((allow) => [allow.owner()]),

	SweepPlan: a
		.model({
			pipelineId: a.id().required(),
			branchId: a.id(),
			name: a.string().required(),
			parameter: a.string().required(),
			valuesJson: a.json(),
			maxRuns: a.integer(),
			maxSpendUsd: a.float(),
			providerId: a.id(),
			status: a.enum(['draft', 'queued', 'running', 'completed', 'cancelled']),
			generatedRunCount: a.integer(),
		})
		.authorization((allow) => [allow.owner()]),

	TrainingRun: a
		.model({
			owner: a.string(),
			pipelineId: a.id().required(),
			pipeline: a.belongsTo('Pipeline', 'pipelineId'),
			branchId: a.id(),
			branch: a.belongsTo('ModelBranch', 'branchId'),
			providerId: a.id(),
			modelTemplate: a.enum(['baseline', 'challenger', 'ensemble', 'custom']),
			status: a.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
			configJson: a.json(),
			metricsJson: a.json(),
			costUsd: a.float(),
			startedAt: a.datetime(),
			finishedAt: a.datetime(),
			logTail: a.string(),
			artifactUri: a.string(),
		})
		.authorization((allow) => [allow.owner()]),

	ModelRegistryItem: a
		.model({
			owner: a.string(),
			name: a.string().required(),
				stage: a.enum(['draft', 'training', 'success', 'failed', 'testing', 'live', 'retired']),
			pipelineId: a.id(),
			branchId: a.id(),
			runId: a.id(),
			parentModelId: a.id(),
			changeSummary: a.string(),
			numeraiModelId: a.string(),
			liveCorr: a.float(),
			liveMmc: a.float(),
			payoutNmr: a.float(),
			lastSubmittedRound: a.integer(),
			lastSubmittedAt: a.datetime(),
			lineageJson: a.json(),
		})
		.authorization((allow) => [allow.owner()]),

	ModelSubmission: a
		.model({
			modelId: a.id().required(),
			providerId: a.id(),
			numeraiAccountId: a.id(),
			externalSubmissionId: a.string(),
			roundNumber: a.integer(),
			status: a.enum(['planned', 'queued', 'submitted', 'failed', 'completed']),
			predictionSet: a.string(),
			neutralizationPct: a.integer(),
			validationMode: a.string(),
			uploadEnabled: a.boolean(),
			artifactUri: a.string(),
			notes: a.string(),
			submittedAt: a.datetime(),
		})
		.authorization((allow) => [allow.owner()]),

	RoundDataset: a
		.model({
			roundNumber: a.integer().required(),
			status: a.enum(['planned', 'open', 'closed', 'scored']),
			openAt: a.datetime(),
			closeAt: a.datetime(),
			datasetVersion: a.string(),
			liveDataUri: a.string(),
			cachedAt: a.datetime(),
			staleAfter: a.datetime(),
		})
		.authorization((allow) => [allow.authenticated()]),

	ComputeProvider: a
		.model({
			name: a.string().required(),
			providerType: a.enum(['prime_intellect', 'modal', 'sagemaker', 'local', 'custom']),
			status: a.enum(['available', 'planned', 'disabled']),
			apiKeyRef: a.string(),
			apiSecretRef: a.string(),
			workspaceId: a.string(),
			awsRoleArn: a.string(),
			awsRegion: a.string(),
			baseUrl: a.string(),
			credentialsJson: a.json(),
			verifiedAt: a.datetime(),
			lastVerifyError: a.string(),
			monthlyBudgetUsd: a.float(),
			defaultRunCapUsd: a.float(),
			maxConcurrentJobs: a.integer(),
			notes: a.string(),
		})
		.authorization((allow) => [allow.owner()]),

	NumeraiAccount: a
		.model({
			label: a.string(),
			publicId: a.string().required(),
			secretRef: a.string().required(),
			verifiedAt: a.datetime(),
			lastVerifyError: a.string(),
		})
		.authorization((allow) => [allow.owner()]),

	ComputeJob: a
		.model({
			providerId: a.id(),
			runId: a.id(),
			providerJobId: a.string(),
			name: a.string().required(),
			status: a.enum(['planned', 'queued', 'running', 'completed', 'failed', 'cancelled']),
			estimatedCostUsd: a.float(),
			actualCostUsd: a.float(),
			startedAt: a.datetime(),
			finishedAt: a.datetime(),
			logTail: a.string(),
		})
		.authorization((allow) => [allow.owner()]),

	ApiKey: a
		.model({
			name: a.string().required(),
			keyHash: a.string().required(),
			keyPrefix: a.string().required(),
			lastUsedAt: a.datetime(),
			revokedAt: a.datetime(),
		})
		.secondaryIndexes((index) => [index('keyHash').queryField('apiKeyByHash')])
		.authorization((allow) => [allow.owner()]),

	VerifyResult: a.customType({
		ok: a.boolean().required(),
		verifiedAt: a.datetime(),
		error: a.string(),
		secretRef: a.string(),
		apiKeyRef: a.string(),
		apiSecretRef: a.string(),
	}),

	TrainingActionResult: a.customType({
		ok: a.boolean().required(),
		status: a.string().required(),
		providerJobId: a.string(),
		checkedAt: a.datetime().required(),
		logTail: a.string(),
		error: a.string(),
		costUsd: a.float(),
		metricsJson: a.json(),
		artifactUri: a.string(),
	}),

	SubmitModelResult: a.customType({
		ok: a.boolean().required(),
		status: a.string().required(),
		submissionId: a.string(),
		providerJobId: a.string(),
		roundNumber: a.integer(),
		artifactUri: a.string(),
		checkedAt: a.datetime().required(),
		logTail: a.string(),
		error: a.string(),
	}),

	RefreshRoundMetricsResult: a.customType({
		ok: a.boolean().required(),
		modelId: a.id(),
		submissionId: a.id(),
		roundNumber: a.integer(),
		roundStatus: a.string(),
		datasetVersion: a.string(),
		liveDataUri: a.string(),
		openAt: a.datetime(),
		closeAt: a.datetime(),
		staleAfter: a.datetime(),
		submissionStatus: a.string(),
		liveCorr: a.float(),
		liveMmc: a.float(),
		payoutNmr: a.float(),
		checkedAt: a.datetime().required(),
		notes: a.string(),
		error: a.string(),
	}),

	PrimeOffersResult: a.customType({
		ok: a.boolean().required(),
		checkedAt: a.datetime().required(),
		error: a.string(),
		offersJson: a.string(),
	}),

	NumeraiSubmissionsResult: a.customType({
		ok: a.boolean().required(),
		checkedAt: a.datetime().required(),
		error: a.string(),
		modelsJson: a.string(),
	}),

	verifyNumeraiAccount: a
		.mutation()
		.arguments({
			publicId: a.string().required(),
			secretKey: a.string(),
			secretRef: a.string(),
		})
		.returns(a.ref('VerifyResult'))
		.authorization((allow) => [allow.authenticated()])
		.handler(a.handler.function(verifyNumeraiAccount)),

	verifyComputeProvider: a
		.mutation()
		.arguments({
			providerType: a.string().required(),
			apiKey: a.string(),
			apiSecret: a.string(),
			apiKeyRef: a.string(),
			apiSecretRef: a.string(),
			workspaceId: a.string(),
			awsRoleArn: a.string(),
			awsRegion: a.string(),
			baseUrl: a.string(),
		})
		.returns(a.ref('VerifyResult'))
		.authorization((allow) => [allow.authenticated()])
		.handler(a.handler.function(verifyComputeProvider)),

	startTraining: a
		.mutation()
		.arguments({
			runId: a.id().required(),
			providerId: a.id().required(),
			providerType: a.string().required(),
			apiKeyRef: a.string(),
			apiSecretRef: a.string(),
			baseUrl: a.string(),
			workspaceId: a.string(),
			providerConfigJson: a.json(),
			ownerSub: a.string(),
		})
		.returns(a.ref('TrainingActionResult'))
		.authorization((allow) => [allow.authenticated()])
		.handler(a.handler.function(startTraining)),

	cancelTraining: a
		.mutation()
		.arguments({
			runId: a.id().required(),
			providerId: a.id(),
			providerType: a.string().required(),
			providerJobId: a.string(),
			apiKeyRef: a.string(),
			apiSecretRef: a.string(),
			baseUrl: a.string(),
			workspaceId: a.string(),
			providerConfigJson: a.json(),
			ownerSub: a.string(),
		})
		.returns(a.ref('TrainingActionResult'))
		.authorization((allow) => [allow.authenticated()])
		.handler(a.handler.function(cancelTraining)),

	pollTrainingStatus: a
		.mutation()
		.arguments({
			runId: a.id().required(),
			providerId: a.id(),
			providerType: a.string().required(),
			providerJobId: a.string(),
			apiKeyRef: a.string(),
			apiSecretRef: a.string(),
			baseUrl: a.string(),
			workspaceId: a.string(),
			providerConfigJson: a.json(),
			ownerSub: a.string(),
		})
		.returns(a.ref('TrainingActionResult'))
		.authorization((allow) => [allow.authenticated()])
		.handler(a.handler.function(pollTrainingStatus)),

	submitModel: a
		.mutation()
		.arguments({
			modelId: a.id().required(),
			providerId: a.id(),
			providerType: a.string(),
			numeraiAccountId: a.id(),
			numeraiModelId: a.string(),
			numeraiPublicId: a.string(),
			numeraiSecretRef: a.string(),
			modelArtifactUri: a.string(),
			roundNumber: a.integer(),
			predictionSet: a.string().required(),
			neutralizationPct: a.integer().required(),
			validationMode: a.string().required(),
			uploadEnabled: a.boolean().required(),
			baseUrl: a.string(),
			providerConfigJson: a.json(),
		})
		.returns(a.ref('SubmitModelResult'))
		.authorization((allow) => [allow.authenticated()])
		.handler(a.handler.function(submitModel)),

	refreshRoundMetrics: a
		.mutation()
		.arguments({
			modelId: a.id().required(),
			submissionId: a.id(),
			roundNumber: a.integer().required(),
		})
		.returns(a.ref('RefreshRoundMetricsResult'))
		.authorization((allow) => [allow.authenticated()])
		.handler(a.handler.function(refreshRoundMetrics)),

	fetchPrimeOffers: a
		.query()
		.arguments({
			apiKeyRef: a.string().required(),
			baseUrl: a.string(),
			gpuType: a.string().required(),
			gpuCount: a.integer(),
			maxPrice: a.float(),
		})
		.returns(a.ref('PrimeOffersResult'))
		.authorization((allow) => [allow.authenticated()])
		.handler(a.handler.function(fetchPrimeOffers)),

	fetchNumeraiSubmissions: a
		.mutation()
		.arguments({
			publicId: a.string().required(),
			secretKey: a.string(),
			secretRef: a.string(),
			numeraiModelIds: a.string().array().required(),
			maxRounds: a.integer(),
		})
		.returns(a.ref('NumeraiSubmissionsResult'))
		.authorization((allow) => [allow.authenticated()])
		.handler(a.handler.function(fetchNumeraiSubmissions)),
}).authorization((allow) => [allow.resource(mcpServer).to(['query', 'mutate'])]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
	schema,
	authorizationModes: {
		defaultAuthorizationMode: 'userPool',
	},
});
