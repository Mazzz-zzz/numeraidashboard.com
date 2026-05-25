<script lang="ts">
	type DocSection = {
		readonly id: string;
		readonly title: string;
	};

	const sections: readonly DocSection[] = [
		{ id: 'tree', title: 'Tree' },
		{ id: 'flow', title: 'Flow' },
		{ id: 'data', title: 'Data' },
		{ id: 'providers', title: 'Providers' },
		{ id: 'cleanup', title: 'Cleanup' },
		{ id: 'routes', title: 'Routes' }
	] as const;
</script>

<svelte:head>
	<title>Docs | Numerai Dashboard</title>
</svelte:head>

<section class="docs-page">
	<header class="page-head">
		<div>
			<p class="eyebrow">Docs</p>
			<h1>Numerai Dashboard flow.</h1>
		</div>
		<nav class="quick-nav" aria-label="Documentation sections">
			{#each sections as section}
				<a href={`#${section.id}`}>{section.title}</a>
			{/each}
		</nav>
	</header>

		<section id="tree" class="doc-block">
			<p class="eyebrow">Tree</p>
			<h2>Models are the center.</h2>
			<pre><code>{`ModelRegistryItem
  stage: draft | training | success | failed | testing | live | retired
  lineageJson
    source: builder
    template
    runConfig
    sweep
    lastTrainingAction
  runId -> current TrainingRun
  pipelineId -> optional Pipeline
  branchId -> optional ModelBranch

TrainingRun
  internal attempt record
  configJson
  status
  metricsJson
  artifactUri

ComputeJob
  internal provider job record
  runId -> TrainingRun
  providerId -> ComputeProvider
  providerJobId
  status
  cost/log fields

ComputeProvider
  Prime Intellect | Modal | SageMaker | Local | Custom
  credentials refs and provider runtime config`}</code></pre>
		</section>

		<section id="flow" class="doc-block">
			<p class="eyebrow">Flow</p>
			<h2>Draft to trained model.</h2>
			<ol class="flow-list">
				<li>
					<strong>Builder</strong>
					<span>Creates one or more `ModelRegistryItem` rows with `stage = draft`. It does not launch compute.</span>
				</li>
				<li>
					<strong>Models</strong>
					<span>Shows every model draft and every lifecycle state. A model should not disappear from here.</span>
				</li>
				<li>
					<strong>Launch</strong>
					<span>Selects draft or failed models, creates an internal attempt, starts the selected provider, and sets `stage = training`.</span>
				</li>
				<li>
					<strong>Status refresh</strong>
					<span>Polls the provider job and updates the same model to `training`, `success`, or `failed`.</span>
				</li>
				<li>
					<strong>Submit</strong>
					<span>Uses registered model artifacts and Numerai account settings to submit predictions when enabled.</span>
				</li>
			</ol>
			<pre><code>{`Builder
  -> ModelRegistryItem(stage: draft)
  -> Models tab
  -> Launch tab
  -> TrainingRun + ComputeJob internal records
  -> Provider start/poll
  -> ModelRegistryItem(stage: training | success | failed)`}</code></pre>
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
						<li>On this EC2 host, `t4g.large` has no local NVIDIA GPU.</li>
					</ul>
				</div>
			</div>
		</section>

		<section id="cleanup" class="doc-block">
			<p class="eyebrow">Cleanup</p>
			<h2>What can be deleted.</h2>
			<ul class="rules">
				<li>Keep `ModelRegistryItem` records unless the user deletes a model.</li>
				<li>Keep `TrainingRun` and `ComputeJob` records that are referenced by a model or needed for audit.</li>
				<li>Delete orphan `TrainingRun` rows not referenced by any model when cleaning old pipeline tests.</li>
				<li>Delete orphan `ComputeJob` rows whose `runId` no longer points to a kept training run.</li>
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
</section>

<style>
	.docs-page {
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
		margin: 0 0 0.4rem;
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
		font-size: clamp(2.4rem, 5vw, 4.4rem);
		line-height: 0.95;
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

	.quick-nav {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.4rem;
		max-width: 520px;
	}

	.quick-nav a {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-card);
		color: var(--text);
		font-size: 0.8rem;
		font-weight: 760;
		padding: 0.42rem 0.65rem;
		text-decoration: none;
	}

	.quick-nav a:hover {
		background: var(--hover-bg);
	}

	.doc-block {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		padding: 1rem;
		scroll-margin-top: calc(var(--nav-height) + 1rem);
	}

	pre {
		margin: 0;
		overflow: auto;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		background: var(--bg-input);
		padding: 0.85rem;
	}

	code {
		font-family: var(--font-mono);
	}

	code {
		font-size: 0.82rem;
		line-height: 1.55;
		color: var(--text);
	}

	.flow-list {
		display: grid;
		gap: 0.5rem;
		margin: 0 0 0.75rem;
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

	@media (max-width: 760px) {
		.page-head,
		.split,
		.route-grid {
			display: grid;
			grid-template-columns: 1fr;
		}

		.quick-nav {
			justify-content: start;
		}
	}
</style>
