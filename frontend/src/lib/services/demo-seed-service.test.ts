import { describe, expect, it } from 'vitest';
import { demoPipelineGraph, demoSeedNames, seedDemoWorkspace } from './demo-seed-service';

describe('demo seed service', () => {
	it('builds a baseline graph marked for the selected provider', () => {
		const graph = demoPipelineGraph('provider-1');

		expect(graph).toMatchObject({
			version: 1,
			preset: 'baseline',
			providerId: 'provider-1'
		});
		expect(graph.nodes).toHaveLength(3);
		expect(graph.edges).toHaveLength(2);
	});

	it('creates the full demo workspace once and reuses it on later runs', async () => {
		const client = createMemoryClient();

		const first = await seedDemoWorkspace(client as never);
		const second = await seedDemoWorkspace(client as never);

		expect(first.created).toBe(10);
		expect(first.reused).toBe(0);
		expect(second.created).toBe(0);
		expect(second.reused).toBe(10);
		expect(second.pipelineId).toBe(first.pipelineId);
		expect(client.models.NumeraiAccount.rows).toHaveLength(1);
		expect(client.models.ComputeProvider.rows).toHaveLength(1);
		expect(client.models.Pipeline.rows).toHaveLength(1);
		expect(client.models.ModelBranch.rows).toHaveLength(1);
		expect(client.models.SweepPlan.rows).toHaveLength(1);
		expect(client.models.TrainingRun.rows).toHaveLength(1);
		expect(client.models.ComputeJob.rows).toHaveLength(1);
		expect(client.models.ModelRegistryItem.rows).toHaveLength(1);
		expect(client.models.ModelSubmission.rows).toHaveLength(1);
		expect(client.models.RoundDataset.rows).toHaveLength(1);
	});

	it('seeds non-secret demo credentials and useful cross-model references', async () => {
		const client = createMemoryClient();
		const summary = await seedDemoWorkspace(client as never);

		expect(client.models.NumeraiAccount.rows[0]).toMatchObject({
			publicId: demoSeedNames.numeraiPublicId,
			secretRef: '/numeraidashboard/demo/numerai/secret-key'
		});
		expect(client.models.NumeraiAccount.rows[0]).not.toHaveProperty('secretKey');
		expect(client.models.ComputeProvider.rows[0]).toMatchObject({
			name: demoSeedNames.provider,
			providerType: 'local',
			status: 'available'
		});
		expect(client.models.ComputeProvider.rows[0]).not.toHaveProperty('apiKey');
		expect(client.models.ComputeJob.rows[0]).toMatchObject({
			runId: summary.trainingRunId,
			providerId: summary.providerId,
			status: 'planned'
		});
		expect(client.models.ModelSubmission.rows[0]).toMatchObject({
			modelId: summary.modelId,
			roundNumber: 842,
			status: 'completed'
		});
	});
});

function createMemoryClient() {
	return {
		models: {
			NumeraiAccount: memoryModel(),
			ComputeProvider: memoryModel(),
			Pipeline: memoryModel(),
			ModelBranch: memoryModel(),
			SweepPlan: memoryModel(),
			TrainingRun: memoryModel(),
			ComputeJob: memoryModel(),
			ModelRegistryItem: memoryModel(),
			ModelSubmission: memoryModel(),
			RoundDataset: memoryModel()
		}
	};
}

function memoryModel() {
	const model = {
		rows: [] as Array<Record<string, unknown>>,
		async list() {
			return { data: model.rows };
		},
		async create(input: Record<string, unknown>) {
			const row = { id: `row-${model.rows.length + 1}`, ...input };
			model.rows.push(row);
			return { data: row };
		},
		async update(input: Record<string, unknown>) {
			const id = String(input.id);
			const index = model.rows.findIndex((row) => row.id === id);
			if (index === -1) return { data: null };
			model.rows[index] = { ...model.rows[index], ...input };
			return { data: model.rows[index] };
		}
	};
	return model;
}
