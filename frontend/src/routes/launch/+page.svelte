<script lang="ts">
	import { onMount } from 'svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { authState } from '$lib/auth';
	import { addToast } from '$lib/stores';
	import { listComputeJobs, listComputeProviders, type ComputeJob, type ComputeProvider } from '$lib/services/compute-service';
	import { launchModelDraft, launchTrainingToast, refreshModelTraining } from '$lib/services/model-launch-service';
	import { gpuOptionsForProvider, selectedGpuForProvider } from '$lib/services/provider-gpu-catalog';
	import { fetchPrimeOffers, type PrimeOffer } from '$lib/services/prime-offers-service';
	import {
		fetchLocalDaemonHealth,
		setLocalDaemonMaxParallel,
		type LocalDaemonHealth
	} from '$lib/services/local-training-service';
	import { trainingProgressForJob } from '$lib/services/training-progress';
	import {
		listRegistryModels,
		modelStageLabels,
		updateRegistryModelStage,
		type ModelRegistryItem,
		type ModelStage
	} from '$lib/services/registry-service';

	let loading = $state(true);
	// Per-model in-flight tracking so one model's launch/refresh doesn't disable
	// the buttons on every other row (the old single `busy` flag did).
	let pendingIds = $state<string[]>([]);
	const isPending = (id: string) => pendingIds.includes(id);
	function setPending(id: string, on: boolean) {
		pendingIds = on ? [...pendingIds, id] : pendingIds.filter((item) => item !== id);
	}
	let models = $state<ModelRegistryItem[]>([]);
	let providers = $state<ComputeProvider[]>([]);
	let jobs = $state<ComputeJob[]>([]);
	let selectedProviderId = $state('');
	let selectedGpuType = $state('');
	let primeOffers = $state<PrimeOffer[]>([]);
	let selectedPrimeOfferId = $state('');
	let primeOffersLoading = $state(false);
	let primeOffersError = $state<string | null>(null);
	let primeOffersRequest = 0;
	let autoRefreshing = $state(false);
	let now = $state(new Date());
	let localHealth = $state<LocalDaemonHealth | null>(null);

	const AUTO_REFRESH_MS = 10_000;
	const LOCAL_HEALTH_MS = 4_000;

	const providerOptions = $derived(providers.filter((provider) => provider.status !== 'disabled'));
	const selectedProvider = $derived(providerOptions.find((provider) => provider.id === selectedProviderId));
	const localProvider = $derived(providers.find((provider) => provider.providerType === 'local'));
	// driver_allocated_memory (total Metal/CUDA working set) is the truest
	// "in use" figure; fall back to the live-tensor number if it's missing.
	const localUsedMb = $derived(localHealth?.driverMb ?? localHealth?.allocatedMb ?? 0);
	const localMemPct = $derived(
		localUsedMb && localHealth?.recommendedMaxMb
			? Math.min(100, Math.round((localUsedMb / localHealth.recommendedMaxMb) * 100))
			: 0
	);
	const localGb = (mb?: number) => (mb ? (mb / 1024).toFixed(1) : '0.0');
	const gpuOptions = $derived(gpuOptionsForProvider(selectedProvider));
	const selectedPrimeOffer = $derived(primeOffers.find((offer) => offer.id === selectedPrimeOfferId) ?? null);
	const launchModels = $derived(
		models.filter((model) => model.stage === 'draft' || model.stage === 'training' || model.stage === 'failed' || model.stage === 'success')
	);

	onMount(() => {
		if ($authState.user) void load();
		const interval = window.setInterval(() => {
			now = new Date();
			if ($authState.user) void refreshTrainingModels();
		}, AUTO_REFRESH_MS);

		void refreshLocalHealth();
		const healthInterval = window.setInterval(() => void refreshLocalHealth(), LOCAL_HEALTH_MS);

		return () => {
			window.clearInterval(interval);
			window.clearInterval(healthInterval);
		};
	});

	async function refreshLocalHealth() {
		localHealth = await fetchLocalDaemonHealth(localProvider ?? null);
	}

	async function updateMaxParallel(value: number) {
		if (!localHealth) return;
		localHealth = { ...localHealth, maxParallel: value }; // optimistic
		const applied = await setLocalDaemonMaxParallel(value, localProvider ?? null);
		if (applied != null && applied !== value) {
			localHealth = { ...localHealth, maxParallel: applied };
		}
		void refreshLocalHealth();
	}

	$effect(() => {
		if ($authState.user && loading) void load();
	});

	$effect(() => {
		const selected = selectedGpuForProvider(selectedProvider, selectedGpuType);
		if ((selected?.value ?? '') !== selectedGpuType) selectedGpuType = selected?.value ?? '';
	});

	$effect(() => {
		const provider = selectedProvider;
		const gpuType = selectedGpuType;
		if (provider?.providerType !== 'prime_intellect' || !gpuType) {
			primeOffers = [];
			selectedPrimeOfferId = '';
			primeOffersError = null;
			return;
		}
		void loadPrimeOffers(provider, gpuType);
	});

	async function loadPrimeOffers(provider: ComputeProvider, gpuType: string) {
		const request = ++primeOffersRequest;
		primeOffersLoading = true;
		primeOffersError = null;
		try {
			const offers = await fetchPrimeOffers(provider, gpuType);
			if (request !== primeOffersRequest) return;
			primeOffers = offers;
			selectedPrimeOfferId = offers.some((offer) => offer.id === selectedPrimeOfferId)
				? selectedPrimeOfferId
				: offers[0]?.id ?? '';
			if (!offers.length) primeOffersError = `No live ${gpuType} offers are available.`;
		} catch (error) {
			if (request !== primeOffersRequest) return;
			primeOffers = [];
			selectedPrimeOfferId = '';
			primeOffersError = error instanceof Error ? error.message : 'Prime availability could not be loaded.';
		} finally {
			if (request === primeOffersRequest) primeOffersLoading = false;
		}
	}

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
		if (selectedProvider.providerType === 'prime_intellect' && !selectedPrimeOffer) {
			addToast(primeOffersError ?? 'Select an available Prime Intellect offer first.', 'error');
			return;
		}
		if (isPending(model.id)) return;
		setPending(model.id, true);
		try {
			const result = await launchModelDraft({
				model,
				provider: selectedProvider,
				maxSpendUsd: null,
				gpuType: selectedGpuType || null,
				primeOffer: selectedPrimeOffer
			});
			upsertModel(result.model);
			upsertJob(result.job);
			const toast = launchTrainingToast(result);
			addToast(toast.message, toast.type);
			if (!result.action.ok) {
				return;
			}
		} catch (error) {
			console.error(error);
			await markFailed(model);
			addToast(error instanceof Error ? error.message : 'Model could not launch.', 'error');
		} finally {
			setPending(model.id, false);
		}
	}

	async function refresh(model: ModelRegistryItem) {
		const job = jobForModel(model);
		const provider = providers.find((item) => item.id === job?.providerId);
		if (!job || !provider) {
			addToast('Training refresh needs a compute job and provider.', 'error');
			return;
		}
		if (isPending(model.id)) return;
		setPending(model.id, true);
		try {
			const result = await refreshTrainingModel(model, job, provider);
			addToast(`${result.model.name} is ${modelStageLabels[result.model.stage as ModelStage].toLowerCase()}.`, 'success');
		} catch (error) {
			console.error(error);
			await markFailed(model);
			addToast(error instanceof Error ? error.message : 'Training status could not refresh.', 'error');
		} finally {
			setPending(model.id, false);
		}
	}

	async function refreshTrainingModels() {
		if (loading || autoRefreshing) return;
		const candidates = models
			.filter((model) => model.stage === 'training')
			.map((model) => {
				const job = jobForModel(model);
				const provider = providers.find((item) => item.id === job?.providerId);
				return job && provider ? { model, job, provider } : null;
			})
			.filter((item): item is { model: ModelRegistryItem; job: ComputeJob; provider: ComputeProvider } => item !== null);
		if (!candidates.length) return;

		autoRefreshing = true;
		try {
			await Promise.allSettled(
				candidates.map(async ({ model, job, provider }) => {
					const previousStage = model.stage;
					const result = await refreshTrainingModel(model, job, provider);
					if (previousStage === 'training' && result.model.stage !== 'training') {
						addToast(
							`${result.model.name} is ${modelStageLabels[result.model.stage as ModelStage].toLowerCase()}.`,
							result.model.stage === 'success' ? 'success' : 'error'
						);
					}
				})
			);
		} finally {
			autoRefreshing = false;
		}
	}

	async function refreshTrainingModel(model: ModelRegistryItem, job: ComputeJob, provider: ComputeProvider) {
		const result = await refreshModelTraining({ model, job, provider });
		upsertModel(result.model);
		upsertJob(result.job);
		now = new Date();
		return result;
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

	function jobDetail(model: ModelRegistryItem): string | null {
		return jobForModel(model)?.logTail ?? lastTrainingError(model);
	}

	function lastTrainingError(model: ModelRegistryItem): string | null {
		const lineage = jsonRecord(model.lineageJson);
		const action = jsonRecord(lineage.lastTrainingAction);
		const error = action.error;
		return typeof error === 'string' && error.trim() ? error.trim() : null;
	}

	function jsonRecord(value: unknown): Record<string, unknown> {
		if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
		if (typeof value !== 'string') return {};
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}

	function stageName(stage: string | null | undefined): string {
		return modelStageLabels[(stage ?? 'draft') as ModelStage] ?? 'Draft';
	}

	function canLaunch(model: ModelRegistryItem): boolean {
		return !!selectedProvider &&
			(selectedProvider.providerType !== 'prime_intellect' || !!selectedPrimeOffer) &&
			(model.stage === 'draft' || model.stage === 'failed');
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
				<p class="live-status">
					Live logs refresh every 10s{autoRefreshing ? ' · refreshing' : ''}
				</p>
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
					<span>GPU</span>
					<select bind:value={selectedGpuType} disabled={!gpuOptions.length}>
						{#each gpuOptions as gpu (gpu.value)}
							<option value={gpu.value}>{gpu.label}</option>
						{/each}
					</select>
				</label>
				{#if selectedProvider?.providerType === 'prime_intellect'}
					<label>
						<span>Live offer</span>
						<select bind:value={selectedPrimeOfferId} disabled={primeOffersLoading || !primeOffers.length}>
							{#if primeOffersLoading}
								<option value="">Loading availability…</option>
							{:else}
								{#each primeOffers as offer (offer.id)}
									<option value={offer.id}>
										${offer.priceHr.toFixed(2)}/hr · {offer.providerType} · {offer.country ?? offer.region ?? 'region n/a'}
									</option>
								{/each}
							{/if}
						</select>
						{#if primeOffersError}<small class="offer-error">{primeOffersError}</small>{/if}
					</label>
				{/if}
			</div>
		</header>

		{#if localHealth}
			<div class="gpu-strip">
				<div class="gpu-head">
					<span class="gpu-dot" class:busy={(localHealth.running ?? 0) > 0}></span>
					<span class="gpu-eyebrow">Local compute</span>
				</div>
				<div class="gpu-tiles">
					<div class="gpu-tile">
						<span class="tile-label">Device</span>
						<strong>{(localHealth.device ?? '—').toUpperCase()}</strong>
						{#if localHealth.chip}<small>{localHealth.chip}</small>{/if}
					</div>
					{#if localHealth.recommendedMaxMb}
						<div class="gpu-tile wide">
							<span class="tile-label">GPU memory</span>
							<strong>{localGb(localUsedMb)} / {localGb(localHealth.recommendedMaxMb)} GB</strong>
							<div class="meter" aria-hidden="true"><span style={`width:${localMemPct}%`}></span></div>
						</div>
					{/if}
					<div class="gpu-tile">
						<span class="tile-label">Jobs</span>
						<strong>{localHealth.running ?? 0} running</strong>
						<small>{localHealth.queued ?? 0} queued</small>
					</div>
					<div class="gpu-tile">
						<span class="tile-label">Parallel jobs</span>
						<select
							class="parallel-select"
							value={localHealth.maxParallel ?? 1}
							onchange={(e) => updateMaxParallel(Number(e.currentTarget.value))}
							title="How many training jobs may run at once on this machine"
						>
							{#each Array.from({ length: localHealth.cap ?? 4 }, (_, i) => i + 1) as n (n)}
								<option value={n}>{n}</option>
							{/each}
						</select>
					</div>
					{#if localHealth.torch}
						<div class="gpu-tile">
							<span class="tile-label">Torch</span>
							<strong>{localHealth.torch}</strong>
						</div>
					{/if}
				</div>
			</div>
		{/if}

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
							{@const job = jobForModel(model)}
							{@const detail = jobDetail(model)}
							{@const progress = trainingProgressForJob(job, now)}
							<tr>
								<td>
									<strong>{model.name}</strong>
									<span>{model.changeSummary ?? 'draft'}</span>
								</td>
								<td><span class="stage-chip" data-stage={model.stage}>{stageName(model.stage)}</span></td>
								<td>{providerName(model)}</td>
								<td class="job-status mono">
									<div class="job-line">
										<span>{job?.status ?? 'not started'}</span>
										<strong>{progress.percent}%</strong>
									</div>
									<div class="progress-track" aria-label={`Training progress for ${model.name}`}>
										<span style={`width: ${progress.percent}%`}></span>
									</div>
									<small>{progress.label} · {progress.etaLabel}</small>
									{#if progress.logLines.length}
										<ol class="live-log" aria-label={`Live training logs for ${model.name}`}>
											{#each progress.logLines as line}
												<li>
													{#if line.level || line.timestamp}
														<span class="log-meta">{line.level ?? 'LOG'}{line.timestamp ? ` ${line.timestamp}` : ''}</span>
													{/if}
													<span>{line.message}</span>
												</li>
											{/each}
										</ol>
									{:else if detail}
										<small>{detail}</small>
									{/if}
								</td>
								<td class="actions">
									{#if model.stage === 'training'}
										<button type="button" onclick={() => refresh(model)} disabled={isPending(model.id)}>
											{isPending(model.id) ? 'Refreshing…' : 'Refresh'}
										</button>
									{:else if canLaunch(model)}
										<button type="button" class="primary" onclick={() => launch(model)} disabled={isPending(model.id)}>
											{isPending(model.id) ? 'Launching…' : 'Launch'}
										</button>
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

	.live-status {
		margin-top: 0.55rem;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 700;
	}

	/* Local GPU strip — only shown when the local daemon is reachable. */
	.gpu-strip {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1rem 1.5rem;
		border: 1.5px solid var(--text);
		border-radius: 6px;
		background: var(--bg-card);
		box-shadow: 3px 3px 0 var(--text);
		padding: 0.75rem 1rem;
	}

	.gpu-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.gpu-dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--text-muted);
	}

	.gpu-dot.busy {
		background: var(--green);
		box-shadow: 0 0 0 3px rgba(26, 127, 55, 0.18);
	}

	.gpu-eyebrow {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.gpu-tiles {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem 1.75rem;
		flex: 1;
	}

	.gpu-tile {
		display: grid;
		gap: 0.15rem;
		align-content: start;
		min-width: 0;
	}

	.gpu-tile.wide {
		min-width: 170px;
	}

	.tile-label {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.6rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.gpu-tile strong {
		font-size: 0.92rem;
		font-weight: 720;
		font-variant-numeric: tabular-nums;
	}

	.gpu-tile small {
		color: var(--text-secondary);
		font-size: 0.72rem;
	}

	.parallel-select {
		margin-top: 0.1rem;
		width: auto;
		min-width: 3.4rem;
		border: 1.5px solid var(--text);
		border-radius: 4px;
		background: var(--bg-card);
		color: var(--text);
		font: inherit;
		font-weight: 720;
		font-variant-numeric: tabular-nums;
		padding: 0.15rem 0.4rem;
		cursor: pointer;
	}

	.meter {
		margin-top: 0.2rem;
		height: 6px;
		border: 1px solid var(--text);
		border-radius: 999px;
		background: var(--bg-input);
		overflow: hidden;
	}

	.meter span {
		display: block;
		height: 100%;
		background: var(--text);
		transition: width 0.3s ease;
	}

	.launch-controls {
		display: grid;
		grid-template-columns: minmax(190px, 1fr) 140px minmax(260px, 1.4fr);
		gap: 0.75rem;
		align-items: end;
		min-width: min(100%, 720px);
	}

	.offer-error {
		max-width: 320px;
		color: var(--red);
		font-size: 0.72rem;
		line-height: 1.3;
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
	button {
		font: inherit;
	}

	select {
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

	.job-status {
		min-width: 320px;
		max-width: 420px;
	}

	.job-status small {
		display: block;
		margin-top: 0.25rem;
		color: var(--text-muted);
		font-family: inherit;
		font-size: 0.72rem;
		line-height: 1.25;
		white-space: normal;
	}

	.job-line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.job-line strong {
		font-size: 0.78rem;
	}

	.progress-track {
		width: 100%;
		height: 0.5rem;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-input);
		margin-top: 0.4rem;
	}

	.progress-track span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--green);
		transition: width 260ms ease;
	}

	.live-log {
		display: grid;
		gap: 0.2rem;
		margin: 0.45rem 0 0;
		padding: 0.5rem;
		max-height: 8.8rem;
		overflow: auto;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-page);
		color: var(--text-secondary);
		font-size: 0.68rem;
		line-height: 1.35;
		list-style: none;
		white-space: normal;
	}

	.live-log li {
		display: grid;
		gap: 0.1rem;
	}

	.live-log span {
		display: block;
		overflow-wrap: anywhere;
	}

	.live-log .log-meta {
		color: var(--text-muted);
		font-size: 0.62rem;
		font-weight: 800;
		text-transform: uppercase;
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
