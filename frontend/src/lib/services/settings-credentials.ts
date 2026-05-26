export type SettingsCredentialField =
	| 'numeraiApiSecret'
	| 'primeIntellectApiKey'
	| 'modalTokenId'
	| 'modalTokenSecret'
	| 'customApiKey'
	| 'accountPassword';

export function settingsCredentialInputType(field: SettingsCredentialField): 'text' | 'password' {
	return field === 'accountPassword' ? 'password' : 'text';
}

export function editableCredentialValue(value: string): string | null {
	const trimmed = value.trim();
	return trimmed || null;
}

export function preservedCredentialRef(currentRef: string | null | undefined, verifiedRef: string | null | undefined): string | null {
	return verifiedRef ?? currentRef ?? null;
}
