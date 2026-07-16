import { describe, expect, it } from 'vitest';
import {
	ownedSecretRef,
	requireCallerSub,
	requireWorkflowOwner,
	secretPath,
	secureProviderRuntimeArgs,
	trustedProviderConfig,
	trustedProviderUrl,
} from './workflow-security';

describe('workflow security boundary', () => {
	it('requires a Cognito subject and fails closed when identity is absent', () => {
		expect(requireCallerSub({ identity: { sub: 'user-1' } })).toBe('user-1');
		expect(requireCallerSub({ identity: { claims: { sub: 'user-2' } } })).toBe('user-2');
		expect(() => requireCallerSub({})).toThrow('Authenticated caller identity is required');
		expect(() => requireCallerSub({ identity: { sub: '../shared' } })).toThrow(
			'Authenticated caller identity is required'
		);
	});

	it('accepts an owner override only for IAM resource callers', () => {
		expect(
			requireWorkflowOwner({
				identity: { accountId: '123456789012', userArn: 'arn:aws:sts::123456789012:assumed-role/mcp' },
				arguments: { ownerSub: 'user-1' },
			})
		).toBe('user-1');
		expect(
			requireWorkflowOwner({
				identity: { sub: 'user-2', claims: { sub: 'user-2' }, accountId: '123456789012' },
				arguments: { ownerSub: 'user-1' },
			})
		).toBe('user-2');
		expect(() =>
			requireWorkflowOwner({ identity: { sourceIp: ['127.0.0.1'] }, arguments: { ownerSub: 'user-1' } })
		).toThrow('Authenticated caller identity is required');
	});

	it('accepts only SSM references within the caller namespace', () => {
		const ownRef = '/numeraidashboard/user-1/provider/key/api-key';
		expect(ownedSecretRef(ownRef, 'user-1')).toBe(ownRef);
		expect(ownedSecretRef(null, 'user-1')).toBeNull();
		expect(() =>
			ownedSecretRef('/numeraidashboard/user-2/provider/key/api-key', 'user-1')
		).toThrow("outside the authenticated user's secret scope");
		expect(() => ownedSecretRef('/infrastructure/database/password', 'user-1')).toThrow(
			"outside the authenticated user's secret scope"
		);
	});

	it('creates deterministic secrets below the caller namespace', () => {
		const first = secretPath('user-1', 'provider', 'modal:workspace', 'api-key');
		const second = secretPath('user-1', 'provider', 'modal:workspace', 'api-key');
		expect(first).toBe(second);
		expect(first).toMatch(/^\/numeraidashboard\/user-1\/provider\/[a-f0-9]{24}\/api-key$/);
	});

	it('allows only the expected Prime and Modal endpoint families', () => {
		expect(
			trustedProviderUrl('https://api.primeintellect.ai/', 'prime_intellect')
		).toBe('https://api.primeintellect.ai');
		expect(
			trustedProviderUrl(
				'https://operator--numerai-worker-spawn-training.modal.run',
				'modal'
			)
		).toBe('https://operator--numerai-worker-spawn-training.modal.run');

		expect(() => trustedProviderUrl('https://attacker.example', 'prime_intellect')).toThrow(
			'https://api.primeintellect.ai'
		);
		expect(() => trustedProviderUrl('http://api.primeintellect.ai', 'prime_intellect')).toThrow(
			'must use HTTPS'
		);
		expect(() => trustedProviderUrl('https://attacker.example', 'modal')).toThrow(
			'under *.modal.run'
		);
		expect(() =>
			trustedProviderUrl('https://user:password@app.modal.run', 'modal')
		).toThrow('must not contain URL credentials');
	});

	it('blocks cloud-function requests to local networks while preserving local daemon URLs', () => {
		expect(trustedProviderUrl('http://127.0.0.1:8787', 'local')).toBe(
			'http://127.0.0.1:8787'
		);
		expect(trustedProviderUrl('https://worker.example.com', 'custom')).toBe(
			'https://worker.example.com'
		);
		expect(() => trustedProviderUrl('https://169.254.169.254/latest', 'custom')).toThrow(
			'private or local host'
		);
		expect(() => trustedProviderUrl('https://worker.internal', 'custom')).toThrow(
			'private or local host'
		);
	});

	it('validates embedded Modal endpoints and app host before credentials are resolved', () => {
		expect(() =>
			trustedProviderConfig(
				{
					modal: {
						launchUrl: 'https://attacker.example/launch',
					},
				},
				'modal'
			)
		).toThrow('under *.modal.run');
		expect(() =>
			trustedProviderConfig({ modal: { appHost: 'safe#@attacker.example' } }, 'modal')
		).toThrow('unsupported characters');
		expect(
			trustedProviderConfig(
				JSON.stringify({
					modal: {
						appHost: 'operator--numerai-worker',
						statusUrl: 'https://operator--numerai-worker-job-status.modal.run/{jobId}',
					},
				}),
				'modal'
			)
		).toBeTypeOf('string');
	});

	it('rejects foreign provider references before accepting runtime arguments', () => {
		expect(() =>
			secureProviderRuntimeArgs(
				{
					providerType: 'modal',
					apiKeyRef: '/numeraidashboard/user-2/provider/key/api-key',
					baseUrl: 'https://app-spawn-training.modal.run',
				},
				'user-1'
			)
		).toThrow("outside the authenticated user's secret scope");
	});

	it('replaces a legacy reference when the caller supplies fresh credential material', () => {
		expect(
			secureProviderRuntimeArgs(
				{
					providerType: 'prime_intellect',
					apiKey: 'fresh-token',
					apiKeyRef: '/numeraidashboard/demo/provider/api-key',
					baseUrl: 'https://api.primeintellect.ai',
				},
				'user-1'
			).apiKeyRef
		).toBeNull();
	});
});
