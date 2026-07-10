<script lang="ts">
	import { onMount } from 'svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import ModelSubmitView from '$lib/components/ModelSubmitView.svelte';
	import { authState } from '$lib/auth';
	import { addToast } from '$lib/stores';
	import { listRegistryModels, type ModelRegistryItem } from '$lib/services/registry-service';
	import {
		findPerformance,
		formatPercentile,
		formatScore,
		loadSubmissionsBundle,
		meanMetric,
		metricSeries,
		TRACKED_METRICS,
		type ModelPerformance,
		type TrackedMetric
	} from '$lib/services/numerai-submissions-service';

	let loading = $state(true);
	let refreshing = $state(false);
	let models = $state<ModelRegistryItem[]>([]);
	let performances = $state<ModelPerformance[]>([]);
	let checkedAt = $state<string | null>(null);
	let bundleError = $state<string | null>(null);
	let selectedModelId = $state<string>('');
	let selectedMetric = $state<TrackedMetric>('canon_corr');
	let showSubmit = $state(false);

	const modelUploadLifecycle = [
		{
			status: 'Pending',
			body: 'Numerai is provisioning the run environment for the uploaded model.'
		},
		{
			status: 'Running',
			body: 'The model is executing against the current live data.'
		},
		{
			status: 'Validating',
			body: 'Predictions were generated and are being checked before acceptance.'
		},
		{
			status: 'Success',
			body: 'The live submission was accepted and can be reviewed with diagnostics.'
		}
	] as const;

	const modelUploadFailures = [
		{
			status: 'Failed',
			body: 'Usually points to model code, dependency, memory, timeout, or invalid submission issues.'
		},
		{
			status: 'Error',
			body: 'Numerai hit an unexpected platform-side problem while running the model.'
		}
	] as const;

	onMount(() => {
		if ($authState.user) void load();
	});

	$effect(() => {
		if ($authState.user && loading) void load();
	});

	async function load() {
		loading = true;
		try {
			const [modelRows, bundle] = await Promise.all([
				listRegistryModels(),
				loadSubmissionsBundle({ maxRounds: 30 })
			]);
			models = modelRows;
			performances = [...bundle.performances];
			checkedAt = bundle.checkedAt;
			bundleError = bundle.error;
			if (!selectedModelId) {
				const first = modelRows.find((m) => m.numeraiModelId);
				selectedModelId = first?.id ?? '';
			}
		} catch (e) {
			addToast(e instanceof Error ? e.message : 'Failed to load submissions', 'error');
		} finally {
			loading = false;
		}
	}

	async function refresh() {
		refreshing = true;
		try {
			const bundle = await loadSubmissionsBundle({ maxRounds: 30 });
			performances = [...bundle.performances];
			checkedAt = bundle.checkedAt;
			bundleError = bundle.error;
			if (!bundle.error) addToast('Numerai data refreshed', 'success');
		} catch (e) {
			addToast(e instanceof Error ? e.message : 'Refresh failed', 'error');
		} finally {
			refreshing = false;
		}
	}

	const selectedModel = $derived(models.find((m) => m.id === selectedModelId) ?? null);
	const selectedPerformance = $derived(
		findPerformance(performances, selectedModel?.numeraiModelId)
	);
	const series = $derived(metricSeries(selectedPerformance, selectedMetric));
	const meanValue = $derived(meanMetric(series));

	function rowFor(model: ModelRegistryItem): ModelPerformance | null {
		return findPerformance(performances, model.numeraiModelId);
	}

	function lastSeen(model: ModelRegistryItem): string {
		const perf = rowFor(model);
		if (!perf) return '—';
		if (perf.error) return `Error: ${perf.error}`;
		if (perf.latestRound === null) return 'No rounds';
		return `Round ${perf.latestRound}`;
	}

	function sparkPath(series: readonly { round: number; value: number }[], width: number, height: number): string {
		if (series.length < 2) return '';
		const values = series.map((p) => p.value);
		const min = Math.min(...values);
		const max = Math.max(...values);
		const range = max - min || 1;
		const stepX = width / (series.length - 1);
		return series
			.map((p, i) => {
				const x = i * stepX;
				const y = height - ((p.value - min) / range) * height;
				return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	}

	const trackedMetricLabels: Record<TrackedMetric, string> = {
		canon_corr: 'Canon CORR',
		canon_mmc: 'Canon MMC',
		corr60: 'CORR 60',
		mmc60: 'MMC 60',
		fnc_v3: 'FNC v3'
	};

	function formatCheckedAt(value: string | null): string {
		if (!value) return 'never';
		try {
			return new Date(value).toLocaleString();
		} catch {
			return value;
		}
	}
</script>

<svelte:head>
	<title>Submissions · Numerai Dashboard</title>
</svelte:head>

<AuthGate>
	<section class="page">
		<header class="page-head">
			<div>
				<h1>Submissions</h1>
				<p class="subtitle">Live data straight from Numerai for every model you've registered.</p>
			</div>
			<div class="head-actions">
				<span class="freshness">Last refresh: {formatCheckedAt(checkedAt)}</span>
				<button class="btn btn-outline" onclick={refresh} disabled={refreshing || loading}>
					{refreshing ? 'Refreshing…' : 'Refresh'}
				</button>
				<button class="btn btn-primary" onclick={() => (showSubmit = !showSubmit)} disabled={!models.length}>
					{showSubmit ? 'Hide submit panel' : 'Submit to Numerai'}
				</button>
			</div>
		</header>

		{#if loading}
			<p class="muted">Loading models…</p>
		{:else if bundleError}
			<div class="alert">{bundleError}</div>
		{/if}

		<section class="lifecycle" aria-labelledby="lifecycle-title">
			<div>
				<h2 id="lifecycle-title">Model upload lifecycle</h2>
				<p>
					After a model is uploaded, Numerai runs it daily and moves it through execution,
					validation, and acceptance states before diagnostics are useful.
				</p>
			</div>
			<ol class="lifecycle-steps">
				{#each modelUploadLifecycle as item}
					<li>
						<strong>{item.status}</strong>
						<span>{item.body}</span>
					</li>
				{/each}
			</ol>
			<div class="failure-legend" aria-label="Failure states">
				{#each modelUploadFailures as item}
					<div>
						<strong>{item.status}</strong>
						<span>{item.body}</span>
					</div>
				{/each}
			</div>
		</section>

		{#if !loading && models.length === 0}
			<p class="muted">No models yet. Create one in <a href="/models">Models</a>.</p>
		{:else if !loading}
			<div class="layout">
				<aside class="model-list">
					<h2 class="section-title">Models</h2>
					<ul>
						{#each models as model (model.id)}
							{@const perf = rowFor(model)}
							{@const canon = perf?.latestScores.canon_corr}
							<li>
								<button
									type="button"
									class="model-row"
									class:selected={selectedModelId === model.id}
									onclick={() => (selectedModelId = model.id)}
								>
									<div class="model-name">
										<strong>{model.name}</strong>
										<span class="mono small">{model.numeraiModelId ?? 'no slot id'}</span>
									</div>
									<div class="model-meta">
										<span class="metric-pill">{lastSeen(model)}</span>
										<span class="metric-val">{formatScore(canon?.value ?? null)}</span>
									</div>
								</button>
							</li>
						{/each}
					</ul>
				</aside>

				<div class="detail">
					{#if !selectedModel}
						<p class="muted">Select a model to see its rounds.</p>
					{:else if !selectedModel.numeraiModelId}
						<p class="muted">
							This model has no Numerai slot id linked yet. Add <code>numeraiModelId</code> in
							<a href="/models">Models</a> to fetch live data.
						</p>
					{:else if selectedPerformance?.error}
						<div class="alert">Numerai error: {selectedPerformance.error}</div>
					{:else if !selectedPerformance}
						<p class="muted">No data fetched for this model yet.</p>
					{:else}
						<header class="detail-head">
							<div>
								<h2>{selectedModel.name}</h2>
								<p class="mono small">slot id: {selectedModel.numeraiModelId}</p>
							</div>
							<div class="metric-grid">
								{#each TRACKED_METRICS as metric (metric)}
									{@const sample = selectedPerformance.latestScores[metric]}
									<div class="metric-card">
										<span class="metric-label">{trackedMetricLabels[metric]}</span>
										<span class="metric-value">{formatScore(sample?.value ?? null)}</span>
										<span class="metric-pctile">{formatPercentile(sample?.percentile ?? null)}</span>
									</div>
								{/each}
							</div>
						</header>

						<section class="analytics">
							<div class="analytics-head">
								<h3>Performance over rounds</h3>
								<div class="metric-tabs">
									{#each TRACKED_METRICS as metric (metric)}
										<button
											type="button"
											class:active={selectedMetric === metric}
											onclick={() => (selectedMetric = metric)}
										>
											{trackedMetricLabels[metric]}
										</button>
									{/each}
								</div>
							</div>
							{#if series.length < 2}
								<p class="muted">Not enough samples to chart yet (need at least 2 rounds).</p>
							{:else}
								<div class="spark">
									<svg viewBox="0 0 600 120" preserveAspectRatio="none">
										<path d={sparkPath(series, 600, 120)} fill="none" stroke="currentColor" stroke-width="2" />
									</svg>
									<div class="spark-meta">
										<span>Mean: <strong>{formatScore(meanValue)}</strong></span>
										<span>{series.length} rounds · {series[0].round}–{series[series.length - 1].round}</span>
									</div>
								</div>
							{/if}
						</section>

						<section class="rounds">
							<h3>Round history</h3>
							<table>
								<thead>
									<tr>
										<th>Round</th>
										<th>Resolved</th>
										{#each TRACKED_METRICS as metric (metric)}
											<th>{trackedMetricLabels[metric]}</th>
										{/each}
									</tr>
								</thead>
								<tbody>
									{#each selectedPerformance.rounds as round (round.roundNumber)}
										<tr>
											<td>{round.roundNumber}</td>
											<td>{round.roundResolved ? 'yes' : 'open'}</td>
											{#each TRACKED_METRICS as metric (metric)}
												{@const sample = round.submissionScores
													.filter((s) => s.displayName === metric)
													.sort((a, b) => b.day - a.day)[0]}
												<td class="mono">{formatScore(sample?.value ?? null)}</td>
											{/each}
										</tr>
									{/each}
								</tbody>
							</table>
						</section>
					{/if}
				</div>
			</div>
		{/if}

		{#if showSubmit}
			<section class="submit-section">
				<h2 class="section-title">Push to Numerai</h2>
				<ModelSubmitView />
			</section>
		{/if}
	</section>
</AuthGate>

<style>
	.page {
		max-width: 1280px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.page-head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.page-head h1 {
		margin: 0;
		font-size: 1.5rem;
		letter-spacing: -0.01em;
	}
	.subtitle {
		margin: 0.2rem 0 0;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}
	.head-actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.freshness {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.btn {
		border-radius: 6px;
		padding: 0.4rem 0.85rem;
		font-size: 0.82rem;
		font-weight: 700;
		cursor: pointer;
		border: 1px solid var(--border);
		background: var(--bg-card);
		color: var(--text);
		transition: background 0.15s;
	}
	.btn:hover:not(:disabled) {
		background: var(--hover-bg);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn-primary {
		background: var(--text);
		color: white;
		border-color: var(--text);
	}
	.btn-primary:hover:not(:disabled) {
		background: #303030;
	}
	.btn-outline {
		background: transparent;
	}

	.alert {
		background: var(--badge-red);
		border: 1px solid rgba(207, 34, 46, 0.3);
		color: var(--red);
		padding: 0.6rem 0.85rem;
		border-radius: 6px;
		font-size: 0.85rem;
	}
	.muted {
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.lifecycle {
		display: grid;
		grid-template-columns: minmax(220px, 0.85fr) minmax(420px, 1.5fr);
		gap: 1rem;
		align-items: start;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1rem;
	}
	.lifecycle h2 {
		margin: 0;
		font-size: 0.95rem;
	}
	.lifecycle p {
		margin: 0.35rem 0 0;
		color: var(--text-secondary);
		font-size: 0.82rem;
		line-height: 1.45;
	}
	.lifecycle-steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.lifecycle-steps li,
	.failure-legend div {
		min-height: 92px;
		border: 1px solid var(--border-light);
		background: var(--bg-input);
		border-radius: 6px;
		padding: 0.65rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.lifecycle-steps strong,
	.failure-legend strong {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.lifecycle-steps span,
	.failure-legend span {
		color: var(--text-secondary);
		font-size: 0.76rem;
		line-height: 1.35;
	}
	.failure-legend {
		grid-column: 2;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.failure-legend div {
		min-height: auto;
		background: var(--badge-red);
		border-color: rgba(207, 34, 46, 0.25);
	}
	@media (max-width: 1000px) {
		.lifecycle {
			grid-template-columns: 1fr;
		}
		.lifecycle-steps {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.failure-legend {
			grid-column: auto;
		}
	}
	@media (max-width: 620px) {
		.lifecycle-steps,
		.failure-legend {
			grid-template-columns: 1fr;
		}
	}

	.layout {
		display: grid;
		grid-template-columns: 280px 1fr;
		gap: 1.5rem;
		align-items: flex-start;
	}
	@media (max-width: 900px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}

	.section-title {
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
		font-weight: 720;
		margin: 0 0 0.6rem;
	}

	.model-list ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.model-row {
		width: 100%;
		text-align: left;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.7rem 0.85rem;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		transition: border-color 0.15s, background 0.15s;
	}
	.model-row:hover {
		background: var(--hover-bg);
	}
	.model-row.selected {
		border-color: var(--text);
		box-shadow: var(--shadow-sm);
	}

	.model-name {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.model-name strong {
		font-size: 0.92rem;
	}
	.model-meta {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
	}
	.metric-pill {
		font-size: 0.7rem;
		background: var(--badge-blue);
		padding: 0.15rem 0.45rem;
		border-radius: 4px;
		color: var(--text-secondary);
	}
	.metric-val {
		font-family: var(--font-mono);
		font-size: 0.9rem;
		font-weight: 600;
	}

	.detail {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.detail-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.detail-head h2 {
		margin: 0;
		font-size: 1.15rem;
	}
	.mono {
		font-family: var(--font-mono);
	}
	.small {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.metric-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
		gap: 0.5rem;
		min-width: 320px;
	}
	.metric-card {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.55rem 0.7rem;
		background: var(--bg-input);
		border: 1px solid var(--border-light);
		border-radius: 6px;
	}
	.metric-label {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
		font-weight: 700;
	}
	.metric-value {
		font-family: var(--font-mono);
		font-size: 0.95rem;
		font-weight: 600;
	}
	.metric-pctile {
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	.analytics-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.analytics-head h3 {
		margin: 0;
		font-size: 0.95rem;
	}
	.metric-tabs {
		display: flex;
		gap: 0.25rem;
		flex-wrap: wrap;
	}
	.metric-tabs button {
		background: var(--bg-input);
		border: 1px solid var(--border-light);
		padding: 0.25rem 0.55rem;
		font-size: 0.72rem;
		border-radius: 4px;
		cursor: pointer;
		color: var(--text-secondary);
	}
	.metric-tabs button.active {
		background: var(--text);
		color: white;
		border-color: var(--text);
	}

	.spark {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.spark svg {
		width: 100%;
		height: 120px;
		color: var(--text);
		background: var(--bg-input);
		border-radius: 6px;
		padding: 0.5rem;
		box-sizing: border-box;
	}
	.spark-meta {
		display: flex;
		justify-content: space-between;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.rounds table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.82rem;
	}
	.rounds th,
	.rounds td {
		text-align: left;
		padding: 0.45rem 0.55rem;
		border-bottom: 1px solid var(--border-light);
	}
	.rounds th {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}
	.rounds tbody tr:hover {
		background: var(--hover-bg);
	}

	.submit-section {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 1.25rem;
	}
</style>
