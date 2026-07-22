const MCP_URL = 'https://lacdatamelsv55cio7jpnn5jxe0yvuvm.lambda-url.ap-southeast-2.on.aws/';

type Schema = Record<string, unknown>;

const integer = (description: string, defaultValue?: number, minimum?: number): Schema => ({
	type: 'integer',
	description,
	...(defaultValue === undefined ? {} : { default: defaultValue }),
	...(minimum === undefined ? {} : { minimum })
});

const number = (description: string, defaultValue?: number, minimum?: number, maximum?: number): Schema => ({
	type: 'number',
	description,
	...(defaultValue === undefined ? {} : { default: defaultValue }),
	...(minimum === undefined ? {} : { minimum }),
	...(maximum === undefined ? {} : { maximum })
});

const boolean = (description: string, defaultValue?: boolean): Schema => ({
	type: 'boolean',
	description,
	...(defaultValue === undefined ? {} : { default: defaultValue })
});

const string = (description: string, defaultValue?: string, values?: readonly string[]): Schema => ({
	type: 'string',
	description,
	...(defaultValue === undefined ? {} : { default: defaultValue }),
	...(values === undefined ? {} : { enum: values })
});

const hiddenDims: Schema = {
	type: 'array',
	description: 'Width of each hidden layer.',
	items: { type: 'integer', minimum: 1 },
	default: [512, 512, 512]
};

const gradientDefaults = {
	num_rounds: integer('Maximum boosting rounds. The trainer uses this as n_estimators.', 10000, 1),
	learning_rate: number('Step size for each boosting update.', 0.005, 0),
	max_depth: integer('Maximum tree depth. LightGBM accepts -1 for no limit.', 8),
	early_stopping_rounds: integer('Stop after this many validation rounds without improvement. Zero disables where supported.', 200, 0)
};

const neuralDefaults = {
	num_rounds: integer('Maximum epochs after the trainer applies its model-specific cap of 100.', 100, 1),
	learning_rate: number('Optimizer learning rate.', 0.001, 0),
	dropout: number('Dropout probability.', 0.1, 0, 1),
	noise_std: number('Gaussian feature-noise standard deviation.', 0.05, 0),
	weight_decay: number('Optimizer L2 weight decay.', 0.0001, 0),
	early_stopping_rounds: integer('Validation patience in epochs.', 15, 0)
};

const runConfigProperties: Record<string, Schema> = {
	mode: string('Pipeline mode.', 'train', ['train', 'inference']),
	tournament: string('Numerai tournament.', 'classic', ['classic', 'signals']),
	feature_set: string('Numerai feature set. Signals configurations may use a signals_* value.', 'small', ['small', 'medium', 'all']),
	neutralization_pct: number('Feature neutralization percentage.', 25, 0, 100),
	upload: boolean('Upload predictions after training. Keep false for smoke tests.', false),
	max_train_eras: integer('Limit training eras. Zero uses every available era.', 0, 0),
	multi_target_enabled: boolean('Train the configured collection of targets.', true),
	neutralizer_aware: boolean('Enable neutralizer-aware feature handling.', true),
	sample_weight_aware: boolean('Apply supported sample weights during training.', true)
};

function modelConfig(modelType: string, title: string, description: string, properties: Record<string, Schema>): Schema {
	return {
		title,
		description,
		type: 'object',
		required: ['model_type'],
		additionalProperties: true,
		properties: {
			...runConfigProperties,
			model_type: { type: 'string', const: modelType, description: `Trainer identifier: ${modelType}.` },
			...properties
		}
	};
}

export const documentedModelTypes = [
	'lgbm',
	'xgboost',
	'catboost',
	'mlp',
	'ft_transformer',
	'modern_nca',
	'tabm',
	'tabpfn',
	'tabicl',
	'warpgbm'
] as const;

