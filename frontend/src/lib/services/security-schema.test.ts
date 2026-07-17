import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schemaSource = readFileSync(resolve(process.cwd(), 'amplify/data/resource.ts'), 'utf8');
const backendSource = readFileSync(resolve(process.cwd(), 'amplify/backend.ts'), 'utf8');
const modalSource = readFileSync(resolve(process.cwd(), 'amplify/functions/modal.ts'), 'utf8');
const appHtmlSource = readFileSync(resolve(process.cwd(), 'src/app.html'), 'utf8');
const layoutSource = readFileSync(resolve(process.cwd(), 'src/routes/+layout.svelte'), 'utf8');
const authSource = readFileSync(resolve(process.cwd(), 'src/lib/auth.ts'), 'utf8');

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
		for (const model of ['ModelSubmission', 'TrainingRun', 'ComputeJob', 'ApiKey']) {
			expect(modelBlock(model)).toContain('allow.owner()');
		}
		expect(modelBlock('ApiKey')).toContain('keyHash: a.string().required()');
		expect(modelBlock('ApiKey')).not.toContain('rawKey');
	});

	it('exposes owner fields for MCP-created model workflow rows', () => {
		for (const model of ['Pipeline', 'ModelBranch', 'TrainingRun', 'ModelRegistryItem']) {
			expect(modelBlock(model), model).toContain('owner: a.string()');
			expect(modelBlock(model), model).toContain('allow.owner()');
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
			'amplify/functions/submit-model/handler.ts',
			'amplify/functions/fetch-prime-offers/handler.ts',
			'amplify/functions/fetch-numerai-submissions/handler.ts',
		]) {
			const source = readFileSync(resolve(process.cwd(), handlerPath), 'utf8');
			expect(source, handlerPath).toContain('requireCallerSub');
		}
		for (const handlerPath of [
			'amplify/functions/start-training/handler.ts',
			'amplify/functions/cancel-training/handler.ts',
			'amplify/functions/poll-training-status/handler.ts',
		]) {
			const source = readFileSync(resolve(process.cwd(), handlerPath), 'utf8');
			expect(source, handlerPath).toContain('requireWorkflowOwner');
		}
	});

	it('protects the public MCP function URL with handler-level API-key auth', () => {
		const handlerSource = readFileSync(
			resolve(process.cwd(), 'amplify/functions/mcp-server/handler.ts'),
			'utf8'
		);
		expect(backendSource).toContain('backend.mcpServer.resources.lambda.addFunctionUrl');
		expect(backendSource).toContain('FunctionUrlAuthType.NONE');
		expect(handlerSource).toContain("header(event.headers, 'x-api-key')");
		expect(handlerSource).toContain('controlPlane.authenticate');
	});

	it('keeps operator Modal infrastructure out of source defaults', () => {
		expect(modalSource).toContain('process.env.MODAL_APP_HOST');
		expect(modalSource).toContain('process.env.ML_ARTIFACT_BUCKET');
		expect(modalSource).not.toContain('DEFAULT_APP_HOST');
		expect(modalSource).not.toContain('DEFAULT_S3_BUCKET');

		for (const resourcePath of [
			'amplify/functions/start-training/resource.ts',
			'amplify/functions/cancel-training/resource.ts',
			'amplify/functions/poll-training-status/resource.ts',
			'amplify/functions/submit-model/resource.ts',
		]) {
			const source = readFileSync(resolve(process.cwd(), resourcePath), 'utf8');
			expect(source, resourcePath).toMatch(/modalFunctionEnvironment|trainingFunctionEnvironment/);
		}
	});

	it('loads optional analytics from public build configuration', () => {
		expect(appHtmlSource).not.toContain('googletagmanager.com');
		expect(appHtmlSource).not.toContain("gtag('config'");
		expect(layoutSource).toContain('VITE_GA_MEASUREMENT_ID');
	});

	it('allows clean clones to build without generated Amplify outputs', () => {
		expect(authSource).toContain("import.meta.glob<AmplifyOutputsModule>('../../amplify_outputs.json'");
		expect(authSource).not.toContain("import outputs from '../../amplify_outputs.json'");
	});
});
