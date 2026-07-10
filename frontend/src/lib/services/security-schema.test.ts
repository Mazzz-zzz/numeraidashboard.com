import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schemaSource = readFileSync(resolve(process.cwd(), 'amplify/data/resource.ts'), 'utf8');
const backendSource = readFileSync(resolve(process.cwd(), 'amplify/backend.ts'), 'utf8');

function modelBlock(modelName: string): string {
	const marker = `\t${modelName}: a`;
	const start = schemaSource.indexOf(marker);
	if (start < 0) throw new Error(`Model ${modelName} not found`);
	const next = schemaSource.indexOf('\n\n\t', start + marker.length);
	return schemaSource.slice(start, next < 0 ? undefined : next);
}

describe('credential schema hardening', () => {
	it('keeps Numerai secrets out of the GraphQL model row', () => {
		const block = modelBlock('NumeraiAccount');

		expect(block).toContain('secretRef: a.string().required()');
		expect(block).not.toContain('secretKey: a.string()');
		expect(block).toContain('allow.owner()');
	});

	it('keeps compute provider API secrets out of the GraphQL model row', () => {
		const block = modelBlock('ComputeProvider');

		expect(block).toContain('apiKeyRef: a.string()');
		expect(block).toContain('apiSecretRef: a.string()');
		expect(block).not.toContain('apiKey: a.string()');
		expect(block).not.toContain('apiSecret: a.string()');
		expect(block).toContain('allow.owner()');
	});

	it('retains owner authorization on sensitive workflow records', () => {
		for (const model of ['ModelSubmission', 'TrainingRun', 'ComputeJob']) {
			expect(modelBlock(model)).toContain('allow.owner()');
		}
	});

	it('scopes Lambda SSM permissions to the dashboard parameter namespace', () => {
		expect(backendSource).toContain("resourceName: 'numeraidashboard/*'");
		expect(backendSource).not.toContain("resources: ['*']");
	});

	it('requires caller identity checks at every secret-aware function boundary', () => {
		for (const handlerPath of [
			'amplify/functions/verify-numerai-account/handler.ts',
			'amplify/functions/verify-compute-provider/handler.ts',
			'amplify/functions/start-training/handler.ts',
			'amplify/functions/cancel-training/handler.ts',
			'amplify/functions/poll-training-status/handler.ts',
			'amplify/functions/submit-model/handler.ts',
			'amplify/functions/sync-prime-template/handler.ts',
			'amplify/functions/fetch-numerai-submissions/handler.ts',
		]) {
			const source = readFileSync(resolve(process.cwd(), handlerPath), 'utf8');
			expect(source, handlerPath).toContain('requireCallerSub');
		}
	});
});
