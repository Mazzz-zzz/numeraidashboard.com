import { describe, expect, it } from 'vitest';
import { editableCredentialValue, preservedCredentialRef, settingsCredentialInputType } from './settings-credentials';

describe('settings credential input behavior', () => {
	it('renders API credentials as visible editable text fields', () => {
		expect(settingsCredentialInputType('numeraiApiSecret')).toBe('text');
		expect(settingsCredentialInputType('primeIntellectApiKey')).toBe('text');
		expect(settingsCredentialInputType('modalTokenId')).toBe('text');
		expect(settingsCredentialInputType('modalTokenSecret')).toBe('text');
		expect(settingsCredentialInputType('customApiKey')).toBe('text');
	});

	it('keeps true password fields masked outside API credential settings', () => {
		expect(settingsCredentialInputType('accountPassword')).toBe('password');
	});

	it('submits the full edited API credential value for autosave-style persistence', () => {
		expect(editableCredentialValue('  as-modal-token-secret  ')).toBe('as-modal-token-secret');
		expect(editableCredentialValue('   ')).toBeNull();
	});

	it('preserves existing secret references when a credential field is left blank', () => {
		expect(preservedCredentialRef('/old/ref', null)).toBe('/old/ref');
		expect(preservedCredentialRef('/old/ref', '/new/ref')).toBe('/new/ref');
		expect(preservedCredentialRef(null, null)).toBeNull();
	});
});
