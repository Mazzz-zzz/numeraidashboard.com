import { JwtVerifier } from 'aws-jwt-verify';
import type { McpPrincipal } from './control-plane';

// Auth0 post-login Action copies the federated Cognito subject into this claim
// so MCP tools keep resolving the same owner-scoped records as the web app.
export const OWNER_SUB_CLAIM = 'https://numeraidashboard.com/cognito_sub';

export type McpOAuthConfig = {
	readonly issuer: string;
};

type VerifiedAccessToken = {
	readonly sub?: unknown;
	readonly aud?: unknown;
	readonly [OWNER_SUB_CLAIM]?: unknown;
};

type AccessTokenVerifier = {
	verify(token: string): Promise<VerifiedAccessToken>;
};

/**
 * Pure OAuth 2.1 resource server (MCP authorization spec): publishes RFC 9728
 * protected-resource metadata pointing at the external authorization server,
 * challenges with WWW-Authenticate, and validates bearer JWTs against the
 * issuer's JWKS. Client registration, PKCE, and consent are the authorization
 * server's job, not this Lambda's.
 */
export class McpOAuthAuthenticator {
	private readonly verifier: AccessTokenVerifier;
	readonly authorizationServer: string;

	constructor(config: McpOAuthConfig, verifier?: AccessTokenVerifier) {
		this.authorizationServer = absoluteHttpsUrl(config.issuer, 'OAuth issuer');
		this.verifier =
			verifier ??
			JwtVerifier.create({
				issuer: trimTrailingSlash(this.authorizationServer),
				audience: null, // audience is the per-request resource URL, checked below
				jwksUri: new URL('/.well-known/jwks.json', this.authorizationServer).toString(),
			});
	}

	static fromEnvironment(env: Record<string, string | undefined>): McpOAuthAuthenticator | null {
		const issuer = env.MCP_OAUTH_ISSUER?.trim();
		return issuer ? new McpOAuthAuthenticator({ issuer }) : null;
	}

	async authenticate(authorization: string | null | undefined, resourceUrl: string): Promise<McpPrincipal | null> {
		const token = bearerToken(authorization);
		if (!token) return null;

		let payload: VerifiedAccessToken;
		try {
			payload = await this.verifier.verify(token);
		} catch {
			return null;
		}

		const resource = absoluteHttpsUrl(resourceUrl, 'MCP resource URL');
		if (!hasAudience(payload.aud, resource)) return null;
		const ownerSub = ownerSubClaim(payload);
		if (!ownerSub) return null;
		return { ownerSub };
	}

	protectedResourceMetadata(resourceUrl: string): Record<string, unknown> {
		return {
			resource: absoluteHttpsUrl(resourceUrl, 'MCP resource URL'),
			authorization_servers: [this.authorizationServer],
			scopes_supported: ['openid'],
			bearer_methods_supported: ['header'],
			resource_name: 'NumeraiDashboard MCP',
		};
	}

	challenge(resourceUrl: string): string {
		return `Bearer resource_metadata="${protectedResourceMetadataUrl(resourceUrl)}", scope="openid"`;
	}
}

export function protectedResourceMetadataUrl(resourceUrl: string): string {
	return new URL('/.well-known/oauth-protected-resource', absoluteHttpsUrl(resourceUrl, 'MCP resource URL')).toString();
}

function ownerSubClaim(payload: VerifiedAccessToken): string | null {
	const custom = payload[OWNER_SUB_CLAIM];
	if (typeof custom === 'string' && custom.trim()) return custom.trim();
	return typeof payload.sub === 'string' && payload.sub.trim() ? payload.sub.trim() : null;
}

function bearerToken(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
	return match?.[1] ?? null;
}

function hasAudience(value: unknown, resourceUrl: string): boolean {
	// RFC 8707 audience binding: the token must have been minted for this exact
	// resource. Auth0 access tokens may carry an array (API audience + /userinfo).
	const matches = (audience: unknown) =>
		typeof audience === 'string' && (audience === resourceUrl || audience === trimTrailingSlash(resourceUrl));
	if (matches(value)) return true;
	return Array.isArray(value) && value.some(matches);
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}

function required(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} is required`);
	return normalized;
}

function absoluteHttpsUrl(value: string, label: string): string {
	const url = new URL(required(value, label));
	if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
	return url.toString();
}
