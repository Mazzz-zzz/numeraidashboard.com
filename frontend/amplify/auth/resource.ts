import { defineAuth } from '@aws-amplify/backend';
import { preSignUp } from './pre-sign-up/resource';

const defaultPasskeyRelyingPartyId = 'numeraidashboard.com';

export function normalizePasskeyRelyingPartyId(value: string | null | undefined): string {
	const raw = value?.trim() || defaultPasskeyRelyingPartyId;
	const hostname = raw.includes('://') ? new URL(raw).hostname : raw.split('/')[0]?.split('?')[0]?.split('#')[0];
	const withoutPort = hostname === 'localhost' ? hostname : (hostname ?? '').replace(/:\d+$/, '');
	const relyingPartyId = withoutPort.toLowerCase();
	if (!relyingPartyId) throw new Error('WebAuthn relying party ID is required');
	if (relyingPartyId === 'localhost') return relyingPartyId;
	if (!/^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(relyingPartyId)) {
		throw new Error(`Invalid WebAuthn relying party ID: ${relyingPartyId}`);
	}
	return relyingPartyId;
}

export function passkeyRelyingPartyMatchesOrigin(relyingPartyId: string, origin: string): boolean {
	const rpId = normalizePasskeyRelyingPartyId(relyingPartyId);
	const hostname = new URL(origin).hostname.toLowerCase();
	if (rpId === 'localhost') return hostname === 'localhost';
	return hostname === rpId || hostname.endsWith(`.${rpId}`);
}

export const auth = defineAuth({
	loginWith: {
		email: true,
		webAuthn: {
			relyingPartyId: normalizePasskeyRelyingPartyId(process.env.PASSKEY_RELYING_PARTY_ID),
		},
	},
	triggers: {
		preSignUp,
	},
});
