<script lang="ts">
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { lineageBranches, liveModels } from '$lib/product-data';

	type ModelStage = 'draft' | 'testing' | 'live' | 'retired';
	type ModelCard = {
		id: string;
		name: string;
		stage: ModelStage;
		corr: string;
		mmc: string;
		payout: string;
		parent: string;
		status: string;
	};

	const initialModels = liveModels.map((model) => ({ ...model })) as ModelCard[];
	let models = $state<ModelCard[]>(initialModels);
	let selectedModelId = $state(initialModels[0]?.id ?? '');
	let compareMode = $state(false);

	const selectedModel = $derived(models.find((model) => model.id === selectedModelId) ?? models[0]);
	const liveModelCount = $derived(models.filter((model) => model.stage === 'live').length);
	const testingModelCount = $derived(models.filter((model) => model.stage === 'testing').length);

	function setStage(modelId: string, stage: ModelStage) {
		models = models.map((model) => (model.id === modelId ? { ...model, stage } : model));
	}

	function duplicateModel(modelId: string) {
		const source = models.find((model) => model.id === modelId);
		if (!source) return;
		const id = `${source.id}-copy-${models.length + 1}`;
		models = [
			{
				...source,
				id,
				name: `${source.name} branch`,
				stage: 'draft',
				payout: 'not submitted',
				status: 'branched for testing'
			},
			...models
		];
		selectedModelId = id;
	}
</script>

<svelte:head>
	<title>Models | Numerai Dashboard</title>
</svelte:head>

