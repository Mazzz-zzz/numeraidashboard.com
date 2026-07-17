import { describe, expect, it, vi } from 'vitest';
import { McpControlPlane, hashMcpApiKey, localLaunchRequest, ownerSub } from './control-plane';

const rawKey = `nd_mcp_${'A'.repeat(32)}`;

describe('MCP control-plane security', () => {
	it('hashes API keys deterministically and never stores the raw key', () => {
		expect(hashMcpApiKey(rawKey)).toMatch(/^[a-f0-9]{64}$/);
		expect(hashMcpApiKey(rawKey)).not.toContain(rawKey);
		expect(hashMcpApiKey(rawKey)).toBe(hashMcpApiKey(rawKey));
	});

	it('normalizes the Amplify owner value to the Cognito subject', () => {
		expect(ownerSub('user-1::person@example.com')).toBe('user-1');
		expect(ownerSub('user-2')).toBe('user-2');
		expect(ownerSub(null)).toBeNull();
	});

	it('authenticates an active key by hash and records last use', async () => {
		const apiKeyByHash = vi.fn().mockResolvedValue({
			data: [{ id: 'key-1', owner: 'user-1::person@example.com', revokedAt: null }],
		});
		const update = vi.fn().mockResolvedValue({ data: { id: 'key-1' } });
		const plane = new McpControlPlane({ models: { ApiKey: { apiKeyByHash, update } } } as never);

		await expect(plane.authenticate(rawKey)).resolves.toEqual({ ownerSub: 'user-1' });
		expect(apiKeyByHash).toHaveBeenCalledWith({
			keyHash: hashMcpApiKey(rawKey),
		});
		expect(update).toHaveBeenCalledWith({
			id: 'key-1',
			lastUsedAt: expect.any(String),
		});
	});

	it('rejects malformed and revoked keys', async () => {
		const apiKeyByHash = vi.fn().mockResolvedValue({
			data: [{ id: 'key-1', owner: 'user-1', revokedAt: '2026-07-16T00:00:00.000Z' }],
		});
		const plane = new McpControlPlane({ models: { ApiKey: { apiKeyByHash } } } as never);

		await expect(plane.authenticate('not-a-key')).resolves.toBeNull();
		expect(apiKeyByHash).not.toHaveBeenCalled();
		await expect(plane.authenticate(rawKey)).resolves.toBeNull();
	});

	it('filters and rechecks ownership before returning training runs', async () => {
		const list = vi.fn().mockResolvedValue({
			data: [
				{
					id: 'run-1', owner: 'user-1::person@example.com', pipelineId: 'pipe-1', status: 'queued',
					configJson: { model_type: 'lgbm', feature_set: 'small' },
				},
				{ id: 'run-foreign', owner: 'user-10::other@example.com', pipelineId: 'pipe-x', status: 'queued' },
			],
		});
		const plane = new McpControlPlane({ models: { TrainingRun: { list } } } as never);
		const runs = await plane.listTrainingRuns(
			{ ownerSub: 'user-1' },
			{ status: 'queued', limit: 500 }
		);

		expect(list).toHaveBeenCalledWith({
			filter: {
				and: [
					{
						or: [
							{ owner: { eq: 'user-1' } },
							{ owner: { beginsWith: 'user-1::' } },
						],
					},
					{ status: { eq: 'queued' } },
				],
			},
			limit: 100,
		});
		expect(runs).toHaveLength(1);
		expect(runs[0]?.id).toBe('run-1');
		expect(runs[0]?.configJson).toEqual({ model_type: 'lgbm', feature_set: 'small' });
	});

	it('lists safe provider metadata without returning credentials', async () => {
		const list = vi.fn().mockResolvedValue({
			data: [
				{
					id: 'provider-local', owner: 'user-1::person@example.com', name: 'Mac Studio',
					providerType: 'local', status: 'available', verifiedAt: '2026-07-17T12:00:00.000Z',
					apiKeyRef: '/secret/key', credentialsJson: { token: 'secret' },
				},
				{ id: 'provider-foreign', owner: 'user-10', name: 'Other', providerType: 'local' },
			],
		});
		const plane = new McpControlPlane({ models: { ComputeProvider: { list } } } as never);

		const providers = await plane.listComputeProviders(
			{ ownerSub: 'user-1' },
			{ providerType: 'local', status: 'available', limit: 10 }
		);

		expect(list).toHaveBeenCalledWith({
			filter: {
				and: [
					{
						or: [
							{ owner: { eq: 'user-1' } },
							{ owner: { beginsWith: 'user-1::' } },
						],
					},
					{ providerType: { eq: 'local' } },
					{ status: { eq: 'available' } },
				],
			},
			limit: 10,
		});
		expect(providers).toHaveLength(1);
		expect(providers[0]).toMatchObject({
			id: 'provider-local', name: 'Mac Studio', providerType: 'local', status: 'available',
		});
		expect(providers[0]).not.toHaveProperty('apiKeyRef');
		expect(providers[0]).not.toHaveProperty('credentialsJson');
	});

	it('lists owned Builder models with parsed runConfig and model type', async () => {
		const list = vi.fn().mockResolvedValue({
			data: [
				{
					id: 'model-tabm', owner: 'user-1::person@example.com', name: 'TabM K16', stage: 'draft',
					lineageJson: JSON.stringify({ runConfig: { model_type: 'tabm', n_ensemble: 16 } }),
				},
				{ id: 'model-foreign', owner: 'user-10', name: 'Other', stage: 'draft' },
			],
		});
		const plane = new McpControlPlane({ models: { ModelRegistryItem: { list } } } as never);

		const models = await plane.listModels({ ownerSub: 'user-1' }, { stage: 'draft', limit: 10 });

		expect(list).toHaveBeenCalledWith({
			filter: {
				and: [
					{
						or: [
							{ owner: { eq: 'user-1' } },
							{ owner: { beginsWith: 'user-1::' } },
						],
					},
					{ stage: { eq: 'draft' } },
				],
			},
			limit: 10,
		});
		expect(models).toEqual([
			expect.objectContaining({
				id: 'model-tabm', name: 'TabM K16', stage: 'draft', modelType: 'tabm',
				runConfig: { model_type: 'tabm', n_ensemble: 16 },
			}),
		]);
	});

	it('creates an owner-scoped TabM Builder draft with defaults and complete model configuration', async () => {
		const create = vi.fn().mockImplementation(async (input) => ({
			data: { id: 'model-tabm', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z', ...input },
		}));
		const plane = new McpControlPlane({
			models: { ModelRegistryItem: { create } },
		} as never);

		const result = await plane.createModel(
			{ ownerSub: 'user-1' },
			{
				name: 'Mac Studio TabM smoke',
				modelType: 'tabm',
				template: 'challenger',
				runConfig: {
					feature_set: 'medium', n_ensemble: 8, hidden_dims: [256, 128],
					batch_size: 1024, max_train_eras: 2,
				},
			}
		);

		expect(create).toHaveBeenCalledWith(expect.objectContaining({
			owner: 'user-1',
			name: 'Mac Studio TabM smoke',
			stage: 'draft',
		}));
		expect(JSON.parse(create.mock.calls[0]?.[0].lineageJson)).toEqual({
			source: 'mcp',
			template: 'challenger',
			runConfig: {
				mode: 'train', tournament: 'classic', feature_set: 'medium', neutralization_pct: 25,
				upload: false, model_type: 'tabm', n_ensemble: 8, hidden_dims: [256, 128],
				batch_size: 1024, max_train_eras: 2,
			},
			sweep: null,
		});
		expect(result).toEqual({
			count: 1,
			models: [expect.objectContaining({
				id: 'model-tabm', name: 'Mac Studio TabM smoke', stage: 'draft', modelType: 'tabm',
				runConfig: expect.objectContaining({ model_type: 'tabm', n_ensemble: 8, max_train_eras: 2 }),
			})],
		});
	});

	it('creates a bounded sweep as independent launchable model drafts', async () => {
		let id = 0;
		const create = vi.fn().mockImplementation(async (input) => ({
			data: { id: `model-${++id}`, createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z', ...input },
		}));
		const plane = new McpControlPlane({ models: { ModelRegistryItem: { create } } } as never);

		const result = await plane.createModel(
			{ ownerSub: 'user-1' },
			{
				name: 'TabM ensemble sweep',
				modelType: 'tabm',
				runConfig: { max_train_eras: 1 },
				sweep: { parameter: 'n_ensemble', values: [4, 8, 16], maxRuns: 2 },
			}
		);

		expect(create).toHaveBeenCalledTimes(2);
		expect(create.mock.calls[0]?.[0]).toMatchObject({
			name: 'TabM ensemble sweep n_ensemble=4',
		});
		expect(JSON.parse(create.mock.calls[0]?.[0].lineageJson)).toMatchObject({
			runConfig: { model_type: 'tabm', n_ensemble: 4 },
			sweep: { parameter: 'n_ensemble', value: 4, values: [4, 8] },
		});
		expect(create.mock.calls[1]?.[0]).toMatchObject({
			name: 'TabM ensemble sweep n_ensemble=8',
		});
		expect(JSON.parse(create.mock.calls[1]?.[0].lineageJson)).toMatchObject({
			runConfig: { n_ensemble: 8 },
		});
		expect(result.count).toBe(2);
	});

	it('rejects contradictory model types before creating a draft', async () => {
		const create = vi.fn();
		const plane = new McpControlPlane({ models: { ModelRegistryItem: { create } } } as never);

		await expect(plane.createModel(
			{ ownerSub: 'user-1' },
			{ modelType: 'tabm', runConfig: { model_type: 'lgbm' } }
		)).rejects.toThrow(/must match/);
		expect(create).not.toHaveBeenCalled();
	});

	it('updates and deletes only owner-scoped model records', async () => {
		let model = {
			id: 'model-1', owner: 'user-1', name: 'Old', stage: 'draft',
			lineageJson: { source: 'mcp', runConfig: { model_type: 'lgbm' } },
		};
		const get = vi.fn().mockImplementation(async () => ({ data: model }));
		const update = vi.fn().mockImplementation(async (patch) => ({ data: (model = { ...model, ...patch }) }));
		const remove = vi.fn().mockImplementation(async () => ({ data: model }));
		const plane = new McpControlPlane({
			models: { ModelRegistryItem: { get, update, delete: remove } },
		} as never);

		const updated = await plane.updateModelDraft(
			{ ownerSub: 'user-1' },
			{ modelId: 'model-1', name: 'TabM updated', runConfig: { model_type: 'tabm', n_ensemble: 4 } }
		);
		expect(update).toHaveBeenCalledWith(expect.objectContaining({
			id: 'model-1', name: 'TabM updated',
		}));
		expect(JSON.parse(update.mock.calls[0]?.[0].lineageJson)).toEqual({
			source: 'mcp', runConfig: { model_type: 'tabm', n_ensemble: 4 },
		});
		expect(updated).toMatchObject({ name: 'TabM updated', modelType: 'tabm' });

		await expect(plane.deleteModel(
			{ ownerSub: 'user-1' }, { modelId: 'model-1' }
		)).resolves.toMatchObject({ deleted: true, model: { id: 'model-1' } });
		expect(remove).toHaveBeenCalledWith({ id: 'model-1' });

		get.mockResolvedValueOnce({ data: { ...model, owner: 'user-2' } });
		await expect(plane.deleteModel(
			{ ownerSub: 'user-1' }, { modelId: 'model-1' }
		)).rejects.toThrow('Model not found.');
	});

	it('creates and queues an owned TabM run from a Builder model on the local provider', async () => {
		let model = {
			id: 'model-tabm', owner: 'user-1', name: 'TabM K16', stage: 'draft',
			changeSummary: 'TabM smoke test',
			lineageJson: JSON.stringify({
				template: 'challenger',
				runConfig: {
					mode: 'train', model_type: 'tabm', feature_set: 'small', neutralization_pct: 25,
					n_ensemble: 16, hidden_dims: [256, 128], max_train_eras: 20,
				},
			}),
		};
		const provider = {
			id: 'provider-local', owner: 'user-1', name: 'Mac Studio', providerType: 'local', status: 'available',
		};
		let createdRun: Record<string, unknown> | null = null;
		const createRun = vi.fn().mockImplementation(async (input) => {
			createdRun = { id: 'run-tabm', ...input };
			return { data: createdRun };
		});
		const updateRun = vi.fn().mockImplementation(async (patch) => ({ data: { ...createdRun, ...patch } }));
		const updateModel = vi.fn().mockImplementation(async (patch) => {
			model = { ...model, ...patch };
			return { data: model };
		});
		const client = {
			models: {
				ModelRegistryItem: {
					get: vi.fn().mockResolvedValue({ data: model }),
					update: updateModel,
				},
				Pipeline: {
					get: vi.fn(),
					create: vi.fn().mockResolvedValue({
						data: { id: 'pipe-tabm', owner: 'user-1', name: 'TabM K16', status: 'testing' },
					}),
					update: vi.fn().mockResolvedValue({
						data: { id: 'pipe-tabm', owner: 'user-1', name: 'TabM K16', status: 'testing', activeBranchId: 'branch-tabm' },
					}),
				},
				ModelBranch: {
					get: vi.fn(),
					create: vi.fn().mockResolvedValue({
						data: { id: 'branch-tabm', owner: 'user-1', pipelineId: 'pipe-tabm', status: 'queued' },
					}),
				},
				TrainingRun: {
					create: createRun,
					get: vi.fn().mockImplementation(async () => ({ data: createdRun })),
					update: updateRun,
				},
				ComputeProvider: { get: vi.fn().mockResolvedValue({ data: provider }) },
				ComputeJob: {
					list: vi.fn().mockResolvedValue({ data: [] }),
					create: vi.fn().mockImplementation(async (input) => ({ data: { id: 'job-tabm', ...input } })),
				},
			},
			mutations: { startTraining: vi.fn() },
		};
		const plane = new McpControlPlane(client as never);

		const result = await plane.launchModelTraining(
			{ ownerSub: 'user-1' },
			{ modelId: 'model-tabm', providerId: 'provider-local' }
		);

		expect(createRun).toHaveBeenCalledWith(expect.objectContaining({
			owner: 'user-1', pipelineId: 'pipe-tabm', branchId: 'branch-tabm', providerId: 'provider-local',
			modelTemplate: 'challenger', status: 'queued',
		}));
		expect(JSON.parse(createRun.mock.calls[0]?.[0].configJson)).toMatchObject({
			model_type: 'tabm', n_ensemble: 16, hidden_dims: [256, 128], max_train_eras: 20,
			modelId: 'model-tabm', modelName: 'TabM K16',
		});
		expect(client.mutations.startTraining).not.toHaveBeenCalled();
		expect(result.action.status).toBe('queued');
		expect(result.run.providerId).toBe('provider-local');
		expect(result.job).toMatchObject({ id: 'job-tabm', runId: 'run-tabm', providerId: 'provider-local' });
		expect(result.model).toMatchObject({ id: 'model-tabm', stage: 'training', runId: 'run-tabm', modelType: 'tabm' });
		expect(localLaunchRequest('run-tabm', result.run.configJson)).toEqual({
			runId: 'run-tabm',
			model_type: 'tabm',
			feature_set: 'small',
			neutralization_pct: 25,
			upload: false,
			hyperparams: {
				n_ensemble: 16,
				hidden_dims: [256, 128],
				max_train_eras: 20,
			},
		});
		expect(updateModel).toHaveBeenCalledWith(expect.objectContaining({
			id: 'model-tabm', pipelineId: 'pipe-tabm', branchId: 'branch-tabm', runId: 'run-tabm',
		}));
	});

	it('launches through the shared mutation and persists owner-scoped run/job state', async () => {
		const startTraining = vi.fn().mockResolvedValue({
			data: {
				ok: true,
				status: 'queued',
				providerJobId: 'modal-job-1',
				checkedAt: '2026-07-16T10:00:00.000Z',
				logTail: 'queued',
			},
		});
		const createJob = vi.fn().mockResolvedValue({
			data: {
				id: 'job-1',
				owner: 'user-1::person@example.com',
				name: 'MCP training run-1',
				runId: 'run-1',
				providerId: 'provider-1',
				providerJobId: 'modal-job-1',
				status: 'queued',
			},
		});
		const client = {
			models: {
				TrainingRun: {
					get: vi.fn().mockResolvedValue({
						data: { id: 'run-1', owner: 'user-1', pipelineId: 'pipe-1', providerId: 'provider-1', status: 'queued' },
					}),
					update: vi.fn().mockResolvedValue({
						data: { id: 'run-1', owner: 'user-1', pipelineId: 'pipe-1', providerId: 'provider-1', status: 'queued' },
					}),
				},
				ComputeProvider: {
					get: vi.fn().mockResolvedValue({
						data: {
							id: 'provider-1',
							owner: 'user-1',
							name: 'Modal',
							providerType: 'modal',
							status: 'available',
							apiKeyRef: '/numeraidashboard/user-1/provider/key/api-key',
						},
					}),
				},
				ComputeJob: {
					list: vi.fn().mockResolvedValue({ data: [] }),
					create: createJob,
				},
			},
			mutations: { startTraining },
		};
		const plane = new McpControlPlane(client as never);

		const result = await plane.launchTrainingRun(
			{ ownerSub: 'user-1' },
			{ runId: 'run-1' }
		);

		expect(startTraining).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: 'run-1',
				providerId: 'provider-1',
				providerType: 'modal',
				ownerSub: 'user-1',
			})
		);
		expect(startTraining.mock.calls[0]?.[0]).not.toHaveProperty('providerJobId');
		expect(createJob).toHaveBeenCalledWith(expect.objectContaining({
			owner: 'user-1',
			providerId: 'provider-1',
			runId: 'run-1',
			name: 'MCP training run-1',
			status: 'queued',
			providerJobId: 'modal-job-1',
		}));
		expect(result.job).toMatchObject({ id: 'job-1', runId: 'run-1', providerId: 'provider-1' });
		expect(result.action.providerJobId).toBe('modal-job-1');
	});

	it('composes run hyperparameters and an explicit CPU type for Modal launches', async () => {
		const startTraining = vi.fn().mockResolvedValue({
			data: {
				ok: true, status: 'queued', providerJobId: 'modal-cpu-job-1',
				checkedAt: '2026-07-17T12:00:00.000Z',
			},
		});
		const run = {
			id: 'run-1', owner: 'user-1', pipelineId: 'pipe-1', providerId: 'provider-modal', status: 'queued',
			configJson: {
				model_type: 'lgbm', feature_set: 'small', hyperparams: { max_train_eras: 20 }, modelId: 'model-1',
			},
		};
		const client = {
			models: {
				TrainingRun: {
					get: vi.fn().mockResolvedValue({ data: run }),
					update: vi.fn().mockImplementation(async (patch) => ({ data: { ...run, ...patch } })),
				},
				ComputeProvider: {
					get: vi.fn().mockResolvedValue({
						data: {
							id: 'provider-modal', owner: 'user-1', name: 'Modal', providerType: 'modal', status: 'available',
							credentialsJson: { modal: { s3Bucket: 'artifacts', hyperparams: { num_rounds: 10 } } },
						},
					}),
				},
				ComputeJob: {
					list: vi.fn().mockResolvedValue({ data: [] }),
					create: vi.fn().mockImplementation(async (input) => ({ data: { id: 'job-cpu', ...input } })),
				},
			},
			mutations: { startTraining },
		};
		const plane = new McpControlPlane(client as never);

		await plane.launchTrainingRun(
			{ ownerSub: 'user-1' },
			{ runId: 'run-1', computeType: 'CPU' }
		);

		const config = JSON.parse(startTraining.mock.calls[0]?.[0].providerConfigJson);
		expect(config).toEqual({
			modal: {
				s3Bucket: 'artifacts', gpuType: 'cpu',
				hyperparams: {
					num_rounds: 10, model_type: 'lgbm', feature_set: 'small', max_train_eras: 20,
				},
			},
		});
	});
});

