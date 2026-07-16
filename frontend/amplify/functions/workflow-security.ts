import { createHash } from 'node:crypto';

const secretRoot = '/numeraidashboard';
const modalHostSuffix = '.modal.run';

type IdentityEvent = {
	readonly identity?: unknown;
};

type WorkflowOwnerEvent = IdentityEvent & {
	readonly arguments?: { readonly ownerSub?: string | null };
};

type ProviderRuntimeInput = {
	readonly providerType?: string | null;
	readonly apiKey?: string | null;
	readonly apiSecret?: string | null;
	readonly apiKeyRef?: string | null;
	readonly apiSecretRef?: string | null;
	readonly baseUrl?: string | null;
	readonly providerConfigJson?: unknown;
};

export function requireCallerSub(event: IdentityEvent): string {
	const identity = asRecord(event.identity);
	const claims = asRecord(identity?.claims);
	const sub = stringValue(identity?.sub) ?? stringValue(claims?.sub);
	if (!sub || sub.includes('/') || sub === '.' || sub === '..') {
		throw new Error('Authenticated caller identity is required.');
	}
	return sub;
}

/**
 * Cognito callers always use their own subject. Resource-authorized internal
 * callers (the hosted MCP Lambda) must explicitly pass the already-authenticated
 * API-key owner because IAM identities do not contain a Cognito subject.
 */
export function requireWorkflowOwner(event: WorkflowOwnerEvent): string {
	try {
		return requireCallerSub(event);
	} catch {
		const identity = asRecord(event.identity);
		const ownerSub = event.arguments?.ownerSub?.trim();
		if (!isIamIdentity(identity) || !validOwnerSub(ownerSub)) {
			throw new Error('Authenticated caller identity is required.');
		}
		return ownerSub;
	}
}

export function ownedSecretRef(
	value: string | null | undefined,
	ownerSub: string,
	label = 'Secret reference'
): string | null {
	const ref = value?.trim();
	if (!ref) return null;
	const prefix = `${secretRoot}/${ownerSub}/`;
	if (!ref.startsWith(prefix)) {
		throw new Error(`${label} is outside the authenticated user's secret scope.`);
	}
	return ref;
}

export function secretPath(ownerSub: string, scope: string, key: string, name: string): string {
	if (!ownerSub || ownerSub.includes('/')) throw new Error('Authenticated caller identity is required.');
	if (!safePathSegment(scope) || !safePathSegment(name)) throw new Error('Invalid secret path segment.');
	const digest = createHash('sha256').update(`${scope}:${key}`).digest('hex').slice(0, 24);
	return `${secretRoot}/${ownerSub}/${scope}/${digest}/${name}`;
}

export function secureProviderRuntimeArgs(input: ProviderRuntimeInput, ownerSub: string) {
	const providerType = input.providerType?.trim().toLowerCase() ?? '';
	// Fresh credentials get a derived caller-owned path instead of reusing a caller-selected write target.
	return {
		apiKeyRef: ownedSecretRef(
			input.apiKey?.trim() ? null : input.apiKeyRef,
			ownerSub,
			'Provider API key reference'
		),
		apiSecretRef: ownedSecretRef(
			input.apiSecret?.trim() ? null : input.apiSecretRef,
			ownerSub,
			'Provider API secret reference'
		),
		baseUrl: trustedProviderUrl(input.baseUrl, providerType, 'Provider base URL'),
		providerConfigJson: trustedProviderConfig(input.providerConfigJson, providerType),
	};
}

export function trustedProviderUrl(
	value: string | null | undefined,
	providerType: string,
	label = 'Provider URL'
): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`${label} must be an absolute URL.`);
	}
	if (url.username || url.password) throw new Error(`${label} must not contain URL credentials.`);
	if (url.hash) throw new Error(`${label} must not contain a fragment.`);

	const type = providerType.trim().toLowerCase();
	const hostname = normalizedHostname(url.hostname);
	switch (type) {
		case 'prime_intellect':
			requireHttps(url, label);
			if (hostname !== 'api.primeintellect.ai' || disallowedTlsPort(url.port)) {
				throw new Error(`${label} must use https://api.primeintellect.ai.`);
			}
			break;
		case 'modal':
			requireHttps(url, label);
			if (!hostname.endsWith(modalHostSuffix) || hostname.length === modalHostSuffix.length || disallowedTlsPort(url.port)) {
				throw new Error(`${label} must use a Modal endpoint under *.modal.run.`);
			}
			break;
		case 'local':
			if (!['http:', 'https:'].includes(url.protocol) || !isPrivateOrLocalHost(hostname)) {
				throw new Error(`${label} for local compute must use a local or private-network host.`);
			}
			break;
		case 'custom':
			requireHttps(url, label);
			if (isPrivateOrLocalHost(hostname)) {
				throw new Error(`${label} must not target a private or local host from the cloud function.`);
			}
			break;
		case 'sagemaker':
			throw new Error(`${label} is not supported for SageMaker.`);
		default:
			throw new Error(`${label} cannot be used with an unknown provider type.`);
	}

	return trimmed.replace(/\/$/, '');
}

export function trustedProviderConfig(value: unknown, providerType: string): unknown {
	if (providerType.trim().toLowerCase() !== 'modal') return value;
	const root = asRecord(value);
	if (!root) return value;
	const modal = asRecord(root.modal) ?? root;
	for (const field of ['launchUrl', 'statusUrl', 'cancelUrl'] as const) {
		const endpoint = stringValue(modal[field]);
		if (endpoint) trustedProviderUrl(endpoint, 'modal', `Modal ${field}`);
	}
	const appHost = stringValue(modal.appHost) ?? stringValue(modal.app_host);
	if (appHost && !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/i.test(appHost)) {
		throw new Error('Modal appHost contains unsupported characters.');
	}
	return value;
}

function requireHttps(url: URL, label: string): void {
	if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
}

function disallowedTlsPort(port: string): boolean {
	return port !== '' && port !== '443';
}

function safePathSegment(value: string): boolean {
	return /^[a-z0-9-]+$/i.test(value);
}

function validOwnerSub(value: string | null | undefined): value is string {
	return Boolean(value && /^[a-z0-9._:@+-]{1,128}$/i.test(value) && value !== '.' && value !== '..');
}

function isIamIdentity(identity: Record<string, unknown> | null): boolean {
	return Boolean(
		identity &&
			(stringValue(identity.accountId) || stringValue(identity.userArn))
	);
}

function normalizedHostname(value: string): string {
	return value.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function isPrivateOrLocalHost(hostname: string): boolean {
	if (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		hostname.endsWith('.internal') ||
		hostname.endsWith('.home.arpa')
	) {
		return true;
	}

	if (hostname.includes(':')) {
		return (
			hostname === '::' ||
			hostname === '::1' ||
			/^f[cd]/i.test(hostname) ||
			/^fe[89ab]/i.test(hostname)
		);
	}

	const octets = hostname.split('.').map(Number);
	if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return false;
	}
	const [a, b] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== 'string') return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}