const modelSchemas: Record<string, Schema> = {
	LightGBMConfig: modelConfig(
		'lgbm',
		'LightGBM',
		'Fast CPU gradient-boosting baseline and the default choice for structured Numerai data. Uses era-aware validation and early stopping. Requires LightGBM and libomp on macOS. [LightGBM documentation](https://lightgbm.readthedocs.io/).',
		{
			...gradientDefaults,
			num_leaves: integer('Maximum leaves per tree.', 512, 2),
			feature_fraction: number('Fraction of columns sampled per tree.', 0.1, 0, 1),
			bagging_fraction: number('Fraction of rows sampled per iteration.', 0.5, 0, 1),
			bagging_freq: integer('Frequency of bagging updates.', 1, 0)
		}
	),
	XGBoostConfig: modelConfig(
		'xgboost',
		'XGBoost',
		'Portable CPU histogram-tree challenger with era-aware early stopping. It maps feature_fraction to colsample_bytree and bagging_fraction to subsample. [XGBoost documentation](https://xgboost.readthedocs.io/).',
		{
			...gradientDefaults,
			feature_fraction: number('Fraction of columns sampled per tree.', 0.1, 0, 1),
			bagging_fraction: number('Training-row subsample ratio.', 0.5, 0, 1)
		}
	),
	CatBoostConfig: modelConfig(
		'catboost',
		'CatBoost',
		'CPU or GPU-package-dependent tree challenger. It is useful for robust, low-touch experiments and uses era-aware validation. [CatBoost documentation](https://catboost.ai/).',
		{
			...gradientDefaults,
			l2_leaf_reg: number('L2 regularization on leaf values.', 3, 0),
			random_strength: number('Randomness used while scoring tree splits.', 1, 0),
			bagging_temperature: number('Bayesian bootstrap intensity.', 0.5, 0),
			border_count: integer('Maximum numerical feature bins.', 128, 1)
		}
	),
	MLPConfig: modelConfig(
		'mlp',
		'MLP',
		'Small PyTorch neural baseline with CUDA, Apple MPS, and CPU support. It supports feature noise, mixup, stochastic weight averaging, warmup, and optional multi-head targets. [PyTorch neural-network documentation](https://pytorch.org/docs/stable/nn.html).',
		{
			...neuralDefaults,
			hidden_dims: hiddenDims,
			batch_size: integer('Rows per optimizer step.', 8192, 1),
			mixup_alpha: number('Beta-distribution alpha for mixup. Zero disables mixup.', 0, 0),
			swa: boolean('Enable stochastic weight averaging.', false),
			swa_start_frac: number('Fraction of training after which SWA starts.', 0.5, 0, 1),
			warmup_epochs: integer('Learning-rate warmup epochs.', 0, 0),
			multi_head: boolean('Use a separate prediction head for each target.', false)
		}
	),
	FTTransformerConfig: modelConfig(
		'ft_transformer',
		'FT-Transformer',
		'PyTorch feature-token transformer for learning interactions through self-attention. Runs on CUDA, Apple MPS, or CPU and is useful when testing signal orthogonal to tree ensembles. [RTDL reference implementation](https://github.com/yandex-research/rtdl-revisiting-models).',
		{
			...neuralDefaults,
			learning_rate: number('Optimizer learning rate.', 0.0001, 0),
			weight_decay: number('Optimizer L2 weight decay.', 0.001, 0),
			d_token: integer('Embedding width for each numerical feature token.', 192, 1),
			n_blocks: integer('Transformer block count.', 3, 1),
			n_heads: integer('Attention head count. Must divide d_token.', 8, 1),
			attn_dropout: number('Attention dropout probability.', 0.2, 0, 1),
			ff_dropout: number('Feed-forward dropout probability.', 0.1, 0, 1),
			batch_size: integer('Rows per optimizer step.', 1024, 1)
		}
	),
	ModernNCAConfig: modelConfig(
		'modern_nca',
		'ModernNCA',
		'Neural nearest-neighbor model that learns an embedding and predicts from neighbor relationships. Runs on CUDA, Apple MPS, or CPU. [ModernNCA paper](https://huggingface.co/papers/2407.03257).',
		{
			...neuralDefaults,
			hidden_dims: { ...hiddenDims, default: [512, 512] },
			d_embedding: integer('Learned embedding width.', 128, 1),
			n_neighbors: integer('Neighbors used for prediction.', 64, 1),
			batch_size: integer('Rows per optimizer step.', 4096, 1)
		}
	),
	TabMConfig: modelConfig(
		'tabm',
		'TabM',
		'Parameter-efficient MLP ensemble using shared weights and per-member BatchEnsemble scaling vectors. It offers ensemble diversity at roughly single-MLP parameter cost and runs on CUDA, Apple MPS, or CPU. [TabM repository](https://github.com/yandex-research/tabm).',
		{
			...neuralDefaults,
			hidden_dims: hiddenDims,
			n_ensemble: integer('Number of BatchEnsemble members.', 16, 1),
			batch_size: integer('Rows per optimizer step.', 8192, 1)
		}
	),
	TabPFNConfig: modelConfig(
		'tabpfn',
		'TabPFN',
		'Pretrained in-context tabular learner. Training stores bagged context rows instead of fitting new weights, providing a different inductive bias for MMC experiments. Supports CUDA, Apple MPS, or CPU. [TabPFN repository](https://github.com/PriorLabs/TabPFN).',
		{
			n_bags: integer('Independent context bags.', 8, 1),
			context_rows: integer('Maximum context rows per bag.', 10000, 1),
			features_per_bag: integer('Feature subset size per bag.', 500, 1),
			n_recent_eras: integer('Most recent eras eligible for context selection.', 24, 1),
			n_estimators_per_bag: integer('TabPFN estimators used for each bag.', 4, 1),
			device: string('Execution device.', 'auto', ['auto', 'cuda', 'mps', 'cpu'])
		}
	),
	TabICLConfig: modelConfig(
		'tabicl',
		'TabICL',
		'Open column-row-dataset transformer for scalable in-context prediction. It supports offloading and mixed precision. The local runner defaults TabICL to CPU on Apple Silicon for stability unless NUMERAI_TABICL_ALLOW_MPS=1 is set. [TabICL documentation](https://tabicl.readthedocs.io/en/latest/).',
		{
			n_bags: integer('Independent context bags.', 12, 1),
			context_rows: integer('Maximum context rows per bag.', 50000, 1),
			features_per_bag: integer('Feature subset size per bag. TabICL caps this at 100.', 42, 1),
			n_recent_eras: integer('Most recent eras eligible for context selection.', 48, 1),
			n_estimators_per_bag: integer('TabICL estimators used for each bag.', 16, 1),
			norm_methods: string('all, default, or a comma-separated normalization list.', 'all'),
			device: string('Requested execution device.', 'auto', ['auto', 'cuda', 'mps', 'cpu']),
			offload_mode: string('TabICL offload behavior.', 'auto'),
			use_amp: { description: 'Automatic mixed precision setting.', oneOf: [{ type: 'boolean' }, { type: 'string', const: 'auto' }], default: 'auto' },
			use_fa3: { description: 'FlashAttention 3 setting.', oneOf: [{ type: 'boolean' }, { type: 'string', const: 'auto' }], default: 'auto' },
			batch_size: integer('Inference batch size.', 16, 1)
		}
	),
	WarpGBMConfig: modelConfig(
		'warpgbm',
		'WarpGBM',
		'GPU-native gradient boosting with tensor-op kernels (CUDA upstream; Apple-Silicon MPS and CPU via the mps-support fork). Pre-binned int8 features hit its fast path; era_buckets above 1 enables Directional Era-Splitting. [WarpGBM repository](https://github.com/jefferythewind/warpgbm).',
		{
			num_rounds: integer('Boosting rounds (trees).', 2000, 1),
			learning_rate: number('Step size for each boosting update.', 0.01, 0),
			max_depth: integer('Maximum tree depth.', 6, 1),
			min_data_in_leaf: integer('Minimum rows per leaf (maps to min_child_weight).', 10000, 1),
			feature_fraction: number('Fraction of columns sampled per tree.', 0.5, 0, 1),
			max_bin: integer('Histogram bins (2-127; 8 is lossless for 5-bin Numerai features).', 8, 2),
			era_buckets: integer('Era groups for Directional Era-Splitting. 1 disables invariant splitting (recommended).', 1, 1)
		}
	)
};