describe('MCP local model configuration forwarding', () => {
	it.each([
		'lgbm', 'xgboost', 'catboost', 'mlp', 'ft_transformer', 'tabm', 'modern_nca', 'tabpfn', 'tabicl',
	])('preserves %s model-specific Builder fields as local hyperparameters', (modelType) => {
		const request = localLaunchRequest('run-1', {
			mode: 'train',
			model_type: modelType,
			feature_set: 'small',
			neutralization_pct: 25,
			custom_model_knob: 7,
			hyperparams: { explicit_knob: 9 },
			modelId: 'model-1',
			modelName: 'Model 1',
			sweep: {},
		});

		expect(request).toMatchObject({
			model_type: modelType,
			hyperparams: { custom_model_knob: 7, explicit_knob: 9 },
		});
		expect(request.hyperparams).not.toHaveProperty('modelId');
		expect(request.hyperparams).not.toHaveProperty('modelName');
	});
});

describe('MCP control-plane local daemon sync', () => {
	const principal = { ownerSub: 'user-1' };

	function localClient(overrides: Record<string, unknown> = {}) {
		const run = {
			id: 'run-1',
			owner: 'user-1',
			pipelineId: 'pipe-1',
			providerId: 'provider-local',
			status: 'queued',
			configJson: JSON.stringify({ local: { model_type: 'lgbm', feature_set: 'medium', hyperparams: { num_rounds: 500 } } }),
		};
		const provider = { id: 'provider-local', owner: 'user-1', name: 'Mac Studio', providerType: 'local', status: 'available' };
		const updateProvider = vi.fn().mockResolvedValue({
			data: { ...provider, verifiedAt: new Date().toISOString() },
		});
		return {
			run,
			provider,
			client: {
				models: {
					TrainingRun: {
						get: vi.fn().mockResolvedValue({ data: run }),
						list: vi.fn().mockResolvedValue({ data: [run] }),
						update: vi.fn().mockResolvedValue({ data: run }),
					},
					ComputeProvider: {
						get: vi.fn().mockResolvedValue({ data: provider }),
						list: vi.fn().mockResolvedValue({ data: [provider] }),
						update: updateProvider,
					},
					ComputeJob: {
						list: vi.fn().mockResolvedValue({ data: [] }),
						create: vi.fn().mockResolvedValue({
							data: { id: 'job-1', owner: 'user-1', name: 'MCP training run-1', runId: 'run-1', status: 'queued' },
						}),
						update: vi.fn().mockResolvedValue({
							data: { id: 'job-1', owner: 'user-1', name: 'MCP training run-1', runId: 'run-1', status: 'running' },
						}),
					},
					...((overrides.models as Record<string, unknown>) ?? {}),
				},
				mutations: {
					startTraining: vi.fn(),
					pollTrainingStatus: vi.fn(),
					cancelTraining: vi.fn(),
				},
			},
		};
	}

	it('queues local launches for the daemon without invoking the cloud mutation', async () => {
		const { client } = localClient();
		const plane = new McpControlPlane(client as never);

		const result = await plane.launchTrainingRun(principal, { runId: 'run-1' });

		expect(client.mutations.startTraining).not.toHaveBeenCalled();
		expect(client.models.ComputeJob.create).toHaveBeenCalledWith(expect.objectContaining({
			owner: 'user-1', providerId: 'provider-local', runId: 'run-1', status: 'queued',
		}));
		expect(result.action.status).toBe('queued');
		expect(result.action.logTail).toContain('local training daemon');
		expect(result.job).toMatchObject({ id: 'job-1', runId: 'run-1' });
	});

	it('persists a provider override so later operations use the selected provider', async () => {
		const run = {
			id: 'run-1', owner: 'user-1', pipelineId: 'pipe-1', providerId: 'provider-modal', status: 'queued',
		};
		const updateRun = vi.fn().mockImplementation(async (patch) => ({ data: { ...run, ...patch } }));
		const startTraining = vi.fn();
		const client = {
			models: {
				TrainingRun: { get: vi.fn().mockResolvedValue({ data: run }), update: updateRun },
				ComputeProvider: {
					get: vi.fn().mockResolvedValue({
						data: {
							id: 'provider-local', owner: 'user-1', name: 'Mac Studio',
							providerType: 'local', status: 'available',
						},
					}),
				},
				ComputeJob: {
					list: vi.fn().mockResolvedValue({ data: [] }),
					create: vi.fn().mockImplementation(async (input) => ({ data: { id: 'job-local', ...input } })),
				},
			},
			mutations: { startTraining },
		};
		const plane = new McpControlPlane(client as never);

		const result = await plane.launchTrainingRun(principal, {
			runId: 'run-1', providerId: 'provider-local',
		});

		expect(startTraining).not.toHaveBeenCalled();
		expect(updateRun).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'run-1', providerId: 'provider-local', status: 'queued' })
		);
		expect(result.run.providerId).toBe('provider-local');
	});

	it('reports daemon-pushed state on poll instead of overwriting it', async () => {
		const { client, run } = localClient();
		run.status = 'running';
		(client.models.ComputeJob.list as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: [{
				id: 'job-1', owner: 'user-1', name: 'Existing local job', runId: 'run-1',
				providerId: 'provider-local', providerJobId: 'local-run-1', status: 'running',
			}],
		});
		const plane = new McpControlPlane(client as never);

		const result = await plane.pollTrainingStatus(principal, { runId: 'run-1' });

		expect(client.mutations.pollTrainingStatus).not.toHaveBeenCalled();
		expect(client.models.TrainingRun.update).not.toHaveBeenCalled();
		expect(result.action.status).toBe('running');
	});

	it('backfills a missing ComputeJob when polling a legacy local MCP run', async () => {
		const { client, run } = localClient();
		run.status = 'running';
		run.configJson = JSON.stringify({ modelName: 'Legacy TabM', model_type: 'tabm' });
		const plane = new McpControlPlane(client as never);

		const result = await plane.pollTrainingStatus(principal, { runId: 'run-1' });

		expect(client.mutations.pollTrainingStatus).not.toHaveBeenCalled();
		expect(client.models.ComputeJob.create).toHaveBeenCalledWith(expect.objectContaining({
			owner: 'user-1',
			providerId: 'provider-local',
			runId: 'run-1',
			name: 'Legacy TabM',
			status: 'running',
		}));
		expect(result.job).toMatchObject({ id: 'job-1', runId: 'run-1' });
	});

	it('lists claimable launches with the derived daemon request', async () => {
		const { client } = localClient();
		(client.models.TrainingRun.list as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				data: [{
					id: 'run-1', owner: 'user-1', pipelineId: 'pipe-1', providerId: 'provider-local', status: 'queued',
					configJson: JSON.stringify({ local: { model_type: 'lgbm', feature_set: 'medium', hyperparams: { num_rounds: 500 } } }),
				}],
			})
			.mockResolvedValueOnce({ data: [] });
		const plane = new McpControlPlane(client as never);

		const work = await plane.pollDaemonWork(principal);

		expect(client.models.ComputeProvider.update).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'provider-local',
				verifiedAt: expect.any(String),
				lastVerifyError: null,
			})
		);
		expect(work.cancels).toEqual([]);
		expect(work.launches).toEqual([
			{
				runId: 'run-1',
				providerId: 'provider-local',
				request: {
					runId: 'run-1',
					model_type: 'lgbm',
					feature_set: 'medium',
					neutralization_pct: 25,
					hyperparams: { num_rounds: 500 },
					upload: false,
				},
			},
		]);
	});

	it('persists sanitized daemon reports and rejects non-local runs', async () => {
		const { client } = localClient();
		const plane = new McpControlPlane(client as never);

		const result = await plane.reportDaemonAction(principal, {
			runId: 'run-1',
			action: { ok: true, status: 'running', providerJobId: 'local-run-1-123', logTail: 'epoch 3' },
		});
		expect(result.action.status).toBe('running');
		expect(client.models.TrainingRun.update).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'run-1', status: 'running', logTail: 'epoch 3' })
		);

		(client.models.ComputeProvider.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			data: { id: 'provider-local', owner: 'user-1', name: 'Modal', providerType: 'modal', status: 'available' },
		});
		await expect(
			plane.reportDaemonAction(principal, { runId: 'run-1', action: { status: 'running' } })
		).rejects.toThrow(/local compute provider/);

		await expect(
			plane.reportDaemonAction(principal, { runId: 'run-1', action: {} })
		).rejects.toThrow(/requires an action/);
	});

	it('serializes completion metrics so the daemon report survives the AWSJSON mutation', async () => {
		const { client } = localClient();
		const plane = new McpControlPlane(client as never);
		const metrics = { ensemble: { correlation: 0.0073, sharpe: 0.81 }, elapsedSeconds: 392.8 };

		const result = await plane.reportDaemonAction(principal, {
			runId: 'run-1',
			action: {
				ok: true,
				status: 'completed',
				providerJobId: 'local-run-1-123',
				metricsJson: metrics,
				artifactUri: '/jobs/local-run-1-123/output',
			},
		});

		expect(result.action.status).toBe('completed');
		expect(client.models.TrainingRun.update).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'run-1', status: 'completed', metricsJson: JSON.stringify(metrics) })
		);
	});
});

