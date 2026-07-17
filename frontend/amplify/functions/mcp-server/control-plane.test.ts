import { describe, expect, it, vi } from 'vitest';
import { McpControlPlane, hashMcpApiKey, ownerSub } from './control-plane';

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
				{ id: 'run-1', owner: 'user-1::person@example.com', pipelineId: 'pipe-1', status: 'queued' },
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
		expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ owner: 'user-1', runId: 'run-1' }));
		expect(result.action.providerJobId).toBe('modal-job-1');
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
		expect(result.action.status).toBe('queued');
		expect(result.action.logTail).toContain('local training daemon');
	});

	it('reports daemon-pushed state on poll instead of overwriting it', async () => {
		const { client, run } = localClient();
		run.status = 'running';
		const plane = new McpControlPlane(client as never);

		const result = await plane.pollTrainingStatus(principal, { runId: 'run-1' });

		expect(client.mutations.pollTrainingStatus).not.toHaveBeenCalled();
		expect(client.models.TrainingRun.update).not.toHaveBeenCalled();
		expect(result.action.status).toBe('running');
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
});
