export type ConnectionRecord = {
	readonly verifiedAt?: string | null;
	readonly lastVerifyError?: string | null;
	readonly status?: string | null;
};

export type WorkRecord = {
	readonly status?: string | null;
};

export type SubmissionRecord = {
	readonly name?: string | null;
	readonly lastSubmittedAt?: string | null;
	readonly lastSubmittedRound?: number | null;
};

export type StatusTone = 'good' | 'warn' | 'bad' | 'neutral';

export type DashboardStatus = {
	readonly label: string;
	readonly detail: string;
	readonly tone: StatusTone;
};

const activeWorkStatuses = new Set(['planned', 'queued', 'running']);

export function summarizeNumeraiConnection(accounts: readonly ConnectionRecord[]): DashboardStatus {
	if (accounts.length === 0) {
		return {
			label: 'Not connected',
			detail: 'Add a Numerai account in Settings before queueing submissions.',
			tone: 'bad'
		};
	}

	if (accounts.some((account) => account.lastVerifyError)) {
		return {
			label: 'Needs attention',
			detail: 'A saved Numerai account has a verification error.',
			tone: 'warn'
		};
	}

	if (accounts.some((account) => account.verifiedAt)) {
		return {
			label: 'Connected',
			detail: `${accounts.length} Numerai account${accounts.length === 1 ? '' : 's'} saved and verified.`,
			tone: 'good'
		};
	}

	return {
		label: 'Unverified',
		detail: 'Verify the saved Numerai account before upload automation runs.',
		tone: 'warn'
	};
}

export function summarizeComputeConnection(providers: readonly ConnectionRecord[]): DashboardStatus {
	const enabledProviders = providers.filter((provider) => provider.status !== 'disabled');

	if (enabledProviders.length === 0) {
		return {
			label: 'No providers',
			detail: 'Add Modal, SageMaker, local, or another compute provider in Settings.',
			tone: 'bad'
		};
	}

	if (enabledProviders.some((provider) => provider.lastVerifyError)) {
		return {
			label: 'Needs attention',
			detail: 'At least one compute provider failed its latest verification check.',
			tone: 'warn'
		};
	}

	if (enabledProviders.some((provider) => provider.verifiedAt)) {
		return {
			label: 'Ready',
			detail: `${enabledProviders.length} active compute provider${enabledProviders.length === 1 ? '' : 's'} configured.`,
			tone: 'good'
		};
	}

	return {
		label: 'Configured',
		detail: 'Providers exist, but none have a verified connection yet.',
		tone: 'warn'
	};
}

export function countActiveWork(records: readonly WorkRecord[]): number {
	return records.filter((record) => activeWorkStatuses.has(record.status ?? '')).length;
}

export function latestSubmission(records: readonly SubmissionRecord[]): SubmissionRecord | null {
	const submitted = records.filter((record) => record.lastSubmittedAt || record.lastSubmittedRound != null);
	if (submitted.length === 0) return null;

	return [...submitted].sort((a, b) => {
		const aTime = a.lastSubmittedAt ? Date.parse(a.lastSubmittedAt) : 0;
		const bTime = b.lastSubmittedAt ? Date.parse(b.lastSubmittedAt) : 0;
		if (aTime !== bTime) return bTime - aTime;
		return (b.lastSubmittedRound ?? 0) - (a.lastSubmittedRound ?? 0);
	})[0];
}

export function nextDashboardAction(args: {
	readonly numerai: DashboardStatus;
	readonly compute: DashboardStatus;
	readonly modelCount: number;
	readonly activeWorkCount: number;
}): { readonly label: string; readonly href: string } {
	if (args.numerai.tone === 'bad' || args.numerai.tone === 'warn') {
		return { label: 'Connect Numerai account', href: '/settings' };
	}
	if (args.compute.tone === 'bad' || args.compute.tone === 'warn') {
		return { label: 'Connect compute provider', href: '/settings' };
	}
	if (args.modelCount === 0) {
		return { label: 'Register first model', href: '/models' };
	}
	if (args.activeWorkCount > 0) {
		return { label: 'Review active work', href: '/' };
	}
	return { label: 'Design next run', href: '/builder' };
}
