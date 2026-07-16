import {
	CognitoIdentityProviderClient,
	CreateUserPoolClientCommand,
	DescribeUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createHash } from 'node:crypto';

const CLIENT_NAME_PREFIX = 'numeraidashboard-chatgpt-';
const ALLOWED_GRANTS: Record<string, true> = {
	authorization_code: true,
	refresh_token: true,
};

export type DynamicClientRegistration = {
	readonly client_id: string;
	readonly client_id_issued_at: number;
	readonly client_name: string;
	readonly redirect_uris: readonly string[];
	readonly token_endpoint_auth_method: 'none';
	readonly grant_types: readonly ['authorization_code', 'refresh_token'];
	readonly response_types: readonly ['code'];
	readonly scope: 'openid';
};

export class OAuthRegistrationError extends Error {
	readonly code = 'invalid_client_metadata';
}

type RegistrationRequest = {
	readonly client_name?: unknown;
	readonly redirect_uris?: unknown;
	readonly token_endpoint_auth_method?: unknown;
	readonly grant_types?: unknown;
	readonly response_types?: unknown;
	readonly scope?: unknown;
};

type CognitoClient = Pick<CognitoIdentityProviderClient, 'send'>;

export class McpOAuthClientRegistry {
	private readonly allowedClientIds = new Set<string>();

	constructor(
		private readonly userPoolId: string,
		private readonly client: CognitoClient = new CognitoIdentityProviderClient({})
	) {
		if (!userPoolId.trim()) throw new Error('Cognito user pool ID is required');
	}

	async register(raw: unknown): Promise<DynamicClientRegistration> {
		const request = parseRegistrationRequest(raw);
		const clientName = clientNameFor(request.redirectUris);
		const result = await this.client.send(new CreateUserPoolClientCommand({
			UserPoolId: this.userPoolId,
			ClientName: clientName,
			GenerateSecret: false,
			AllowedOAuthFlowsUserPoolClient: true,
			AllowedOAuthFlows: ['code'],
			AllowedOAuthScopes: ['openid'],
			CallbackURLs: [...request.redirectUris],
			SupportedIdentityProviders: ['COGNITO'],
			PreventUserExistenceErrors: 'ENABLED',
			EnableTokenRevocation: true,
			AccessTokenValidity: 60,
			IdTokenValidity: 60,
			RefreshTokenValidity: 30,
			TokenValidityUnits: {
				AccessToken: 'minutes',
				IdToken: 'minutes',
				RefreshToken: 'days',
			},
		}));
		const clientId = result.UserPoolClient?.ClientId?.trim();
		if (!clientId) throw new Error('Cognito did not return a client ID');
		this.allowedClientIds.add(clientId);

		return {
			client_id: clientId,
			client_id_issued_at: Math.floor(Date.now() / 1000),
			client_name: request.clientName,
			redirect_uris: request.redirectUris,
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			scope: 'openid',
		};
	}

	async isRegisteredClient(clientId: string): Promise<boolean> {
		if (this.allowedClientIds.has(clientId)) return true;
		try {
			const result = await this.client.send(new DescribeUserPoolClientCommand({
				UserPoolId: this.userPoolId,
				ClientId: clientId,
			}));
			const client = result.UserPoolClient;
			const valid = Boolean(
				client?.ClientName?.startsWith(CLIENT_NAME_PREFIX)
				&& client.AllowedOAuthFlowsUserPoolClient
				&& client.AllowedOAuthFlows?.includes('code')
				&& client.AllowedOAuthScopes?.includes('openid')
				&& client.CallbackURLs?.length
				&& client.CallbackURLs.every(isAllowedRedirectUri)
				&& !client.ClientSecret
			);
			if (valid) this.allowedClientIds.add(clientId);
			return valid;
		} catch {
			return false;
		}
	}
}

function parseRegistrationRequest(raw: unknown): {
	readonly clientName: string;
	readonly redirectUris: readonly string[];
} {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new OAuthRegistrationError('Registration body must be a JSON object');
	}
	const request = raw as RegistrationRequest;
	const redirectUris = stringArray(request.redirect_uris, 'redirect_uris');
	if (redirectUris.length === 0 || redirectUris.length > 5) {
		throw new OAuthRegistrationError('redirect_uris must contain between 1 and 5 URLs');
	}
	if (new Set(redirectUris).size !== redirectUris.length || !redirectUris.every(isAllowedRedirectUri)) {
		throw new OAuthRegistrationError('Only ChatGPT connector callback URLs are allowed');
	}
	if (request.token_endpoint_auth_method !== undefined && request.token_endpoint_auth_method !== 'none') {
		throw new OAuthRegistrationError('token_endpoint_auth_method must be none');
	}
	if (request.grant_types !== undefined) {
		const grants = stringArray(request.grant_types, 'grant_types');
		if (!grants.includes('authorization_code') || grants.some((grant) => !ALLOWED_GRANTS[grant])) {
			throw new OAuthRegistrationError('grant_types must use authorization_code with optional refresh_token');
		}
	}
	if (request.response_types !== undefined) {
		const responseTypes = stringArray(request.response_types, 'response_types');
		if (responseTypes.length !== 1 || responseTypes[0] !== 'code') {
			throw new OAuthRegistrationError('response_types must contain only code');
		}
	}
	if (request.scope !== undefined && request.scope !== 'openid') {
		throw new OAuthRegistrationError('scope must be openid');
	}
	const clientName = typeof request.client_name === 'string' && request.client_name.trim()
		? request.client_name.trim().slice(0, 128)
		: 'ChatGPT NumeraiDashboard connector';
	return { clientName, redirectUris };
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new OAuthRegistrationError(`${field} must be an array of strings`);
	}
	return value.map((item) => (item as string).trim());
}

function isAllowedRedirectUri(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port || url.search || url.hash) return false;
		return url.pathname === '/connector_platform_oauth_redirect'
			|| /^\/connector\/oauth\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
	} catch {
		return false;
	}
}

function clientNameFor(redirectUris: readonly string[]): string {
	const digest = createHash('sha256').update(redirectUris.join('\n')).digest('hex').slice(0, 24);
	return `${CLIENT_NAME_PREFIX}${digest}`;
}
