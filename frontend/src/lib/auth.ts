import { Amplify, type ResourcesConfig } from 'aws-amplify';
import {
	signIn as amplifySignIn,
	signUp as amplifySignUp,
	signOut as amplifySignOut,
	confirmSignUp as amplifyConfirmSignUp,
	resendSignUpCode as amplifyResendCode,
	associateWebAuthnCredential,
	deleteWebAuthnCredential,
	listWebAuthnCredentials,
	getCurrentUser,
	fetchAuthSession,
	type AuthUser,
} from 'aws-amplify/auth';
import { writable } from 'svelte/store';
import outputs from '../../amplify_outputs.json';

const envUserPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID as string | undefined;
const envUserPoolClientId = import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID as string | undefined;
const envConfig: ResourcesConfig | undefined =
	envUserPoolId && envUserPoolClientId
		? {
				Auth: {
					Cognito: {
						userPoolId: envUserPoolId,
						userPoolClientId: envUserPoolClientId,
					},
				},
			}
		: undefined;

const hasOutputs = outputs && typeof outputs === 'object' && 'auth' in outputs;
if (hasOutputs) {
	Amplify.configure(outputs as never, { ssr: true });
} else if (envConfig) {
	Amplify.configure(envConfig, { ssr: true });
} else if (typeof window !== 'undefined') {
	console.error(
		'Amplify auth not configured: amplify_outputs.json missing and VITE_COGNITO_USER_POOL_ID / VITE_COGNITO_USER_POOL_CLIENT_ID not set. Run `npm run sandbox` from frontend/ to generate outputs.'
	);
}

export interface AuthState {
	loading: boolean;
	user: AuthUser | null;
	email: string | null;
}

export const authState = writable<AuthState>({ loading: true, user: null, email: null });

export async function refreshAuth(): Promise<void> {
	try {
		const user = await getCurrentUser();
		const session = await fetchAuthSession();
		const email = (session.tokens?.idToken?.payload?.email as string | undefined) ?? null;
		authState.set({ loading: false, user, email });
	} catch {
		authState.set({ loading: false, user: null, email: null });
	}
}

export async function signIn(email: string, password: string) {
	const result = await amplifySignIn({ username: email, password });
	await refreshAuth();
	return result;
}

export async function signInWithPasskey(email: string) {
	const result = await amplifySignIn({
		username: email,
		options: { authFlowType: 'USER_AUTH', preferredChallenge: 'WEB_AUTHN' },
	});
	await refreshAuth();
	return result;
}

export async function registerPasskey() {
	return associateWebAuthnCredential();
}

export async function getPasskeys() {
	return listWebAuthnCredentials();
}

export async function deletePasskey(credentialId: string) {
	return deleteWebAuthnCredential({ credentialId });
}

export async function signUp(email: string, password: string) {
	return amplifySignUp({
		username: email,
		password,
		options: { userAttributes: { email } },
	});
}

export async function confirmSignUp(email: string, code: string) {
	return amplifyConfirmSignUp({ username: email, confirmationCode: code });
}

export async function resendCode(email: string) {
	return amplifyResendCode({ username: email });
}

export async function signOut() {
	await amplifySignOut();
	await refreshAuth();
}

export async function getIdToken(): Promise<string | null> {
	try {
		const session = await fetchAuthSession();
		return session.tokens?.idToken?.toString() ?? null;
	} catch {
		return null;
	}
}
