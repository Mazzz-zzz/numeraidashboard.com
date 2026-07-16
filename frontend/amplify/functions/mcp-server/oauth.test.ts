import { describe, expect, it, vi } from 'vitest';
import { McpOAuthAuthenticator, protectedResourceMetadataUrl } from './oauth';

const resourceUrl = 'https://mcp.example.com/';
const authorizationServer = 'https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_pool';
const config = {
	userPoolId: 'ap-southeast-2_pool',
	clientId: 'claude-client',
	authorizationServer,
};

describe('MCP OAuth authentication', () => {
	it('accepts a verified access token bound to this MCP resource', async () => {
		const verify = vi.fn().mockResolvedValue({ sub: 'user-1', aud: resourceUrl });
		const oauth = new McpOAuthAuthenticator(config, { verify });

		await expect(oauth.authenticate('Bearer signed-token', resourceUrl)).resolves.toEqual({
			ownerSub: 'user-1',
		});
		expect(verify).toHaveBeenCalledWith('signed-token');
	});

	it('rejects invalid tokens and tokens bound to another resource', async () => {
		const invalid = new McpOAuthAuthenticator(config, {
			verify: vi.fn().mockRejectedValue(new Error('invalid signature')),
		});
		const wrongAudience = new McpOAuthAuthenticator(config, {
			verify: vi.fn().mockResolvedValue({ sub: 'user-1', aud: 'https://other.example.com/' }),
		});

		await expect(invalid.authenticate('Bearer invalid', resourceUrl)).resolves.toBeNull();
		await expect(wrongAudience.authenticate('Bearer valid', resourceUrl)).resolves.toBeNull();
		await expect(wrongAudience.authenticate('Basic credentials', resourceUrl)).resolves.toBeNull();
	});

	it('publishes protected-resource metadata and an OAuth discovery challenge', () => {
		const oauth = new McpOAuthAuthenticator(config, {
			verify: vi.fn(),
		});

		expect(oauth.protectedResourceMetadata(resourceUrl)).toEqual({
			resource: resourceUrl,
			authorization_servers: [authorizationServer],
			scopes_supported: ['openid'],
			bearer_methods_supported: ['header'],
			resource_name: 'NumeraiDashboard MCP',
		});
		expect(protectedResourceMetadataUrl(resourceUrl)).toBe(
			'https://mcp.example.com/.well-known/oauth-protected-resource'
		);
		expect(oauth.challenge(resourceUrl)).toBe(
			'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="openid"'
		);
	});
});
