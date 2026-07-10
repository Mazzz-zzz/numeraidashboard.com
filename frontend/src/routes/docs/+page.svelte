<script lang="ts">
	import { SvelteFlow, Background, Controls, type Node, type Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	type DocSection = {
		readonly id: string;
		readonly title: string;
	};

	const sections: readonly DocSection[] = [
		{ id: 'tree', title: 'Architecture' },
		{ id: 'supported-models', title: 'Models' },
		{ id: 'model-diagrams', title: 'Diagrams' },
		{ id: 'flow', title: 'Flow' },
		{ id: 'data', title: 'Data' },
		{ id: 'providers', title: 'Providers' },
		{ id: 'cleanup', title: 'Cleanup' },
		{ id: 'routes', title: 'Routes' }
	] as const;

	type SupportedModel = {
		readonly value: string;
		readonly name: string;
		readonly family: string;
		readonly route: string;
		readonly accelerator: string;
		readonly use: string;
		readonly docs: readonly { readonly label: string; readonly href: string }[];
	};

	const supportedModels: readonly SupportedModel[] = [
		{
			value: 'lgbm',
			name: 'LightGBM',
			family: 'Gradient boosting',
			route: 'Default structured baseline',
			accelerator: 'CPU',
			use: 'Fast baseline, strong tabular default, simple feature sweeps.',
			docs: [{ label: 'Docs', href: 'https://lightgbm.readthedocs.io/' }]
		},
		{
			value: 'catboost',
			name: 'CatBoost',
			family: 'Gradient boosting',
			route: 'Tree challenger',
			accelerator: 'CPU / GPU package dependent',
			use: 'Robust tree model for categorical-heavy or low-touch experiments.',
			docs: [{ label: 'Docs', href: 'https://catboost.ai/' }]
		},
		{
			value: 'mlp',
			name: 'MLP',
			family: 'Neural',
			route: 'Local smoke and neural baseline',
			accelerator: 'CUDA / MPS / CPU',
			use: 'Small fast neural baseline with mixup, SWA, and multi-head options.',
			docs: [{ label: 'PyTorch', href: 'https://pytorch.org/docs/stable/nn.html' }]
		},
		{
			value: 'ft_transformer',
			name: 'FT-Transformer',
			family: 'Neural transformer',
			route: 'Feature-token attention',
			accelerator: 'CUDA / MPS / CPU',
			use: 'Attention-based tabular model for testing feature-token interactions.',
			docs: [{ label: 'RTDL paper/code', href: 'https://github.com/yandex-research/rtdl-revisiting-models' }]
		},
		{
			value: 'modern_nca',
			name: 'ModernNCA',
			family: 'Neural nearest-neighbor',
			route: 'Embedding + neighbor signal',
			accelerator: 'CUDA / MPS / CPU',
			use: 'Learns an embedding space and predicts from neighbor relationships.',
			docs: [{ label: 'Paper', href: 'https://huggingface.co/papers/2407.03257' }]
		},
		{
			value: 'tabm',
			name: 'TabM',
			family: 'Neural ensemble',
			route: 'Parameter-efficient MLP ensemble',
			accelerator: 'CUDA / MPS / CPU',
			use: 'Strong neural tabular candidate; efficient multi-prediction ensemble.',
			docs: [{ label: 'GitHub', href: 'https://github.com/yandex-research/tabm' }]
		},
		{
			value: 'tabpfn',
			name: 'TabPFN',
			family: 'Foundation / ICL',
			route: 'Bagged context learner',
			accelerator: 'CUDA / MPS / CPU',
			use: 'Pretrained in-context learner; useful for orthogonal signal and MMC tests.',
			docs: [{ label: 'Docs', href: 'https://github.com/PriorLabs/TabPFN' }]
		},
		{
			value: 'tabicl',
			name: 'TabICL',
			family: 'Foundation / ICL',
			route: 'Column-row-dataset transformer',
			accelerator: 'CUDA / MPS / CPU',
			use: 'Open tabular foundation model; scalable in-context predictions with offloading.',
			docs: [
				{ label: 'Docs', href: 'https://tabicl.readthedocs.io/en/latest/' },
				{ label: 'GitHub', href: 'https://github.com/soda-inria/tabicl' },
				{ label: 'Paper', href: 'https://arxiv.org/html/2502.05564v1' }
			]
		}
	] as const;

	const modelFamilies = [
		{
			name: 'Tree baselines',
			models: 'LightGBM, CatBoost',
			role: 'Establish a strong and cheap baseline before using GPU time.'
		},
		{
			name: 'Neural tabular',
			models: 'MLP, FT-Transformer, ModernNCA, TabM',
			role: 'Use CUDA or Apple MPS to test learned embeddings, attention, and parameter-efficient ensembles.'
		},
		{
			name: 'Foundation / ICL',
			models: 'TabPFN, TabICL',
			role: 'Store context rows instead of fine-tuning weights, then predict through pretrained transformers.'
		}
	] as const;

	const references = [
		{ label: 'TabICL official docs', href: 'https://tabicl.readthedocs.io/en/latest/' },
		{ label: 'TabICL GitHub', href: 'https://github.com/soda-inria/tabicl' },
		{ label: 'TabICL architecture paper', href: 'https://arxiv.org/html/2502.05564v1' },
		{ label: 'NanoTabICL minimal architecture', href: 'https://github.com/soda-inria/nanotabicl' },
		{ label: 'TabM GitHub', href: 'https://github.com/yandex-research/tabm' },
		{ label: 'RTDL FT-Transformer reference', href: 'https://github.com/yandex-research/rtdl-revisiting-models' }
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

		<section id="supported-models" class="doc-block">
			<p class="eyebrow">Models</p>
			<h2>Supported training models.</h2>
			<p class="block-copy">
				Builder writes the <code>model_type</code> value into a draft model's run config.
				Launch passes that value into the Python trainer, where <code>create_model</code>
				constructs the concrete implementation.
			</p>
			<div class="model-table-wrap">
				<table class="model-table">
					<thead>
						<tr>
							<th>Model</th>
							<th>Family</th>
							<th>Runtime</th>
							<th>Use in this workspace</th>
							<th>Links</th>
						</tr>
					</thead>
					<tbody>
						{#each supportedModels as model}
							<tr>
								<td>
									<strong>{model.name}</strong>
									<code>{model.value}</code>
									<span>{model.route}</span>
								</td>
								<td>{model.family}</td>
								<td>{model.accelerator}</td>
								<td>{model.use}</td>
								<td>
									<div class="link-list">
										{#each model.docs as doc}
											<a href={doc.href} target="_blank" rel="noreferrer">{doc.label}</a>
										{/each}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section id="model-diagrams" class="doc-block">
			<p class="eyebrow">Diagrams</p>
			<h2>How model families enter the pipeline.</h2>
			<div class="family-map" aria-label="Model family map">
				{#each modelFamilies as family}
					<div class="family-node">
						<strong>{family.name}</strong>
						<span>{family.models}</span>
						<p>{family.role}</p>
					</div>
				{/each}
			</div>

			<div class="tabicl-figure" aria-label="TabICL in-context learning architecture diagram">
				<div class="dataset-panel">
					<strong>Numerai table</strong>
					<div class="mini-table" aria-hidden="true">
						<span></span><span></span><span></span><span></span>
						<span></span><span></span><span></span><span></span>
						<span></span><span></span><span></span><span></span>
						<span></span><span></span><span></span><span></span>
					</div>
					<p>Features, eras, target</p>
				</div>
				<div class="flow-arrow" aria-hidden="true">&rarr;</div>
				<div class="stage-node">
					<strong>Column-wise embedding</strong>
					<span>Distribution-aware feature encoders</span>
				</div>
				<div class="flow-arrow" aria-hidden="true">&rarr;</div>
				<div class="stage-node">
					<strong>Row-wise interaction</strong>
					<span>Feature dependencies become row embeddings</span>
				</div>
				<div class="flow-arrow" aria-hidden="true">&rarr;</div>
				<div class="stage-node icl-node">
					<strong>Dataset-wise ICL</strong>
					<span>Train rows + labels condition test predictions</span>
				</div>
				<div class="flow-arrow" aria-hidden="true">&rarr;</div>
				<div class="prediction-panel">
					<strong>Predictions</strong>
					<span>Ranked, neutralized, submitted</span>
				</div>
			</div>

			<div class="reference-strip">
				{#each references as ref}
					<a href={ref.href} target="_blank" rel="noreferrer">{ref.label}</a>
				{/each}
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
						<li>CPU-only instances such as <code>t4g.large</code> do not expose an NVIDIA GPU.</li>
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
				<div><strong>/builder</strong><span>Create model drafts from explicit training parameters.</span></div>
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

	.block-copy {
		max-width: 850px;
		margin-bottom: 0.9rem;
		color: var(--text-secondary);
		font-size: 0.9rem;
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

	.model-table-wrap {
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

	.model-table {
		min-width: 900px;
	}

	.model-table td:first-child {
		display: grid;
		gap: 0.25rem;
		min-width: 150px;
	}

	.model-table td:first-child strong {
		color: var(--text);
		font-size: 0.9rem;
	}

	.model-table td:first-child span {
		color: var(--text-muted);
		font-size: 0.76rem;
		line-height: 1.35;
	}

	.link-list,
	.reference-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.link-list a,
	.reference-strip a {
		border: 1px solid var(--border-light);
		border-radius: 999px;
		background: var(--bg-page);
		color: var(--text-secondary);
		font-size: 0.76rem;
		font-weight: 760;
		line-height: 1;
		padding: 0.42rem 0.55rem;
		text-decoration: none;
		white-space: nowrap;
	}

	.link-list a:hover,
	.reference-strip a:hover {
		border-color: var(--border);
		color: var(--text);
	}

	.family-map {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.family-node {
		display: grid;
		gap: 0.35rem;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-input);
		padding: 0.8rem;
	}

	.family-node strong {
		font-size: 0.9rem;
	}

	.family-node span {
		color: var(--text);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 760;
		line-height: 1.4;
	}

	.family-node p {
		color: var(--text-secondary);
		font-size: 0.82rem;
		line-height: 1.5;
	}

	.tabicl-figure {
		display: grid;
		grid-template-columns: minmax(130px, 0.95fr) 28px minmax(145px, 1fr) 28px minmax(145px, 1fr) 28px minmax(145px, 1fr) 28px minmax(125px, 0.85fr);
		align-items: stretch;
		gap: 0.45rem;
		overflow-x: auto;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-page);
		padding: 0.8rem;
	}

	.dataset-panel,
	.stage-node,
	.prediction-panel {
		display: grid;
		align-content: center;
		gap: 0.35rem;
		min-height: 150px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		padding: 0.75rem;
	}

	.dataset-panel strong,
	.stage-node strong,
	.prediction-panel strong {
		font-size: 0.86rem;
		line-height: 1.2;
	}

	.dataset-panel p,
	.stage-node span,
	.prediction-panel span {
		color: var(--text-secondary);
		font-size: 0.78rem;
		line-height: 1.4;
	}

	.stage-node {
		position: relative;
		background:
			linear-gradient(90deg, transparent 0, transparent 24%, rgba(23, 23, 23, 0.06) 24%, rgba(23, 23, 23, 0.06) 26%, transparent 26%),
			var(--bg-card);
	}

	.stage-node::after {
		content: '';
		position: absolute;
		inset: auto 0.8rem 0.7rem;
		height: 7px;
		border-radius: 999px;
		background: linear-gradient(90deg, #2b6cb0, #38a169, #d69e2e, #c53030);
		opacity: 0.78;
	}

	.icl-node::after {
		background: linear-gradient(90deg, #171717, #2b6cb0, #38a169, #c53030);
	}

	.flow-arrow {
		display: grid;
		place-items: center;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 1.05rem;
		font-weight: 900;
	}

	.mini-table {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 3px;
		width: min(100%, 118px);
	}

	.mini-table span {
		aspect-ratio: 1;
		border-radius: 3px;
		background: var(--bg-input);
		border: 1px solid var(--border-light);
	}

	.mini-table span:nth-child(4n + 1) {
		background: rgba(43, 108, 176, 0.15);
	}

	.mini-table span:nth-child(4n + 2) {
		background: rgba(56, 161, 105, 0.15);
	}

	.mini-table span:nth-child(4n + 3) {
		background: rgba(214, 158, 46, 0.16);
	}

	.mini-table span:nth-child(4n) {
		background: rgba(197, 48, 48, 0.13);
	}

	.reference-strip {
		margin-top: 0.8rem;
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

		.family-map {
			grid-template-columns: 1fr;
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

		.tabicl-figure {
			grid-template-columns: 1fr;
		}

		.flow-arrow {
			min-height: 18px;
			transform: rotate(90deg);
		}
	}
</style>
