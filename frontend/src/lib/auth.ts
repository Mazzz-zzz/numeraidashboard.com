import { Amplify } from 'aws-amplify';
import {
	signIn as amplifySignIn,
	signUp as amplifySignUp,
	signOut as amplifySignOut,
	confirmSignUp as amplifyConfirmSignUp,
	resendSignUpCode as amplifyResendCode,
	getCurrentUser,
	fetchAuthSession,
	type AuthUser,
} from 'aws-amplify/auth';
import { writable } from 'svelte/store';

Amplify.configure({
	Auth: {
		Cognito: {
			userPoolId: 'ap-southeast-2_mmskmptBA',
			userPoolClientId: '3sujj9ijap9939v8c6casmqrg5',
		},
	},
});

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