const id = (description: string): Schema => ({ type: 'string', minLength: 1, description });
const limit: Schema = { type: 'integer', minimum: 1, maximum: 100, default: 20 };

const toolSchemas: Record<string, Schema> = {
	ListModelsInput: {
		type: 'object',
		description: 'Input for list_models. Lists owned registry models and complete Builder run configs.',
		properties: { stage: string('Lifecycle filter.', undefined, ['draft', 'training', 'success', 'failed', 'testing', 'live', 'retired']), limit }
	},
	CreateModelInput: {
		type: 'object',
		description: 'Input for create_model. Creates Builder-compatible drafts; the operation is not idempotent.',
		required: ['model_type'],
		properties: {
			model_type: string('Trainer model identifier.', undefined, documentedModelTypes),
			name: string('Optional base model name.'),
			run_config: { description: 'Complete Builder run configuration. Model-specific extra fields are preserved.', oneOf: Object.keys(modelSchemas).map((name) => ({ $ref: `#/components/schemas/${name}` })) },
			change_summary: string('Registry change summary.'),
			parent_model_id: id('Owned parent model ID for lineage.'),
			template: string('Registry template.', 'custom', ['baseline', 'challenger', 'ensemble', 'custom']),
			sweep: {
				type: 'object',
				required: ['parameter', 'values'],
				properties: {
					parameter: string('Top-level run_config field to vary.'),
					values: { type: 'array', minItems: 1, maxItems: 64, items: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } },
					max_runs: { type: 'integer', minimum: 1, maximum: 64 }
				}
			}
		}
	},
	UpdateModelInput: {
		type: 'object',
		description: 'Input for update_model. At least one editable field is required.',
		required: ['model_id'],
		properties: {
			model_id: id('Owned model ID.'),
			name: string('New non-empty model name.'),
			stage: string('New lifecycle stage.', undefined, ['draft', 'training', 'success', 'failed', 'testing', 'live', 'retired']),
			change_summary: { type: ['string', 'null'], description: 'New summary; null clears it.' },
			parent_model_id: { type: ['string', 'null'], description: 'Owned parent model ID; null clears it.' },
			numerai_model_id: { type: ['string', 'null'], description: 'Linked Numerai model ID; null clears it.' },
			run_config: { type: 'object', description: 'Replacement configuration containing model_type or modelType.', additionalProperties: true }
		}
	},
	DeleteModelInput: {
		type: 'object',
		description: 'Input for delete_model. Permanently deletes the registry model; training-run history remains.',
		required: ['model_id'],
		properties: { model_id: id('Owned model ID.') }
	},
	ListComputeProvidersInput: {
		type: 'object',
		description: 'Input for list_compute_providers. Secret values and credential references are never returned.',
		properties: {
			provider_type: string('Provider filter.', undefined, ['prime_intellect', 'modal', 'sagemaker', 'local', 'custom']),
			status: string('Availability filter.', undefined, ['available', 'planned', 'disabled']),
			limit
		}
	},
	ListTrainingRunsInput: {
		type: 'object',
		description: 'Input for list_training_runs. Returns configuration, status, metrics, cost, logs, and artifacts when present.',
		properties: { status: string('Run-status filter.', undefined, ['queued', 'running', 'completed', 'failed', 'cancelled']), limit }
	},
	LaunchModelTrainingInput: {
		type: 'object',
		description: 'Input for launch_model_training. Creates a run from a registry draft. For local providers omit compute_type; MCP queues work for the normal worker and never contacts localhost.',
		required: ['model_id', 'provider_id'],
		properties: {
			model_id: id('Model returned by create_model or list_models.'),
			provider_id: id('Provider returned by list_compute_providers.'),
			compute_type: string('Modal-only compute selection. Never supply this for local providers.'),
			max_spend_usd: number('Optional non-negative budget.', undefined, 0)
		}
	},
	LaunchTrainingRunInput: {
		type: 'object',
		description: 'Input for launch_training_run. Launches an existing queued or failed run; use launch_model_training for a Builder draft.',
		required: ['run_id'],
		properties: {
			run_id: id('Existing training-run ID.'),
			provider_id: id('Optional owned provider override.'),
			compute_type: string('Modal-only compute type.', undefined, ['cpu', 't4', 'a10g', 'l4', 'a100', 'h100'])
		}
	},
	PollTrainingStatusInput: {
		type: 'object',
		description: 'Input for poll_training_status. Local polling reads daemon-pushed cloud state and never starts or polls a second workstation job.',
		required: ['run_id'],
		properties: { run_id: id('Training-run ID.') }
	},
	CancelRunInput: {
		type: 'object',
		description: 'Input for cancel_run. Cancellation is destructive but idempotent while processing.',
		required: ['run_id'],
		properties: { run_id: id('Queued or active training-run ID.') }
	},
	ListSubmissionsInput: {
		type: 'object',
		description: 'Input for list_submissions. Creating submissions is not currently exposed through MCP.',
		properties: { model_id: id('Optional owned model filter.'), status: string('Optional submission-status filter.'), limit }
	},
	GetNumeraiAccountInput: {
		type: 'object',
		description: 'Input for get_numerai_account. Takes no arguments. Returns the linked Numerai account (masked public ID, verification status, username) and its Numerai models; use the returned model ids with update_model.numerai_model_id. Secrets are never returned.',
		properties: {}
	},
	JsonRpcToolCall: {
		type: 'object',
		description: 'MCP JSON-RPC tools/call envelope. MCP clients construct this automatically.',
		required: ['jsonrpc', 'id', 'method', 'params'],
		properties: {
			jsonrpc: { type: 'string', const: '2.0' },
			id: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
			method: { type: 'string', const: 'tools/call' },
			params: {
				type: 'object',
				required: ['name'],
				properties: {
					name: string('Public MCP tool name.', undefined, [
						'list_models', 'create_model', 'update_model', 'delete_model', 'list_compute_providers',
						'list_training_runs', 'launch_model_training', 'launch_training_run', 'poll_training_status',
						'cancel_run', 'list_submissions', 'get_numerai_account'
					]),
					arguments: { type: 'object', additionalProperties: true }
				}
			}
		}
	}
};

