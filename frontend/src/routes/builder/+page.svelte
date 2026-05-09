<script lang="ts">
	import {
		SvelteFlow,
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		Panel,
		type Node,
		type Edge,
		type DefaultEdgeOptions,
		type FitViewOptions
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { computeProviders, lineageBranches, modelTemplates } from '$lib/product-data';

	type PresetId = 'baseline' | 'challenger' | 'ensemble';
	type BuilderNodeData = { label: string };
	type BuilderNode = Node<BuilderNodeData>;
	type BuilderEdge = Edge;
	type BranchRow = {
		id: string;
		name: string;
		delta: string;
		score: string;
		children: string[];
	};
	type QueueRun = {
		id: string;
		name: string;
		provider: string;
		status: 'ready' | 'queued';
		budget: string;
	};

	const providerNames = computeProviders.map((provider) => provider.name);

	const fitViewOptions: FitViewOptions = { padding: 0.24 };
	const defaultEdgeOptions: DefaultEdgeOptions = {
		animated: true,
		type: 'smoothstep'
	};

	function baselineNodes(): BuilderNode[] {
		return [
			{ id: 'data', type: 'input', position: { x: 0, y: 110 }, data: { label: 'Numerai data' } },
			{ id: 'features', position: { x: 220, y: 110 }, data: { label: 'Feature set' } },
			{ id: 'model', position: { x: 440, y: 110 }, data: { label: 'Baseline test' } },
			{ id: 'validate', position: { x: 660, y: 110 }, data: { label: 'Validation' } },
			{ id: 'submit', type: 'output', position: { x: 880, y: 110 }, data: { label: 'Submit candidate' } }
		];
	}

	function baselineEdges(): BuilderEdge[] {
		return [
			{ id: 'data-features', source: 'data', target: 'features', label: 'load' },
			{ id: 'features-model', source: 'features', target: 'model', label: 'train' },
			{ id: 'model-validate', source: 'model', target: 'validate', label: 'score' },
			{ id: 'validate-submit', source: 'validate', target: 'submit', label: 'if better' }
		];
	}

	function challengerNodes(): BuilderNode[] {
		return [
			{ id: 'data', type: 'input', position: { x: 0, y: 120 }, data: { label: 'Numerai data' } },
			{ id: 'features', position: { x: 210, y: 40 }, data: { label: 'Medium features' } },
			{ id: 'neutralize', position: { x: 210, y: 200 }, data: { label: 'Neutralization' } },
			{ id: 'model', position: { x: 450, y: 120 }, data: { label: 'Challenger test' } },
			{ id: 'validate', position: { x: 690, y: 120 }, data: { label: 'Cross validation' } },
			{ id: 'registry', type: 'output', position: { x: 930, y: 120 }, data: { label: 'Model registry' } }
		];
	}

	function challengerEdges(): BuilderEdge[] {
		return [
			{ id: 'data-features', source: 'data', target: 'features' },
			{ id: 'data-neutralize', source: 'data', target: 'neutralize' },
			{ id: 'features-model', source: 'features', target: 'model' },
			{ id: 'neutralize-model', source: 'neutralize', target: 'model' },
			{ id: 'model-validate', source: 'model', target: 'validate' },
			{ id: 'validate-registry', source: 'validate', target: 'registry' }
		];
	}

	function ensembleNodes(): BuilderNode[] {
		return [
			{ id: 'data', type: 'input', position: { x: 0, y: 150 }, data: { label: 'Numerai data' } },
			{ id: 'candidate-a', position: { x: 230, y: 50 }, data: { label: 'Candidate A' } },
			{ id: 'candidate-b', position: { x: 230, y: 250 }, data: { label: 'Candidate B' } },
			{ id: 'blend', position: { x: 480, y: 150 }, data: { label: 'Blend predictions' } },
			{ id: 'validate', position: { x: 720, y: 150 }, data: { label: 'Compare to parent' } },
			{ id: 'submit', type: 'output', position: { x: 960, y: 150 }, data: { label: 'Promote winner' } }
		];
	}

	function ensembleEdges(): BuilderEdge[] {
		return [
			{ id: 'data-a', source: 'data', target: 'candidate-a' },
			{ id: 'data-b', source: 'data', target: 'candidate-b' },
			{ id: 'a-blend', source: 'candidate-a', target: 'blend' },
			{ id: 'b-blend', source: 'candidate-b', target: 'blend' },
			{ id: 'blend-validate', source: 'blend', target: 'validate' },
			{ id: 'validate-submit', source: 'validate', target: 'submit' }
		];
	}

	function nodesForPreset(preset: PresetId): BuilderNode[] {
		if (preset === 'challenger') return challengerNodes();
		if (preset === 'ensemble') return ensembleNodes();
		return baselineNodes();
	}

	function edgesForPreset(preset: PresetId): BuilderEdge[] {
		if (preset === 'challenger') return challengerEdges();
		if (preset === 'ensemble') return ensembleEdges();
		return baselineEdges();
	}

	const initialPreset: PresetId = 'baseline';
	let activePreset = $state<PresetId>(initialPreset);
	let activeProvider = $state(providerNames[0]);
	let activeBranchId = $state('baseline-v4');
	let selectedTemplateId = $state('baseline');
	let sweepParameter = $state('learning_rate');
	let sweepValues = $state('0.003, 0.005, 0.008, 0.012');
	let maxRuns = $state(8);
	let maxSpend = $state(20);
	let branchCounter = $state(6);
	let branchRows = $state<BranchRow[]>(lineageBranches.map((branch) => ({ ...branch })));
	let queuedRuns = $state<QueueRun[]>([
		{ id: 'run-101', name: 'baseline smoke test', provider: 'Modal', status: 'ready', budget: '$4 cap' },
		{ id: 'run-102', name: 'candidate compare', provider: 'SageMaker', status: 'queued', budget: '$12 cap' }
	]);
	let nodes = $state.raw<BuilderNode[]>(nodesForPreset(initialPreset));
	let edges = $state.raw<BuilderEdge[]>(edgesForPreset(initialPreset));

	const activeBranch = $derived(branchRows.find((branch) => branch.id === activeBranchId) ?? branchRows[0]);
	const selectedTemplate = $derived(
		modelTemplates.find((template) => template.id === selectedTemplateId) ?? modelTemplates[0]
	);
	const sweepCandidates = $derived.by(() => {
		const values = sweepValues
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean)
			.slice(0, maxRuns);
		return values.map((value, index) => ({
			id: `${sweepParameter}-${index + 1}`,
			name: `${selectedTemplate.name} ${sweepParameter}=${value}`,
			value
		}));
	});

	function loadPreset(preset: PresetId) {
		activePreset = preset;
		selectedTemplateId = preset;
		nodes = nodesForPreset(preset);
		edges = edgesForPreset(preset);
	}

	function branchCurrent() {
		branchCounter += 1;
		const parent = activeBranch;
		const id = `branch-${branchCounter}`;
		branchRows = branchRows.map((branch) =>
			branch.id === parent.id ? { ...branch, children: [...branch.children, id] } : branch
		);
		branchRows = [
			...branchRows,
			{
				id,
				name: `${parent.name}-branch-${branchCounter}`,
				delta: 'copied graph, ready to edit',
				score: 'pending',
				children: []
			}
		];
		activeBranchId = id;
	}

	function queueSweep() {
		const additions = sweepCandidates.map((candidate, index) => ({
			id: `queued-${Date.now()}-${index}`,
			name: candidate.name,
			provider: activeProvider,
			status: 'ready' as const,
			budget: `$${maxSpend} cap`
		}));
		queuedRuns = [...additions, ...queuedRuns].slice(0, 8);
	}
