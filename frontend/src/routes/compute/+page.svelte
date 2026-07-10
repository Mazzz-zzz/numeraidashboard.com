<script lang="ts">
	import { onMount } from 'svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { authState } from '$lib/auth';
	import { addToast } from '$lib/stores';
	import {
		computeJobRows,
		formatCurrency,
		listComputeJobs,
		listComputeProviders,
		providerCards,
		updateComputeJobStatus,
		updateComputeProviderBudget,
		type ComputeJob,
		type ComputeProvider
	} from '$lib/services/compute-service';
	import {
		cancelTrainingRun,
		pollTrainingRunStatus,
		startTrainingRun,
		terminalActionTimestamp,
		toComputeJobStatus,
		updateTrainingRunFromAction
	} from '$lib/services/training-service';

	let selectedProviderId = $state('');
	let monthlyBudget = $state(250);
	let runCap = $state(18);
	let maxConcurrentJobs = $state(4);
	let loading = $state(true);
	let busy = $state(false);
	let providers = $state<ComputeProvider[]>([]);
	let jobs = $state<ComputeJob[]>([]);

	const cards = $derived(providerCards(providers));
	const selectedProvider = $derived(
		cards.find((provider) => provider.id === selectedProviderId) ?? cards[0]
	);
	const selectedProviderRecord = $derived(
		providers.find((provider) => provider.id === selectedProviderId) ?? providers[0]
	);
	const queuedJobs = $derived(computeJobRows(jobs, providers));

	onMount(() => {
		if ($authState.user) void loadCompute();
	});

	$effect(() => {
		if ($authState.user && loading) void loadCompute();
	});

	async function loadCompute() {
		loading = true;
		try {
			const [providerRows, jobRows] = await Promise.all([listComputeProviders(), listComputeJobs()]);
			providers = providerRows;
			jobs = jobRows;
			const firstProvider = providerRows[0];
			if (firstProvider) selectProvider(firstProvider.id);
		} catch (error) {
			console.error(error);
			addToast('Compute records could not load.', 'error');
		} finally {
			loading = false;
		}
	}

	function selectProvider(providerId: string) {
		selectedProviderId = providerId;
		const provider = providers.find((item) => item.id === providerId);
		monthlyBudget = provider?.monthlyBudgetUsd ?? 250;
		runCap = provider?.defaultRunCapUsd ?? 18;
		maxConcurrentJobs = provider?.maxConcurrentJobs ?? 4;
	}

	async function saveBudgetControls() {
		if (!selectedProviderRecord) {
			addToast('Add a compute provider in Settings first.', 'error');
			return;
		}
		busy = true;
		try {
			const updated = await updateComputeProviderBudget({
				providerId: selectedProviderRecord.id,
				monthlyBudgetUsd: monthlyBudget,
				defaultRunCapUsd: runCap,
				maxConcurrentJobs
			});
			providers = providers.map((provider) => (provider.id === updated.id ? updated : provider));
			addToast('Compute budget controls saved.', 'success');
		} catch (error) {
			console.error(error);
			addToast('Compute budget controls could not be saved.', 'error');
		} finally {
			busy = false;
		}
	}

	async function cancelJob(jobId: string) {
		busy = true;
		try {
			const job = jobs.find((item) => item.id === jobId);
			const provider = providers.find((item) => item.id === job?.providerId);
			const action =
				job?.runId && provider
					? await cancelTrainingRun({
							runId: job.runId,
							provider,
							providerJobId: job.providerJobId ?? null
						})
					: null;
			if (action && !action.ok) throw new Error(action.error ?? 'Cancel request failed');
			const updated = await updateComputeJobStatus({
				jobId,
				status: toComputeJobStatus(action?.status ?? 'cancelled'),
				finishedAt: action ? terminalActionTimestamp(action.status, action.checkedAt) : new Date().toISOString(),
				providerJobId: action?.providerJobId ?? job?.providerJobId ?? null,
				logTail: action?.logTail ?? null,
				actualCostUsd: action?.costUsd ?? null
			});
			if (action && job?.runId) {
				await updateTrainingRunFromAction({
					runId: job.runId,
					action,
					currentStartedAt: job.startedAt ?? null
				});
			}
			jobs = jobs.map((item) => (item.id === updated.id ? updated : item));
			addToast('Compute job cancelled.', 'success');
		} catch (error) {
			console.error(error);
			addToast('Compute job could not be cancelled.', 'error');
		} finally {
			busy = false;
		}
	}

	async function retryJob(jobId: string) {
		busy = true;
		try {
			const job = jobs.find((item) => item.id === jobId);
			const provider = providers.find((item) => item.id === job?.providerId);
			if (!job?.runId || !provider) {
				addToast('Retry needs a training run and provider.', 'error');
				return;
			}
			const action = await startTrainingRun({ runId: job.runId, provider });
			if (!action.ok) throw new Error(action.error ?? 'Retry request failed');
			const updated = await updateComputeJobStatus({
				jobId,
				status: toComputeJobStatus(action.status),
				startedAt: toComputeJobStatus(action.status) === 'running' ? action.checkedAt : undefined,
				finishedAt: terminalActionTimestamp(action.status, action.checkedAt),
				providerJobId: action.providerJobId ?? null,
				logTail: action.logTail ?? null,
				actualCostUsd: action.costUsd ?? null
			});
			await updateTrainingRunFromAction({
				runId: job.runId,
				action,
				currentStartedAt: job.startedAt ?? null
			});
			jobs = jobs.map((item) => (item.id === updated.id ? updated : item));
			addToast('Compute job requeued.', 'success');
		} catch (error) {
			console.error(error);
			addToast('Compute job could not be retried.', 'error');
		} finally {
			busy = false;
		}
	}

	async function refreshJob(jobId: string) {
		busy = true;
		try {
			const job = jobs.find((item) => item.id === jobId);
			const provider = providers.find((item) => item.id === job?.providerId);
			if (!job?.runId || !provider) {
				addToast('Status refresh needs a training run and provider.', 'error');
				return;
			}
			const action = await pollTrainingRunStatus({
				runId: job.runId,
				provider,
				providerJobId: job.providerJobId ?? null
			});
			if (!action.ok) throw new Error(action.error ?? 'Status refresh failed');
			const updated = await updateComputeJobStatus({
				jobId,
				status: toComputeJobStatus(action.status),
				startedAt:
					toComputeJobStatus(action.status) === 'running'
						? (job.startedAt ?? action.checkedAt)
						: job.startedAt,
				finishedAt: terminalActionTimestamp(action.status, action.checkedAt),
				providerJobId: action.providerJobId ?? null,
				logTail: action.logTail ?? null,
				actualCostUsd: action.costUsd ?? null
			});
			await updateTrainingRunFromAction({
				runId: job.runId,
				action,
				currentStartedAt: job.startedAt ?? null
			});
			jobs = jobs.map((item) => (item.id === updated.id ? updated : item));
			addToast('Compute job status refreshed.', 'success');
		} catch (error) {
			console.error(error);
			addToast('Compute job status could not be refreshed.', 'error');
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Compute | Numerai Dashboard</title>
</svelte:head>

<AuthGate>
<section class="compute-page">
	<header class="page-head">
		<div>
			<p class="eyebrow">Compute</p>
			<h1>Choose the route before launching the sweep.</h1>
			<p>
				Compute is the cost control plane for Builder. Compare providers, set budget caps, and
				see queued jobs from the Amplify workspace before a run hits a provider.
			</p>
		</div>
		<div class="budget-card">
			<span>Monthly cap</span>
			<strong>{formatCurrency(monthlyBudget)}</strong>
			<input type="range" min="50" max="1000" step="25" bind:value={monthlyBudget} />
			<button type="button" disabled={busy || loading || !selectedProvider} onclick={saveBudgetControls}>
				Save limits
			</button>
		</div>
	</header>

	<div class="compute-grid">
		<section class="provider-grid" aria-label="Compute providers">
			{#each cards as provider}
				<button
					type="button"
					class:active={selectedProviderId === provider.id}
					onclick={() => selectProvider(provider.id)}
				>
					<span>{provider.status}</span>
					<strong>{provider.name}</strong>
					<small>{provider.type}</small>
					<p>{provider.body}</p>
				</button>
			{/each}
			{#if !cards.length}
				<div class="empty-card">
					<span>No providers</span>
					<strong>Add compute in Settings</strong>
					<p>Provider cards appear here after you connect Modal, SageMaker, Prime Intellect, local, or custom compute.</p>
				</div>
			{/if}
		</section>

		<aside class="detail-panel">
			<section class="panel">
				<p class="eyebrow">Selected provider</p>
				<h2>{selectedProvider?.name ?? 'No provider selected'}</h2>
				<p>{selectedProvider?.body ?? 'Add a provider in Settings to enable compute controls.'}</p>
				<div class="facts">
					<div><span>Monthly</span><strong>{formatCurrency(selectedProvider?.monthlyBudgetUsd)}</strong></div>
					<div><span>Run cap</span><strong>{formatCurrency(selectedProvider?.defaultRunCapUsd)}</strong></div>
					<div><span>Status</span><strong>{selectedProvider?.status ?? 'unset'}</strong></div>
				</div>
			</section>

			<section class="panel">
				<h2>Run limits</h2>
				<label>
					<span>Max concurrent jobs</span>
					<input type="range" min="1" max="32" bind:value={maxConcurrentJobs} />
					<strong>{maxConcurrentJobs} jobs</strong>
				</label>
				<label>
					<span>Default spend cap</span>
					<input type="range" min="5" max="250" step="5" bind:value={runCap} />
					<strong>{formatCurrency(runCap)}</strong>
				</label>
			</section>
		</aside>
	</div>

	<section class="jobs">
		<div>
			<p class="eyebrow">Queue</p>
			<h2>Provider-aware jobs</h2>
		</div>
		<div class="job-table">
			<div class="row head">
				<span>Job</span>
				<span>Provider</span>
				<span>Started</span>
				<span>Status</span>
				<span>Actions</span>
			</div>
			{#each queuedJobs as job}
				<div class="row">
					<span>{job.name}</span>
					<span>{job.provider}</span>
					<span>{job.startedAt}</span>
					<span>{job.status}</span>
					<span class="row-actions">
						<button type="button" disabled={busy || !job.runId || !job.providerId} onclick={() => refreshJob(job.id)}>
							Refresh
						</button>
						<button type="button" disabled={busy || !job.canCancel} onclick={() => cancelJob(job.id)}>
							Cancel
						</button>
						<button type="button" disabled={busy || !job.canRetry} onclick={() => retryJob(job.id)}>
							Retry
						</button>
					</span>
				</div>
			{/each}
			{#if !queuedJobs.length}
				<div class="row empty-row">
					<span>No compute jobs queued yet.</span>
					<span>Queue a sweep from Builder to create planned jobs.</span>
				</div>
			{/if}
		</div>
	</section>
</section>
</AuthGate>

<style>
	.compute-page {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		padding: 1rem 0 4rem;
	}

	.page-head {
		display: flex;
		justify-content: space-between;
		gap: 1.5rem;
		align-items: end;
		border-bottom: 1px solid var(--border-light);
		padding-bottom: 1.5rem;
	}

	.eyebrow,
	.budget-card span,
	.provider-grid span,
	.facts span,
	label span,
	.row.head {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.68rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		max-width: 13ch;
		font-size: clamp(3rem, 7vw, 5.6rem);
		line-height: 0.92;
		letter-spacing: 0;
	}

	.page-head p {
		max-width: 62ch;
		margin-top: 1rem;
		color: var(--text-secondary);
		line-height: 1.65;
	}

	.budget-card,
	.panel,
	.provider-grid button,
	.empty-card,
	.job-table {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
	}

	.budget-card {
		display: grid;
		gap: 0.55rem;
		min-width: 260px;
		padding: 1rem;
	}

	.budget-card strong {
		font-size: 2rem;
	}

	.compute-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.2fr) minmax(300px, 0.8fr);
		gap: 1rem;
		align-items: start;
	}

	.provider-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.85rem;
	}

	button,
	input {
		font: inherit;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.budget-card button,
	.row-actions button {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: #fff;
		color: var(--text);
		cursor: pointer;
		font-weight: 720;
	}

	.budget-card button {
		min-height: 2.35rem;
	}

	.provider-grid button,
	.empty-card {
		display: grid;
		gap: 0.5rem;
		min-height: 220px;
		padding: 1rem;
		color: var(--text);
		cursor: pointer;
		text-align: left;
	}

	.empty-card {
		align-content: start;
	}

	.provider-grid button.active {
		border-color: var(--text);
		box-shadow: var(--shadow-md);
	}

	.provider-grid strong {
		font-size: 1.35rem;
	}

	.provider-grid small,
	.provider-grid p,
	.empty-card p,
	.panel p {
		color: var(--text-secondary);
		line-height: 1.55;
	}

	.detail-panel {
		display: grid;
		gap: 1rem;
	}

	.panel {
		padding: 1rem;
	}

	.panel h2 {
		margin-bottom: 0.8rem;
	}

	.facts {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		margin-top: 1rem;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		overflow: hidden;
	}

	.facts div {
		padding: 0.75rem;
		border-right: 1px solid var(--border-light);
	}

	.facts div:last-child {
		border-right: none;
	}

	.facts strong {
		display: block;
		margin-top: 0.25rem;
	}

	label {
		display: grid;
		gap: 0.45rem;
		margin-top: 0.85rem;
	}

	input[type='range'] {
		width: 100%;
		accent-color: var(--text);
	}

	.jobs {
		display: grid;
		grid-template-columns: minmax(220px, 0.42fr) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
		border-top: 1px solid var(--border-light);
		padding-top: 1.5rem;
	}

	.jobs h2 {
		font-size: clamp(1.8rem, 3vw, 3rem);
		line-height: 1;
	}

	.job-table {
		overflow: hidden;
	}

	.row {
		display: grid;
		grid-template-columns: 1.25fr 1fr 1fr 0.8fr 1fr;
		gap: 1rem;
		align-items: center;
		padding: 0.85rem 1rem;
		border-bottom: 1px solid var(--border-light);
	}

	.row:last-child {
		border-bottom: none;
	}

	.row-actions {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.row-actions button {
		min-height: 2rem;
		padding: 0 0.55rem;
		font-size: 0.78rem;
	}

	.empty-row {
		grid-template-columns: 1fr;
		color: var(--text-secondary);
	}

	@media (max-width: 980px) {
		.page-head,
		.compute-grid,
		.jobs {
			display: grid;
			grid-template-columns: 1fr;
			align-items: start;
		}
	}

	@media (max-width: 700px) {
		.provider-grid,
		.facts,
		.row {
			grid-template-columns: 1fr;
		}

		.row.head {
			display: none;
		}
	}
</style>