const overview = `
Numerai Dashboard is a model-centered training control plane. Builder creates model drafts, Models keeps the canonical registry, and Launch creates training attempts on an owned compute provider.

## MCP endpoint

\`${MCP_URL}\`

Use a remote Streamable HTTP MCP client with OAuth 2.1 (recommended) or a dashboard MCP API key. Records are scoped to the authenticated owner.

## End-to-end flow

1. Call \`create_model\` with a supported \`model_type\` and Builder-compatible \`run_config\`.
2. Call \`list_compute_providers\` and select an available provider.
3. Call \`launch_model_training\` exactly once with the model and provider IDs.
4. Poll the returned run ID with \`poll_training_status\`.
5. Inspect metrics, logs, and the artifact URI with \`list_training_runs\`.

For a local Mac provider, do not pass \`compute_type\`, do not call localhost, and do not use Modal as a fallback. MCP queues the run; the normal workstation worker claims it through outbound polling and reports progress back to the dashboard.

## Data ownership

- **ModelRegistryItem** is the canonical model lifecycle, lineage, configuration, and latest-run pointer.
- **TrainingRun** stores attempt history, configuration, metrics, artifact URI, and logs.
- **ComputeJob** stores provider-job status, cost, and provider logs.
- **ComputeProvider** stores provider settings and secret references; MCP returns only safe metadata.

Training runs and compute jobs are retained for audit even when a model is deleted. Tool errors use MCP \`isError: true\` results with a human-readable explanation.
`;

