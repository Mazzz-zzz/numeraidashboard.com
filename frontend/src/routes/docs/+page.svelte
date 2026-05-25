<script lang="ts">
	import { SvelteFlow, Background, Controls, type Node, type Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	type DocSection = {
		readonly id: string;
		readonly title: string;
	};

	const sections: readonly DocSection[] = [
		{ id: 'tree', title: 'Architecture' },
		{ id: 'flow', title: 'Flow' },
		{ id: 'data', title: 'Data' },
		{ id: 'providers', title: 'Providers' },
		{ id: 'cleanup', title: 'Cleanup' },
		{ id: 'routes', title: 'Routes' }
	] as const;

	const docNodes: Node[] = [
		{
			id: 'builder',
			position: { x: 0, y: 120 },
			data: { label: 'Builder drafts' }
		},
		{
			id: 'draft',
			position: { x: 160, y: 120 },
			data: { label: 'ModelRegistryItem stage: draft' }
		},
		{
			id: 'models',
			position: { x: 340, y: 120 },
			data: { label: 'Models tab canonical registry' }
		},
		{
			id: 'launch',
			position: { x: 520, y: 120 },
			data: { label: 'Launch selected drafts' }
		},
		{
			id: 'training-run',
			position: { x: 695, y: 45 },
			data: { label: 'TrainingRun internal attempt' }
		},
		{
			id: 'compute-job',
			position: { x: 860, y: 45 },
			data: { label: 'ComputeJob provider job' }
		},
		{
			id: 'provider',
			position: { x: 1025, y: 45 },
			data: { label: 'ComputeProvider Prime/local/custom' }
		},
		{
			id: 'training',
			position: { x: 695, y: 200 },
			data: { label: 'ModelRegistryItem stage: training' }
		},
		{
			id: 'done',
			position: { x: 860, y: 200 },
			data: { label: 'ModelRegistryItem success or failed' }
		}
	];

	const docEdges: Edge[] = [
		{ id: 'builder-draft', source: 'builder', target: 'draft', type: 'smoothstep', label: 'create' },
		{ id: 'draft-models', source: 'draft', target: 'models', type: 'smoothstep', label: 'appears in' },
		{ id: 'models-launch', source: 'models', target: 'launch', type: 'smoothstep', label: 'select' },
		{ id: 'launch-run', source: 'launch', target: 'training-run', type: 'smoothstep', label: 'attempt' },
		{
			id: 'run-job',
			source: 'training-run',
			target: 'compute-job',
			type: 'smoothstep',
			label: 'start/poll'
		},
		{
			id: 'job-provider',
			source: 'compute-job',
			target: 'provider',
			type: 'smoothstep',
			label: 'provider API'
		},
		{
			id: 'launch-training',
			source: 'launch',
			target: 'training',
			type: 'smoothstep',
			label: 'set stage'
		},
		{
			id: 'training-done',
			source: 'training',
			target: 'done',
			type: 'smoothstep',
			label: 'refresh result'
		},
		{
			id: 'done-models',
			source: 'done',
			target: 'models',
			type: 'smoothstep',
			label: 'stays stored',
			animated: true
		}
	];
</script>

<svelte:head>
	<title>Docs | Numerai Dashboard</title>
</svelte:head>

<section class="docs-page">
	<aside class="docs-sidebar" aria-label="Documentation navigation">
		<a class="docs-home" href="#top">Docs</a>
		<nav>
			{#each sections as section}
				<a href={`#${section.id}`}>{section.title}</a>
			{/each}
		</nav>
	</aside>

	<main id="top" class="docs-content">
		<header class="page-head">
			<p class="eyebrow">Docs</p>
			<h1>Numerai Dashboard flow.</h1>
			<p>
				Builder creates model drafts. Models remains the central registry. Launch starts compute and
				updates the same model through training, success, or failed states.
			</p>
		</header>

		<section id="tree" class="doc-block">
			<p class="eyebrow">Architecture</p>
			<h2>Models are the center.</h2>
			<div class="diagram-shell" aria-label="Model-centered pipeline diagram">
				<SvelteFlow
					nodes={docNodes}
					edges={docEdges}
					fitView
					fitViewOptions={{ padding: 0.08 }}
					proOptions={{ hideAttribution: true }}
					nodesDraggable={false}
					nodesConnectable={false}
				>
					<Background patternColor="rgba(23,23,23,0.08)" gap={28} />
					<Controls showLock={false} />
				</SvelteFlow>
			</div>
		</section>

		<section id="flow" class="doc-block">
			<p class="eyebrow">Flow</p>
			<h2>Draft to trained model.</h2>
			<ol class="flow-list">
				<li>
					<strong>Builder</strong>
					<span
						>Creates one or more <code>ModelRegistryItem</code> rows with
						<code>stage = draft</code>. It does not launch compute.</span
					>
				</li>
				<li>
					<strong>Models</strong>
					<span>Shows every model draft and every lifecycle state. A model should not disappear from here.</span>
				</li>
				<li>
					<strong>Launch</strong>
					<span
						>Selects draft or failed models, creates an internal attempt, starts the selected
						provider, and sets <code>stage = training</code>.</span
					>
				</li>
				<li>
					<strong>Status refresh</strong>
					<span
						>Polls the provider job and updates the same model to <code>training</code>,
						<code>success</code>, or <code>failed</code>.</span
					>
				</li>
				<li>
					<strong>Submit</strong>
					<span>Uses registered model artifacts and Numerai account settings to submit predictions when enabled.</span>
				</li>
			</ol>
		</section>

		<section id="data" class="doc-block">
			<p class="eyebrow">Data</p>
			<h2>What each table owns.</h2>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Record</th>
							<th>Role</th>
							<th>User-facing</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>ModelRegistryItem</td>
							<td>Canonical model lifecycle, lineage, latest run pointer.</td>
							<td>Yes</td>
						</tr>
						<tr>
							<td>TrainingRun</td>
							<td>Internal attempt history for training, metrics, artifact URI, logs.</td>
							<td>No</td>
						</tr>
						<tr>
							<td>ComputeJob</td>
							<td>Internal provider job status, provider job ID, cost and logs.</td>
							<td>No</td>
						</tr>
						<tr>
							<td>ComputeProvider</td>
							<td>Provider credentials refs, verification state, runtime limits.</td>
							<td>Settings and Launch</td>
						</tr>
					</tbody>
				</table>
			</div>
		</section>

		<section id="providers" class="doc-block">
			<p class="eyebrow">Providers</p>
			<h2>Prime and local behavior.</h2>
			<div class="split">
				<div>
					<h3>Prime Intellect</h3>
					<ul>
						<li>Uses the saved provider API key reference.</li>
						<li>Creates or polls a Prime compute pod through Amplify functions.</li>
						<li>Requires a synced template/provider config before live GPU training.</li>
					</ul>
				</div>
				<div>
					<h3>Demo Local GPU</h3>
					<ul>
						<li>Placeholder provider used for UI workflow testing.</li>
						<li>Does not prove this host has a GPU.</li>
						<li>On this EC2 host, <code>t4g.large</code> has no local NVIDIA GPU.</li>
					</ul>
				</div>
			</div>
		</section>

		<section id="cleanup" class="doc-block">
			<p class="eyebrow">Cleanup</p>
			<h2>What can be deleted.</h2>
			<ul class="rules">
				<li>Keep <code>ModelRegistryItem</code> records unless the user deletes a model.</li>
				<li>Keep <code>TrainingRun</code> and <code>ComputeJob</code> records that are referenced by a model or needed for audit.</li>
				<li>Delete orphan <code>TrainingRun</code> rows not referenced by any model when cleaning old pipeline tests.</li>
				<li>Delete orphan <code>ComputeJob</code> rows whose <code>runId</code> no longer points to a kept training run.</li>
			</ul>
		</section>

		<section id="routes" class="doc-block">
			<p class="eyebrow">Routes</p>
			<h2>Current product map.</h2>
			<div class="route-grid">
				<div><strong>/</strong><span>Dashboard summary.</span></div>
				<div><strong>/builder</strong><span>Create model drafts from OpenOptions-style params.</span></div>
				<div><strong>/models</strong><span>Canonical model registry, lineage, and submit views.</span></div>
				<div><strong>/launch</strong><span>Start provider training for draft models.</span></div>
				<div><strong>/settings</strong><span>Numerai and compute provider setup.</span></div>
				<div><strong>/docs</strong><span>This architecture and operating guide.</span></div>
			</div>
		</section>
	</main>
</section>

<style>
	.docs-page {
		display: grid;
		grid-template-columns: 240px minmax(0, 1fr);
		gap: 1.25rem;
		align-items: start;
		padding: 1rem 0 4rem;
	}

	.docs-sidebar {
		position: sticky;
		top: calc(var(--nav-height) + 1rem);
		display: grid;
		gap: 0.9rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		padding: 0.9rem;
	}

	.docs-home {
		color: var(--text);
		font-size: 1rem;
		font-weight: 820;
		text-decoration: none;
	}

	.docs-sidebar nav {
		display: grid;
		gap: 0.25rem;
		border-top: 1px solid var(--border-light);
		padding-top: 0.7rem;
	}

	.docs-sidebar nav a {
		border-radius: 6px;
		color: var(--text-secondary);
		font-size: 0.84rem;
		font-weight: 720;
		padding: 0.5rem 0.55rem;
		text-decoration: none;
	}

	.docs-sidebar nav a:hover {
		background: var(--hover-bg);
		color: var(--text);
	}

	.docs-content {
		display: grid;
		gap: 1rem;
		min-width: 0;
	}

	.page-head {
		display: grid;
		gap: 0.55rem;
		border-bottom: 1px solid var(--border-light);
		padding-bottom: 1rem;
	}

	.eyebrow {
		margin: 0;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	h1,
	h2,
	h3,
	p {
		margin: 0;
	}

	h1 {
		max-width: 820px;
		font-size: clamp(2.2rem, 4vw, 3.8rem);
		line-height: 1;
		letter-spacing: 0;
	}

	h2 {
		font-size: 1.2rem;
		margin-bottom: 0.75rem;
	}

	h3 {
		font-size: 0.95rem;
		margin-bottom: 0.45rem;
	}

	.page-head p:last-child {
		max-width: 780px;
		color: var(--text-secondary);
		font-size: 0.96rem;
		line-height: 1.55;
	}

	.doc-block {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		padding: 1rem;
		scroll-margin-top: calc(var(--nav-height) + 1rem);
	}

	.diagram-shell {
		height: 360px;
		overflow: hidden;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-page);
	}

	.diagram-shell :global(.svelte-flow) {
		background: var(--bg-page);
	}

	.diagram-shell :global(.svelte-flow__node-default) {
		max-width: 170px;
		width: 132px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		color: var(--text);
		font-size: 0.82rem;
		font-weight: 780;
		line-height: 1.25;
		padding: 0.75rem;
		text-align: left;
	}

	.diagram-shell :global(.svelte-flow__edge-text) {
		fill: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 800;
	}

	code {
		color: var(--text);
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}

	.flow-list {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.flow-list li,
	.route-grid div {
		display: grid;
		gap: 0.2rem;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-input);
		padding: 0.7rem;
	}

	.flow-list span,
	.route-grid span,
	.rules,
	ul {
		color: var(--text-secondary);
		font-size: 0.88rem;
		line-height: 1.55;
	}

	.table-wrap {
		overflow-x: auto;
		border: 1px solid var(--border-light);
		border-radius: 6px;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		padding: 0.75rem 0.85rem;
		border-bottom: 1px solid var(--border-light);
		text-align: left;
		vertical-align: top;
	}

	th {
		background: var(--bg-page);
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	td {
		font-size: 0.86rem;
	}

	tr:last-child td {
		border-bottom: none;
	}

	.split,
	.route-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	.split > div {
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-input);
		padding: 0.8rem;
	}

	ul {
		margin: 0;
		padding-left: 1.1rem;
	}

	.rules {
		display: grid;
		gap: 0.35rem;
	}

	@media (max-width: 900px) {
		.docs-page {
			grid-template-columns: 1fr;
		}

		.docs-sidebar {
			position: static;
		}

		.docs-sidebar nav {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	@media (max-width: 640px) {
		.docs-sidebar nav,
		.split,
		.route-grid {
			grid-template-columns: 1fr;
		}

		.diagram-shell {
			height: 330px;
		}
	}
</style>
