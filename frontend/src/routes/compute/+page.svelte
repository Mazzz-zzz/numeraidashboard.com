<script lang="ts">
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { computeProviders } from '$lib/product-data';

	type ProviderId = (typeof computeProviders)[number]['id'];

	let selectedProviderId = $state<ProviderId>('prime');
	let monthlyBudget = $state(250);
	let runCap = $state(18);

	const selectedProvider = $derived(
		computeProviders.find((provider) => provider.id === selectedProviderId) ?? computeProviders[0]
	);
	const queuedJobs = [
		{ name: 'baseline smoke test', provider: 'Modal', spend: '$3.80', status: 'ready' },
		{ name: 'candidate sweep x8', provider: 'Prime Intellect', spend: '$42.00', status: 'planned' },
		{ name: 'production validation', provider: 'SageMaker', spend: '$15.40', status: 'running' },
		{ name: 'local compare pass', provider: 'Local GPU', spend: '$0.00', status: 'waiting' }
	] as const;
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
				see what is queued before a run hits the backend.
			</p>
		</div>
		<div class="budget-card">
			<span>Monthly cap</span>
			<strong>${monthlyBudget}</strong>
			<input type="range" min="50" max="1000" step="25" bind:value={monthlyBudget} />
		</div>
	</header>

	<div class="compute-grid">
		<section class="provider-grid" aria-label="Compute providers">
			{#each computeProviders as provider}
				<button
					type="button"
					class:active={selectedProviderId === provider.id}
					onclick={() => (selectedProviderId = provider.id)}
				>
					<span>{provider.status}</span>
					<strong>{provider.name}</strong>
					<small>{provider.type}</small>
					<p>{provider.body}</p>
				</button>
			{/each}
		</section>

		<aside class="detail-panel">
			<section class="panel">
				<p class="eyebrow">Selected provider</p>
				<h2>{selectedProvider.name}</h2>
				<p>{selectedProvider.body}</p>
				<div class="facts">
					<div><span>Cost</span><strong>{selectedProvider.cost}</strong></div>
					<div><span>Speed</span><strong>{selectedProvider.speed}</strong></div>
					<div><span>Status</span><strong>{selectedProvider.status}</strong></div>
				</div>
			</section>

			<section class="panel">
				<h2>Run limits</h2>
				<label>
					<span>Max runs per sweep</span>
					<input type="range" min="1" max="32" bind:value={runCap} />
					<strong>{runCap} runs</strong>
				</label>
				<label>
					<span>Default spend cap</span>
					<input type="range" min="5" max="250" step="5" bind:value={monthlyBudget} />
					<strong>${monthlyBudget}</strong>
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
				<span>Spend</span>
				<span>Status</span>
			</div>
			{#each queuedJobs as job}
				<div class="row">
					<span>{job.name}</span>
					<span>{job.provider}</span>
					<span>{job.spend}</span>
					<span>{job.status}</span>
				</div>
			{/each}
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

	.provider-grid button {
		display: grid;
		gap: 0.5rem;
		min-height: 220px;
		padding: 1rem;
		color: var(--text);
		cursor: pointer;
		text-align: left;
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
		grid-template-columns: 1.25fr 1fr 0.7fr 0.8fr;
		gap: 1rem;
		padding: 0.85rem 1rem;
		border-bottom: 1px solid var(--border-light);
	}

	.row:last-child {
		border-bottom: none;
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
