import { describe, expect, it } from 'vitest';
import { docsSpec, documentedModelTypes } from './docs-spec';

describe('Scalar documentation', () => {
	it('documents every supported trainer model type', () => {
		expect(documentedModelTypes).toEqual([
			'lgbm',
			'xgboost',
			'catboost',
			'mlp',
			'ft_transformer',
			'modern_nca',
			'tabm',
			'tabpfn',
			'tabicl'
		]);
	});

	it('publishes each model as a Scalar schema', () => {
		const schemas = (docsSpec.components as { schemas: Record<string, unknown> }).schemas;
		const serialized = JSON.stringify(schemas);
		for (const modelType of documentedModelTypes) {
			expect(serialized).toContain(`\"const\":\"${modelType}\"`);
		}
	});

	it('documents every public MCP tool', () => {
		const expectedTools = [
			'list_models',
			'create_model',
			'update_model',
			'delete_model',
			'list_compute_providers',
			'list_training_runs',
			'launch_model_training',
			'launch_training_run',
			'poll_training_status',
			'cancel_run',
			'list_submissions',
			'get_numerai_account'
		];
		const serialized = JSON.stringify(docsSpec);
		for (const tool of expectedTools) expect(serialized).toContain(tool);
	});
});