describe('MCP control-plane cancel/report race', () => {
	it('drops non-terminal daemon reports on a cancelled run so the cancel stays visible', async () => {
		const run = {
			id: 'run-1', owner: 'user-1', pipelineId: 'pipe-1', providerId: 'provider-local',
			status: 'cancelled', logTail: 'cancel requested',
		};
		const update = vi.fn();
		const client = {
			models: {
				TrainingRun: { get: vi.fn().mockResolvedValue({ data: run }), update },
				ComputeProvider: {
					get: vi.fn().mockResolvedValue({
						data: { id: 'provider-local', owner: 'user-1', name: 'Mac', providerType: 'local', status: 'available' },
					}),
				},
				ComputeJob: {
					list: vi.fn().mockResolvedValue({ data: [] }),
					create: vi.fn().mockImplementation(async (input) => ({ data: { id: 'job-1', owner: 'user-1', ...input } })),
				},
			},
		};
		const plane = new McpControlPlane(client as never);

		const dropped = await plane.reportDaemonAction(
			{ ownerSub: 'user-1' },
			{ runId: 'run-1', action: { status: 'running', logTail: 'epoch 9' } }
		);
		expect(update).not.toHaveBeenCalled();
		expect(dropped.action.status).toBe('cancelled');

		update.mockResolvedValue({ data: { ...run, finishedAt: '2026-07-17T12:00:00.000Z' } });
		const accepted = await plane.reportDaemonAction(
			{ ownerSub: 'user-1' },
			{ runId: 'run-1', action: { status: 'cancelled', logTail: 'stopped' } }
		);
		expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1', status: 'cancelled' }));
		expect(accepted.action.status).toBe('cancelled');
	});
});
