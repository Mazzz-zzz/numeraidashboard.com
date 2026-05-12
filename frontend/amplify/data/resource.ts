import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

const schema = a.schema({
	Pipeline: a
		.model({
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
			name: a.string().required(),
			stage: a.enum(['draft', 'testing', 'live', 'retired']),
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

	ComputeProvider: a
		.model({
			name: a.string().required(),
			providerType: a.enum(['prime_intellect', 'modal', 'sagemaker', 'local', 'custom']),
			status: a.enum(['available', 'planned', 'disabled']),
			credentialsJson: a.json(),
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
			secretKey: a.string().required(),
			verifiedAt: a.datetime(),
			lastVerifyError: a.string(),
		})
		.authorization((allow) => [allow.owner()]),

	ComputeJob: a
		.model({
			providerId: a.id(),
			runId: a.id(),
			name: a.string().required(),
			status: a.enum(['planned', 'queued', 'running', 'completed', 'failed', 'cancelled']),
			estimatedCostUsd: a.float(),
			actualCostUsd: a.float(),
			startedAt: a.datetime(),
			finishedAt: a.datetime(),
			logTail: a.string(),
		})
		.authorization((allow) => [allow.owner()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
	schema,
	authorizationModes: {
		defaultAuthorizationMode: 'userPool',
	},
});
