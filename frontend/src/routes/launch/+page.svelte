<script lang="ts">
	import { onMount } from 'svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { authState } from '$lib/auth';
	import { addToast } from '$lib/stores';
	import { listComputeJobs, listComputeProviders, type ComputeJob, type ComputeProvider } from '$lib/services/compute-service';
	import { launchModelDraft, refreshModelTraining } from '$lib/services/model-launch-service';
	import {
		listRegistryModels,
		modelStageLabels,
		updateRegistryModelStage,
		type ModelRegistryItem,
		type ModelStage
	} from '$lib/services/registry-service';

	let loading = $state(true);
	let busy = $state(false);
	let models = $state<ModelRegistryItem[]>([]);
	let providers = $state<ComputeProvider[]>([]);
	let jobs = $state<ComputeJob[]>([]);
	let selectedProviderId = $state('');
	let maxSpend = $state(20);

	const providerOptions = $derived(providers.filter((provider) => provider.status !== 'disabled'));
	const selectedProvider = $derived(providerOptions.find((provider) => provider.id === selectedProviderId));
	const launchModels = $derived(
		models.filter((model) => model.stage === 'draft' || model.stage === 'training' || model.stage === 'failed' || model.stage === 'success')
	);

	onMount(() => {
		if ($authState.user) void load();
	});

	$effect(() => {
		if ($authState.user && loading) void load();
	});

	async function load() {
		loading = true;
		try {
			const [modelRows, providerRows, jobRows] = await Promise.all([
				listRegistryModels(),
				listComputeProviders(),
				listComputeJobs()
			]);
			models = modelRows;
			providers = providerRows;
			jobs = jobRows;
			selectedProviderId = providerRows.find((provider) => provider.status !== 'disabled')?.id ?? '';
		} catch (error) {
			console.error(error);
			addToast('Launch workspace could not load.', 'error');
		} finally {
			loading = false;
		}
	}

	async function launch(model: ModelRegistryItem) {
		if (!selectedProvider) {
			addToast('Select a compute provider first.', 'error');
			return;
		}
		busy = true;
		try {
			const result = await launchModelDraft({ model, provider: selectedProvider, maxSpendUsd: maxSpend });
			upsertModel(result.model);
			upsertJob(result.job);
			addToast(`${result.model.name} is training.`, 'success');
		} catch (error) {
			console.error(error);
			await markFailed(model);
			addToast(error instanceof Error ? error.message : 'Model could not launch.', 'error');
		} finally {
			busy = false;
		}
	}

	async function refresh(model: ModelRegistryItem) {
		const job = jobForModel(model);
		const provider = providers.find((item) => item.id === job?.providerId);
		if (!job || !provider) {
			addToast('Training refresh needs a compute job and provider.', 'error');
			return;
		}
		busy = true;
		try {
			const result = await refreshModelTraining({ model, job, provider });
			upsertModel(result.model);
			upsertJob(result.job);
			addToast(`${result.model.name} is ${modelStageLabels[result.model.stage as ModelStage].toLowerCase()}.`, 'success');
		} catch (error) {
			console.error(error);
			await markFailed(model);
			addToast(error instanceof Error ? error.message : 'Training status could not refresh.', 'error');
		} finally {
			busy = false;
		}
	}

	async function markFailed(model: ModelRegistryItem) {
		try {
			const result = await updateRegistryModelStage(model.id, 'failed');
			const failedModel = result.data ? (result.data as ModelRegistryItem) : { ...model, stage: 'failed' };
			upsertModel(failedModel as ModelRegistryItem);
		} catch (error) {
			console.error(error);
			models = models.map((item) => (item.id === model.id ? { ...item, stage: 'failed' } : item));
		}
	}

	function upsertModel(model: ModelRegistryItem) {
		models = [model, ...models.filter((item) => item.id !== model.id)];
	}

	function upsertJob(job: ComputeJob) {
		jobs = [job, ...jobs.filter((item) => item.id !== job.id)];
	}

	function jobForModel(model: ModelRegistryItem): ComputeJob | undefined {
		return model.runId ? jobs.find((job) => job.runId === model.runId) : undefined;
	}

	function providerName(model: ModelRegistryItem): string {
		const job = jobForModel(model);
		return providers.find((provider) => provider.id === job?.providerId)?.name ?? selectedProvider?.name ?? 'No provider';
	}

	function stageName(stage: string | null | undefined): string {
		return modelStageLabels[(stage ?? 'draft') as ModelStage] ?? 'Draft';
	}

	function canLaunch(model: ModelRegistryItem): boolean {
		return !!selectedProvider && (model.stage === 'draft' || model.stage === 'failed');
	}
</script>

<svelte:head>
	<title>Launch | Numerai Dashboard</title>
</svelte:head>

