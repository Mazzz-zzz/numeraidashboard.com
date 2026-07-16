import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { McpPrincipal } from './control-plane';

export type McpOAuthConfig = {
	readonly userPoolId: string;
	readonly clientId: string;
	readonly authorizationServer: string;
};

type VerifiedAccessToken = {
	readonly sub?: unknown;
	readonly aud?: unknown;
};

type AccessTokenVerifier = {
	verify(token: string): Promise<VerifiedAccessToken>;
};

export class McpOAuthAuthenticator {
	private readonly verifier: AccessTokenVerifier;
	readonly authorizationServer: string;

	constructor(config: McpOAuthConfig, verifier?: AccessTokenVerifier) {
		const userPoolId = required(config.userPoolId, 'Cognito user pool ID');
		const clientId = required(config.clientId, 'MCP OAuth client ID');
		this.authorizationServer = absoluteHttpsUrl(config.authorizationServer, 'OAuth authorization server');
		this.verifier = verifier ?? CognitoJwtVerifier.create({
			userPoolId,
			tokenUse: 'access',
			clientId,
		});
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

		const ownerSub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
		const resource = absoluteHttpsUrl(resourceUrl, 'MCP resource URL');
		if (!ownerSub || !hasAudience(payload.aud, resource)) return null;
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

function bearerToken(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
	return match?.[1] ?? null;
}

function hasAudience(value: unknown, resourceUrl: string): boolean {
	// Cognito omits aud on user-pool access tokens even when the authorize request
	// includes RFC 8707 resource. The verifier still binds the token to the
	// dedicated MCP app client through its signed client_id claim.
	if (value === undefined || value === null) return true;
	if (typeof value === 'string') return value === resourceUrl;
	return Array.isArray(value) && value.some((audience) => audience === resourceUrl);
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
