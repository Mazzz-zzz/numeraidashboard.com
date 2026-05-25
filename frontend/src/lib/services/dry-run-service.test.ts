import { describe, expect, it } from 'vitest';
import { evaluateFrontendDryRun } from './dry-run-service';
import type { DryRunWorkspace } from './dry-run-service';

describe('dry run service', () => {
	it('passes every frontend-first workflow step for a seeded workspace', () => {
		const report = evaluateFrontendDryRun(seedWorkspace());

		expect(report.ok).toBe(true);
		expect(report.failures).toEqual([]);
		expect(report.steps.map((step) => step.id)).toEqual([
			'auth',
			'numerai',
			'compute',
			'pipeline',
			'sweep',
			'training',
			'job-sync',
			'registry',
			'submission'
		]);
		expect(report.steps.at(-1)?.evidence).toContain('completed for round 842');
	});

	it('captures actionable failures for incomplete workspaces', () => {
		const report = evaluateFrontendDryRun({ ...seedWorkspace(), computeProviders: [], submissions: [] });

		expect(report.ok).toBe(false);
		expect(report.failures.map((failure) => failure.id)).toEqual(['compute', 'submission']);
		expect(report.failures[0].evidence).toBe('0 usable compute providers found.');
	});
});

function seedWorkspace(): DryRunWorkspace {
	return {
		authenticated: true,
		numeraiAccounts: [
			{
				verifiedAt: '2026-05-23T00:00:00.000Z',
				lastVerifyError: null
			}
		],
		computeProviders: [
			{
				providerType: 'local',
				status: 'available',
				verifiedAt: '2026-05-23T00:00:00.000Z'
			}
		],
		pipelines: [{ id: 'pipeline-1', name: 'Demo Numerai baseline pipeline' }],
		branches: [{ id: 'branch-1', pipelineId: 'pipeline-1', name: 'demo-baseline-root' }],
		sweepPlans: [
			{ id: 'sweep-1', pipelineId: 'pipeline-1', branchId: 'branch-1', name: 'demo sweep', status: 'queued' }
		],
		trainingRuns: [
			{
				id: 'run-1',
				pipelineId: 'pipeline-1',
				branchId: 'branch-1',
				providerId: 'provider-1',
				status: 'queued'
			}
		],
		computeJobs: [
			{
				id: 'job-1',
				runId: 'run-1',
				providerId: 'provider-1',
				name: 'demo job',
				status: 'planned'
			}
		],
		models: [
			{
				id: 'model-1',
				name: 'Demo Baseline v1',
				runId: 'run-1',
				numeraiModelId: 'demo-numerai-model-id',
				stage: 'testing'
			}
		],
		submissions: [
			{
				id: 'submission-1',
				modelId: 'model-1',
				roundNumber: 842,
				status: 'completed',
				artifactUri: 'artifact://demo.csv'
			}
		]
	} as unknown as DryRunWorkspace;
}