<AuthGate>
	<section class="launch-page">
		<header class="page-head">
			<div>
				<p class="eyebrow">Launch</p>
				<h1>Train model drafts.</h1>
			</div>
			<div class="launch-controls">
				<label>
					<span>Provider</span>
					<select bind:value={selectedProviderId}>
						{#each providerOptions as provider}
							<option value={provider.id}>{provider.name}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Budget</span>
					<input type="number" min="1" max="5000" bind:value={maxSpend} />
				</label>
			</div>
		</header>

		<section class="models-shell">
			{#if loading}
				<p class="muted pad">Loading models...</p>
			{:else if !launchModels.length}
				<div class="empty">
					<p class="eyebrow">No drafts</p>
					<h2>No draft models to launch.</h2>
				</div>
			{:else}
				<table>
					<thead>
						<tr>
							<th>Model</th>
							<th>Stage</th>
							<th>Provider</th>
							<th>Job</th>
							<th aria-label="Actions"></th>
						</tr>
					</thead>
					<tbody>
						{#each launchModels as model (model.id)}
							<tr>
								<td>
									<strong>{model.name}</strong>
									<span>{model.changeSummary ?? 'draft'}</span>
								</td>
								<td><span class="stage-chip" data-stage={model.stage}>{stageName(model.stage)}</span></td>
								<td>{providerName(model)}</td>
								<td class="mono">{jobForModel(model)?.status ?? 'not started'}</td>
								<td class="actions">
									{#if model.stage === 'training'}
										<button type="button" onclick={() => refresh(model)} disabled={busy}>Refresh</button>
									{:else if canLaunch(model)}
										<button type="button" class="primary" onclick={() => launch(model)} disabled={busy}>Launch</button>
									{:else}
										<button type="button" disabled>Launch</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>
	</section>
</AuthGate>

<style>
	.launch-page {
		display: grid;
		gap: 1rem;
		padding: 1rem 0 4rem;
	}

	.page-head {
		display: flex;
		justify-content: space-between;
		align-items: end;
		gap: 1rem;
		border-bottom: 1px solid var(--border-light);
		padding-bottom: 1rem;
	}

	.eyebrow {
		margin: 0 0 0.45rem;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		font-size: clamp(2.4rem, 5vw, 4.4rem);
		line-height: 0.95;
		letter-spacing: 0;
	}

	.launch-controls {
		display: grid;
		grid-template-columns: minmax(220px, 1fr) 140px;
		gap: 0.75rem;
		align-items: end;
		min-width: min(100%, 430px);
	}

	label {
		display: grid;
		gap: 0.35rem;
	}

	label > span,
	th {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	select,
	input,
	button {
		font: inherit;
	}

	select,
	input {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text);
		min-height: 2.45rem;
		padding: 0.55rem 0.65rem;
	}

	button {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: #fff;
		color: var(--text);
		cursor: pointer;
		font-weight: 720;
		min-height: 2.25rem;
		padding: 0 0.75rem;
	}

	button.primary {
		background: var(--text);
		color: #fff;
		border-color: var(--text);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.models-shell {
		border: 1px solid var(--text);
		border-radius: 6px;
		background: var(--bg-card);
		box-shadow: 4px 4px 0 var(--text);
		overflow-x: auto;
		min-height: 320px;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th {
		text-align: left;
		padding: 0.7rem 0.85rem;
		background: var(--bg-page);
		border-bottom: 1px solid var(--text);
		white-space: nowrap;
	}

	td {
		padding: 0.75rem 0.85rem;
		border-bottom: 1px solid var(--border-light);
		font-size: 0.85rem;
		vertical-align: middle;
	}

	td strong,
	td span {
		display: block;
	}

	td span {
		color: var(--text-secondary);
		font-size: 0.76rem;
	}

	.mono {
		font-family: var(--font-mono);
	}

	.actions {
		text-align: right;
		white-space: nowrap;
	}

	.stage-chip {
		display: inline-block;
		font-family: var(--font-mono);
		font-size: 0.68rem;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		padding: 0.18rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg-input);
		color: var(--text);
		white-space: nowrap;
	}

	.stage-chip[data-stage='training'],
	.stage-chip[data-stage='testing'] {
		border-color: var(--orange);
		background: var(--badge-orange);
		color: var(--orange);
	}

	.stage-chip[data-stage='success'],
	.stage-chip[data-stage='live'] {
		border-color: var(--green);
		background: var(--badge-green);
		color: var(--green);
	}

	.stage-chip[data-stage='failed'] {
		border-color: var(--red);
		background: var(--badge-red);
		color: var(--red);
	}

	.stage-chip[data-stage='retired'] {
		color: var(--text-muted);
	}

	.pad,
	.empty {
		padding: 1rem;
	}

	.muted {
		color: var(--text-secondary);
	}

	@media (max-width: 760px) {
		.page-head,
		.launch-controls {
			display: grid;
			grid-template-columns: 1fr;
		}
	}
</style>
