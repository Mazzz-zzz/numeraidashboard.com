import { describe, expect, it, vi } from 'vitest';
import { McpOAuthAuthenticator, OWNER_SUB_CLAIM, protectedResourceMetadataUrl } from './oauth';

const resourceUrl = 'https://mcp.example.com/';
const issuer = 'https://numeraidashboard.us.auth0.com/';
const config = { issuer };

describe('MCP OAuth authentication', () => {
	it('accepts a verified token bound to this resource and maps the Cognito owner claim', async () => {
		const verify = vi.fn().mockResolvedValue({
			sub: 'auth0|abc123',
			aud: [resourceUrl, 'https://numeraidashboard.us.auth0.com/userinfo'],
			[OWNER_SUB_CLAIM]: 'cognito-user-1',
		});
		const oauth = new McpOAuthAuthenticator(config, { verify });

		await expect(oauth.authenticate('Bearer signed-token', resourceUrl)).resolves.toEqual({
			ownerSub: 'cognito-user-1',
		});
		expect(verify).toHaveBeenCalledWith('signed-token');
	});

	it('falls back to the token subject when no Cognito owner claim is present', async () => {
		const oauth = new McpOAuthAuthenticator(config, {
			verify: vi.fn().mockResolvedValue({ sub: 'user-1', aud: resourceUrl }),
		});

		await expect(oauth.authenticate('Bearer signed-token', resourceUrl)).resolves.toEqual({
			ownerSub: 'user-1',
		});
	});

	it('rejects invalid tokens, missing audiences, and tokens bound to another resource', async () => {
		const invalid = new McpOAuthAuthenticator(config, {
			verify: vi.fn().mockRejectedValue(new Error('invalid signature')),
		});
		const missingAudience = new McpOAuthAuthenticator(config, {
			verify: vi.fn().mockResolvedValue({ sub: 'user-1' }),
		});
		const wrongAudience = new McpOAuthAuthenticator(config, {
			verify: vi.fn().mockResolvedValue({ sub: 'user-1', aud: 'https://other.example.com/' }),
		});

		await expect(invalid.authenticate('Bearer invalid', resourceUrl)).resolves.toBeNull();
		await expect(missingAudience.authenticate('Bearer valid', resourceUrl)).resolves.toBeNull();
		await expect(wrongAudience.authenticate('Bearer valid', resourceUrl)).resolves.toBeNull();
		await expect(wrongAudience.authenticate('Basic credentials', resourceUrl)).resolves.toBeNull();
	});

	it('accepts an audience recorded without the trailing slash', async () => {
		const oauth = new McpOAuthAuthenticator(config, {
			verify: vi.fn().mockResolvedValue({ sub: 'user-1', aud: 'https://mcp.example.com' }),
		});

		await expect(oauth.authenticate('Bearer signed-token', resourceUrl)).resolves.toEqual({
			ownerSub: 'user-1',
		});
	});

	it('publishes protected-resource metadata and an OAuth discovery challenge', () => {
		const oauth = new McpOAuthAuthenticator(config, { verify: vi.fn() });

		expect(oauth.protectedResourceMetadata(resourceUrl)).toEqual({
			resource: resourceUrl,
			authorization_servers: [issuer],
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

	it('is disabled when MCP_OAUTH_ISSUER is unset and enabled when present', () => {
		expect(McpOAuthAuthenticator.fromEnvironment({})).toBeNull();
		expect(McpOAuthAuthenticator.fromEnvironment({ MCP_OAUTH_ISSUER: '  ' })).toBeNull();
		const enabled = McpOAuthAuthenticator.fromEnvironment({ MCP_OAUTH_ISSUER: issuer });
		expect(enabled?.authorizationServer).toBe(issuer);
	});
});
