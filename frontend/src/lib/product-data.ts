export const computeProviders = [
	{
		id: 'prime',
		name: 'Prime Intellect',
		status: 'planned',
		type: 'decentralized GPU',
		cost: '$$',
		speed: 'batch scale',
		body: 'Route larger sweeps to distributed accelerator capacity when the queue or budget calls for it.'
	},
	{
		id: 'modal',
		name: 'Modal',
		status: 'available',
		type: 'serverless GPU',
		cost: '$$',
		speed: 'fast start',
		body: 'Spin up short-lived GPU workers for smoke tests, challenger runs, and validation jobs.'
	},
	{
		id: 'sagemaker',
		name: 'SageMaker',
		status: 'available',
		type: 'managed cloud',
		cost: '$$$',
		speed: 'managed jobs',
		body: 'Run reproducible managed jobs with stored configs, logs, costs, and training metadata.'
	},
	{
		id: 'local',
		name: 'Local GPU',
		status: 'available',
		type: 'owned hardware',
		cost: '$',
		speed: 'developer loop',
		body: 'Queue experiments to your own workstation while keeping results in the dashboard.'
	}
] as const;

export const modelTemplates = [
	{
		id: 'baseline',
		name: 'Baseline',
		risk: 'low',
		runTime: 'short',
		body: 'A cheap smoke test to verify the data path, feature set, training job, and result capture.'
	},
	{
		id: 'challenger',
		name: 'Challenger',
		risk: 'medium',
		runTime: 'medium',
		body: 'A stronger candidate configuration for deciding whether an idea deserves a larger sweep.'
	},
	{
		id: 'ensemble',
		name: 'Ensemble',
		risk: 'medium',
		runTime: 'compare',
		body: 'A blend/comparison pass for testing whether multiple candidate predictions improve the signal.'
	}
] as const;

export const liveModels = [
	{
		id: 'prod-alpha',
		name: 'Production Alpha',
		stage: 'live',
		corr: '+0.0184',
		mmc: '+0.0061',
		payout: '+2.4 NMR',
		parent: 'Challenger branch',
		status: 'submitting this round'
	},
	{
		id: 'candidate-042',
		name: 'Candidate 042',
		stage: 'testing',
		corr: '+0.0142',
		mmc: '+0.0048',
		payout: 'pending',
		parent: 'baseline-v4',
		status: 'ready to compare'
	},
	{
		id: 'ensemble-a',
		name: 'Ensemble A',
		stage: 'draft',
		corr: '+0.0119',
		mmc: '+0.0050',
		payout: 'not submitted',
		parent: 'candidate-042',
		status: 'needs validation'
	}
] as const;

export const lineageBranches = [
	{
		id: 'baseline-v4',
		name: 'baseline-v4',
		delta: 'original preset',
		score: '+0.0069',
		children: ['neutralization-75', 'lr-sweep', 'ensemble-candidate']
	},
	{
		id: 'neutralization-75',
		name: 'neutralization-75',
		delta: 'changed neutralization',
		score: '+0.0091',
		children: []
	},
	{
		id: 'lr-sweep',
		name: 'lr-sweep',
		delta: 'fine parameter sweep',
		score: '+0.0118',
		children: ['lr-sweep-top-3']
	},
	{
		id: 'ensemble-candidate',
		name: 'ensemble-candidate',
		delta: 'added blend node',
		score: '+0.0104',
		children: []
	},
	{
		id: 'lr-sweep-top-3',
		name: 'lr-sweep-top-3',
		delta: 'branched winner',
		score: '+0.0132',
		children: []
	}
] as const;