</script>

<svelte:head>
	<title>Builder | Numerai Dashboard</title>
</svelte:head>

<AuthGate>
<section class="builder-page">
	<header class="page-head">
		<div>
			<p class="eyebrow">Builder</p>
			<h1>Branch, sweep, and test Numerai pipelines.</h1>
			<p>
				Start from a preset graph, drag steps into place, branch from any run, and generate a
				fine-grained sweep before backend wiring exists.
			</p>
		</div>
		<div class="head-actions">
			<button type="button" onclick={branchCurrent}>Branch current</button>
			<button type="button" class="primary" onclick={queueSweep}>Queue sweep</button>
		</div>
	</header>

	<div class="builder-grid">
		<aside class="sidebar">
			<section class="panel">
				<h2>Preset graphs</h2>
				<div class="seg-list">
					<button class:active={activePreset === 'baseline'} type="button" onclick={() => loadPreset('baseline')}>
						<strong>Quick baseline</strong>
						<span>data -> train -> validate</span>
					</button>
					<button class:active={activePreset === 'challenger'} type="button" onclick={() => loadPreset('challenger')}>
						<strong>Strong challenger</strong>
						<span>feature + neutralization path</span>
					</button>
					<button class:active={activePreset === 'ensemble'} type="button" onclick={() => loadPreset('ensemble')}>
						<strong>Ensemble test</strong>
						<span>two candidates into one blend</span>
					</button>
				</div>
			</section>

			<section class="panel">
				<h2>Model lineage</h2>
				<div class="lineage">
					{#each branchRows as branch}
						<button
							type="button"
							class:active={activeBranchId === branch.id}
							onclick={() => (activeBranchId = branch.id)}
						>
							<strong>{branch.name}</strong>
							<span>{branch.delta}</span>
							<small>{branch.score}</small>
						</button>
					{/each}
				</div>
			</section>
		</aside>

		<section class="canvas-card" aria-label="Pipeline builder canvas">
			<SvelteFlow bind:nodes bind:edges fitView {fitViewOptions} {defaultEdgeOptions}>
				<Background variant={BackgroundVariant.Dots} />
				<Controls />
				<MiniMap />
				<Panel position="top-left">
					<div class="canvas-badge">
						<span>Active branch</span>
						<strong>{activeBranch.name}</strong>
					</div>
				</Panel>
			</SvelteFlow>
		</section>

		<aside class="sidebar">
			<section class="panel">
				<h2>Fine parameter sweep</h2>
				<label>
					<span>Template</span>
					<select bind:value={selectedTemplateId}>
						{#each modelTemplates as template}
							<option value={template.id}>{template.name}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Parameter</span>
					<select bind:value={sweepParameter}>
						<option value="learning_rate">learning_rate</option>
						<option value="neutralization">neutralization</option>
						<option value="feature_set">feature_set</option>
						<option value="lookback_window">lookback_window</option>
					</select>
				</label>
				<label>
					<span>Values</span>
					<input bind:value={sweepValues} />
				</label>
				<div class="limits">
					<label>
						<span>Max runs</span>
						<input type="number" min="1" max="32" bind:value={maxRuns} />
					</label>
					<label>
						<span>Budget</span>
						<input type="number" min="1" max="500" bind:value={maxSpend} />
					</label>
				</div>
				<label>
					<span>Provider</span>
					<select bind:value={activeProvider}>
						{#each providerNames as provider}
							<option value={provider}>{provider}</option>
						{/each}
					</select>
				</label>
				<p class="muted">{selectedTemplate.body}</p>
			</section>

			<section class="panel">
				<h2>Generated tests</h2>
				<div class="test-list">
					{#each sweepCandidates as candidate}
						<div>
							<strong>{candidate.name}</strong>
							<span>{activeProvider} / ${maxSpend} cap</span>
						</div>
					{/each}
				</div>
			</section>
		</aside>
	</div>

	<section class="queue">
		<div>
			<p class="eyebrow">Run queue</p>
			<h2>One-click tests become queued jobs.</h2>
		</div>
		<div class="queue-list">
			{#each queuedRuns as run}
				<article>
					<span>{run.status}</span>
					<strong>{run.name}</strong>
					<p>{run.provider} / {run.budget}</p>
				</article>
			{/each}
		</div>
	</section>
</section>
</AuthGate>

<style>
	.builder-page {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		padding: 1rem 0 4rem;
	}

	.page-head,
	.queue {
		display: flex;
		justify-content: space-between;
		gap: 1.5rem;
		align-items: end;
		border-bottom: 1px solid var(--border-light);
		padding-bottom: 1.5rem;
	}

	.eyebrow {
		margin: 0 0 0.6rem;
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
		max-width: 12ch;
		font-size: clamp(3rem, 7vw, 5.8rem);
		line-height: 0.92;
		letter-spacing: 0;
	}

	.page-head p {
		max-width: 62ch;
		margin-top: 1rem;
		color: var(--text-secondary);
		line-height: 1.65;
	}

	.head-actions {
		display: flex;
		gap: 0.6rem;
	}

	button,
	select,
	input {
		font: inherit;
	}

	.head-actions button,
	.panel button {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: #fff;
		color: var(--text);
		cursor: pointer;
		font-weight: 720;
	}

	.head-actions button {
		min-height: 2.6rem;
		padding: 0 0.9rem;
	}

	.head-actions button.primary {
		background: var(--text);
		color: #fff;
		border-color: var(--text);
	}

	.builder-grid {
		display: grid;
		grid-template-columns: 260px minmax(0, 1fr) 300px;
		gap: 1rem;
		align-items: start;
	}

	.sidebar {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.panel,
	.canvas-card,
	.queue-list article {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
	}

	.panel {
		padding: 1rem;
	}

	.panel h2 {
		margin-bottom: 0.8rem;
		font-size: 1rem;
	}

	.seg-list,
	.lineage,
	.test-list,
	.queue-list {
		display: grid;
		gap: 0.5rem;
	}

	.seg-list button,
	.lineage button {
		display: grid;
		gap: 0.25rem;
		width: 100%;
		padding: 0.8rem;
		text-align: left;
	}

	.seg-list button.active,
	.lineage button.active {
		background: var(--hover-bg);
		border-color: var(--text);
	}

	.seg-list span,
	.lineage span,
	.lineage small,
	.test-list span,
	.queue-list span,
	.muted {
		color: var(--text-secondary);
		font-size: 0.78rem;
		line-height: 1.45;
	}

	.lineage small,
	.queue-list span {
		color: var(--green);
		font-family: var(--font-mono);
		font-weight: 800;
	}

	.canvas-card {
		height: 690px;
		overflow: hidden;
	}

	:global(.svelte-flow__node) {
		border: 1px solid var(--border) !important;
		border-radius: 8px !important;
		background: #fff !important;
		color: var(--text) !important;
		font-weight: 760 !important;
		box-shadow: var(--shadow-md) !important;
	}

	:global(.svelte-flow__edge-path) {
		stroke: var(--text) !important;
		stroke-width: 1.5 !important;
	}

	:global(.svelte-flow__minimap) {
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}

	.canvas-badge {
		display: grid;
		gap: 0.2rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.92);
		padding: 0.55rem 0.7rem;
		box-shadow: var(--shadow-sm);
	}

	.canvas-badge span,
	label span {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	label {
		display: grid;
		gap: 0.35rem;
		margin-bottom: 0.75rem;
	}

	select,
	input {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text);
		padding: 0.55rem 0.65rem;
	}

	.limits {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.6rem;
	}

	.test-list div {
		display: grid;
		gap: 0.25rem;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 0.65rem;
		background: var(--bg-input);
	}

	.queue {
		align-items: start;
		border-bottom: none;
		border-top: 1px solid var(--border-light);
		padding-top: 1.5rem;
	}

	.queue h2 {
		font-size: clamp(1.8rem, 3vw, 3rem);
		line-height: 1;
	}

	.queue-list {
		grid-template-columns: repeat(4, minmax(0, 1fr));
		min-width: 58%;
	}

	.queue-list article {
		padding: 1rem;
	}

	.queue-list strong {
		display: block;
		margin: 0.4rem 0;
	}

	@media (max-width: 1180px) {
		.builder-grid {
			grid-template-columns: 1fr;
		}

		.canvas-card {
			height: 620px;
			order: -1;
		}

		.sidebar {
			display: grid;
			grid-template-columns: 1fr 1fr;
		}

		.queue {
			display: grid;
		}

		.queue-list {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 700px) {
		.page-head {
			display: grid;
			align-items: start;
		}

		.head-actions,
		.sidebar,
		.queue-list {
			grid-template-columns: 1fr;
		}

		.head-actions {
			display: grid;
		}

		.canvas-card {
			height: 560px;
		}

		h1 {
			font-size: clamp(2.6rem, 16vw, 4rem);
		}
	}
</style>