<AuthGate>
<section class="models-page">
	<header class="page-head">
		<div>
			<p class="eyebrow">Models</p>
			<h1>Registry, live performance, and lineage in one place.</h1>
			<p>
				Use this page to decide which artifact submits, which candidate deserves a branch, and
				which model should be retired.
			</p>
		</div>
		<div class="summary">
			<div>
				<span>Live</span>
				<strong>{liveModelCount}</strong>
			</div>
			<div>
				<span>Testing</span>
				<strong>{testingModelCount}</strong>
			</div>
			<div>
				<span>Round</span>
				<strong>1237</strong>
			</div>
		</div>
	</header>

	<div class="models-grid">
		<section class="model-list" aria-label="Model registry">
			{#each models as model}
				<article class:active={selectedModelId === model.id}>
					<button type="button" class="select-card" onclick={() => (selectedModelId = model.id)}>
						<span class="stage">{model.stage}</span>
						<strong>{model.name}</strong>
						<small>{model.status}</small>
					</button>
					<div class="metrics">
						<div><span>CORR</span><strong>{model.corr}</strong></div>
						<div><span>MMC</span><strong>{model.mmc}</strong></div>
						<div><span>Payout</span><strong>{model.payout}</strong></div>
					</div>
					<div class="actions">
						<button type="button" onclick={() => duplicateModel(model.id)}>Branch</button>
						<button type="button" onclick={() => (compareMode = true)}>Compare</button>
						{#if model.stage !== 'live'}
							<button type="button" class="dark" onclick={() => setStage(model.id, 'live')}>Promote</button>
						{:else}
							<button type="button" onclick={() => setStage(model.id, 'retired')}>Retire</button>
						{/if}
					</div>
				</article>
			{/each}
		</section>

		<aside class="detail-panel">
			{#if selectedModel}
				<section class="panel">
					<p class="eyebrow">Selected model</p>
					<h2>{selectedModel.name}</h2>
					<p class="muted">
						Parent: {selectedModel.parent}. This model can be branched back into Builder,
						compared against its parent, or promoted to the live submission slot.
					</p>
					<div class="score-strip">
						<div><span>CORR</span><strong>{selectedModel.corr}</strong></div>
						<div><span>MMC</span><strong>{selectedModel.mmc}</strong></div>
						<div><span>Stage</span><strong>{selectedModel.stage}</strong></div>
					</div>
				</section>
			{/if}

			<section class="panel">
				<div class="panel-head">
					<h2>Lineage</h2>
					<a href="/builder">Open in Builder</a>
				</div>
				<div class="lineage">
					{#each lineageBranches as branch}
						<div>
							<strong>{branch.name}</strong>
							<span>{branch.delta}</span>
							<small>{branch.score}</small>
						</div>
					{/each}
				</div>
			</section>

			{#if compareMode}
				<section class="panel compare">
					<div class="panel-head">
						<h2>Parent comparison</h2>
						<button type="button" onclick={() => (compareMode = false)}>Close</button>
					</div>
					<table>
						<thead>
							<tr><th>Metric</th><th>Parent</th><th>Selected</th></tr>
						</thead>
						<tbody>
							<tr><td>CORR</td><td>+0.0091</td><td>{selectedModel?.corr}</td></tr>
							<tr><td>MMC</td><td>+0.0033</td><td>{selectedModel?.mmc}</td></tr>
							<tr><td>Exposure</td><td>0.18</td><td>0.12</td></tr>
							<tr><td>Decision</td><td colspan="2">Selected model is ready for a larger sweep.</td></tr>
						</tbody>
					</table>
				</section>
			{/if}
		</aside>
	</div>
</section>
</AuthGate>

<style>
	.models-page {
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
	.summary span,
	.metrics span,
	.score-strip span,
	.stage {
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

	.summary {
		display: grid;
		grid-template-columns: repeat(3, minmax(6rem, 1fr));
		border: 1px solid var(--border);
		border-radius: 8px;
		background: #fff;
		overflow: hidden;
	}

	.summary div {
		padding: 1rem;
		border-right: 1px solid var(--border-light);
	}

	.summary div:last-child {
		border-right: none;
	}

	.summary strong {
		display: block;
		margin-top: 0.3rem;
		font-size: 1.5rem;
	}

	.models-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
		gap: 1rem;
		align-items: start;
	}

	.model-list {
		display: grid;
		gap: 0.85rem;
	}

	.model-list article,
	.panel {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
	}

	.model-list article.active {
		border-color: var(--text);
		box-shadow: var(--shadow-md);
	}

	button {
		font: inherit;
		cursor: pointer;
	}

	.select-card {
		display: grid;
		gap: 0.35rem;
		width: 100%;
		border: none;
		background: transparent;
		padding: 1rem;
		color: var(--text);
		text-align: left;
	}

	.select-card strong {
		font-size: 1.25rem;
	}

	.select-card small,
	.muted,
	.lineage span {
		color: var(--text-secondary);
		line-height: 1.5;
	}

	.metrics,
	.score-strip {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		border-top: 1px solid var(--border-light);
		border-bottom: 1px solid var(--border-light);
	}

	.metrics div,
	.score-strip div {
		padding: 0.8rem 1rem;
		border-right: 1px solid var(--border-light);
	}

	.metrics div:last-child,
	.score-strip div:last-child {
		border-right: none;
	}

	.metrics strong,
	.score-strip strong {
		display: block;
		margin-top: 0.25rem;
		font-variant-numeric: tabular-nums;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0.8rem 1rem 1rem;
	}

	.actions button,
	.panel-head button,
	.panel-head a {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: #fff;
		color: var(--text);
		padding: 0.45rem 0.7rem;
		font-size: 0.83rem;
		font-weight: 720;
		text-decoration: none;
	}

	.actions button.dark {
		background: var(--text);
		border-color: var(--text);
		color: #fff;
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
		font-size: 1.1rem;
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.8rem;
	}

	.lineage {
		display: grid;
		gap: 0.5rem;
	}

	.lineage div {
		display: grid;
		gap: 0.2rem;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-input);
		padding: 0.7rem;
	}

	.lineage small {
		color: var(--green);
		font-family: var(--font-mono);
		font-weight: 800;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.88rem;
	}

	th,
	td {
		padding: 0.55rem;
		border-bottom: 1px solid var(--border-light);
		text-align: left;
	}

	th {
		color: var(--text-muted);
		font-size: 0.72rem;
		text-transform: uppercase;
	}

	@media (max-width: 980px) {
		.page-head,
		.models-grid {
			grid-template-columns: 1fr;
			display: grid;
			align-items: start;
		}
	}

	@media (max-width: 640px) {
		.summary,
		.metrics,
		.score-strip {
			grid-template-columns: 1fr;
		}

		.summary div,
		.metrics div,
		.score-strip div {
			border-right: none;
			border-bottom: 1px solid var(--border-light);
		}

		.summary div:last-child,
		.metrics div:last-child,
		.score-strip div:last-child {
			border-bottom: none;
		}
	}
</style>
