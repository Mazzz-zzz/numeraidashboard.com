import {
	CreateUserPoolClientCommand,
	DescribeUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it, vi } from 'vitest';
import { McpOAuthClientRegistry, OAuthRegistrationError } from './oauth-registration';

const callbackUrl = 'https://chatgpt.com/connector/oauth/12385cb69972bc74';

describe('MCP OAuth dynamic client registration', () => {
	it('registers a public PKCE client for a ChatGPT callback', async () => {
		const send = vi.fn(async (command: unknown) => {
			expect(command).toBeInstanceOf(CreateUserPoolClientCommand);
			return { UserPoolClient: { ClientId: 'chatgpt-client' } };
		});
		const registry = new McpOAuthClientRegistry('ap-southeast-2_pool', { send } as never);

		const result = await registry.register({
			client_name: 'ChatGPT connector',
			redirect_uris: [callbackUrl],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			scope: 'openid',
		});

		expect(result).toMatchObject({
			client_id: 'chatgpt-client',
			client_name: 'ChatGPT connector',
			redirect_uris: [callbackUrl],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			scope: 'openid',
		});
		expect(send.mock.calls[0]?.[0]).toMatchObject({
			input: {
				UserPoolId: 'ap-southeast-2_pool',
				GenerateSecret: false,
				AllowedOAuthFlows: ['code'],
				AllowedOAuthScopes: ['openid'],
				CallbackURLs: [callbackUrl],
			},
		});
	});

	it('rejects attacker-controlled redirects and confidential-client authentication', async () => {
		const registry = new McpOAuthClientRegistry('ap-southeast-2_pool', { send: vi.fn() } as never);

		await expect(registry.register({
			redirect_uris: ['https://attacker.example/callback'],
		})).rejects.toBeInstanceOf(OAuthRegistrationError);
		await expect(registry.register({
			redirect_uris: [callbackUrl],
			token_endpoint_auth_method: 'client_secret_post',
		})).rejects.toThrow('token_endpoint_auth_method must be none');
	});

	it('accepts only Cognito clients created by the ChatGPT registrar', async () => {
		const send = vi.fn(async (command: unknown) => {
			expect(command).toBeInstanceOf(DescribeUserPoolClientCommand);
			return {
				UserPoolClient: {
					ClientName: 'numeraidashboard-chatgpt-a1b2c3',
					AllowedOAuthFlowsUserPoolClient: true,
					AllowedOAuthFlows: ['code'],
					AllowedOAuthScopes: ['openid'],
					CallbackURLs: [callbackUrl],
				},
			};
		});
		const registry = new McpOAuthClientRegistry('ap-southeast-2_pool', { send } as never);

		await expect(registry.isRegisteredClient('chatgpt-client')).resolves.toBe(true);
		await expect(registry.isRegisteredClient('chatgpt-client')).resolves.toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
	});
});
