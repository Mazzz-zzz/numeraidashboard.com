import { describe, expect, it } from 'vitest';
import { normalizePasskeyRelyingPartyId, passkeyRelyingPartyMatchesOrigin } from './resource';

describe('passkey relying party configuration', () => {
	it('uses the production domain as the default relying party id', () => {
		expect(normalizePasskeyRelyingPartyId(undefined)).toBe('numeraidashboard.com');
		expect(passkeyRelyingPartyMatchesOrigin('numeraidashboard.com', 'https://numeraidashboard.com/settings')).toBe(true);
	});

	it('keeps localhost available for development without ports or paths', () => {
		expect(normalizePasskeyRelyingPartyId('http://localhost:5173/settings')).toBe('localhost');
		expect(normalizePasskeyRelyingPartyId('localhost:5173')).toBe('localhost');
		expect(passkeyRelyingPartyMatchesOrigin('localhost', 'http://localhost:5173/settings')).toBe(true);
	});

	it('strips protocol, port, path, query, and hash from configured domains', () => {
		expect(normalizePasskeyRelyingPartyId('https://numeraidashboard.com:443/settings?tab=passkeys#add')).toBe(
			'numeraidashboard.com'
		);
	});

	it('rejects origins outside the configured relying party domain', () => {
		expect(passkeyRelyingPartyMatchesOrigin('numeraidashboard.com', 'https://example.com/settings')).toBe(false);
		expect(passkeyRelyingPartyMatchesOrigin('localhost', 'https://numeraidashboard.com/settings')).toBe(false);
		expect(() => normalizePasskeyRelyingPartyId('https://')).toThrow('Invalid URL');
	});
});