export const docsSpec: Record<string, unknown> = {
	openapi: '3.1.0',
	info: {
		title: 'Numerai Dashboard',
		version: '1.0.0',
		description: overview,
		contact: { name: 'Numerai Dashboard on GitHub', url: 'https://github.com/Mazzz-zzz/numeraidashboard.com' }
	},
	externalDocs: {
		description: 'MCP guides in the repository',
		url: 'https://github.com/Mazzz-zzz/numeraidashboard.com/tree/main/docs/mcp'
	},
	servers: [{ url: MCP_URL, description: 'Hosted authenticated MCP endpoint' }],
	tags: [
		{
			name: 'MCP protocol',
			description: 'The endpoint implements MCP over Streamable HTTP. Use an MCP client rather than hand-writing JSON-RPC. This operation documents the wire contract and is not a separate REST action.'
		}
	],
	paths: {
		'/': {
			post: {
				tags: ['MCP protocol'],
				summary: 'Send an MCP request',
				description: 'Authenticated MCP Streamable HTTP entry point. Initialize a session, discover tools, and invoke tools through a compatible MCP client.',
				operationId: 'mcpStreamableHttp',
				security: [{ oauth2: [] }, { apiKey: [] }],
				parameters: [
					{ name: 'MCP-Protocol-Version', in: 'header', required: false, schema: { type: 'string' }, description: 'MCP protocol version negotiated by the client.' },
					{ name: 'Mcp-Session-Id', in: 'header', required: false, schema: { type: 'string' }, description: 'Session identifier returned during initialization when required.' }
				],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/JsonRpcToolCall' } } }
				},
				responses: {
					'200': {
						description: 'MCP JSON-RPC response or server-sent event stream.',
						content: {
							'application/json': { schema: { type: 'object', additionalProperties: true } },
							'text/event-stream': { schema: { type: 'string' } }
						}
					},
					'401': { description: 'Missing or invalid OAuth bearer token or MCP API key.' },
					'400': { description: 'Invalid MCP or JSON-RPC request.' }
				}
			}
		}
	},
	components: {
		securitySchemes: {
			oauth2: {
				type: 'oauth2',
				description: 'OAuth 2.1 authorization-code flow with PKCE discovered from the MCP protected-resource metadata.',
				flows: { authorizationCode: { authorizationUrl: 'https://dev-vqnvfeioumdl2k4k.us.auth0.com/authorize', tokenUrl: 'https://dev-vqnvfeioumdl2k4k.us.auth0.com/oauth/token', scopes: {} } }
			},
			apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Dashboard-issued MCP API key.' }
		},
		schemas: { ...toolSchemas, ...modelSchemas }
	}
};
