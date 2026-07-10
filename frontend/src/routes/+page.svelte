<script lang="ts">
	import { onMount } from 'svelte';
	import { authState } from '$lib/auth';
	import GitHubClonePrompt from '$lib/components/GitHubClonePrompt.svelte';
	import {
		countActiveWork,
		latestSubmission,
		nextDashboardAction,
		summarizeComputeConnection,
		summarizeNumeraiConnection
	} from '$lib/dashboard';
	import { seedDemoWorkspace } from '$lib/services/demo-seed-service';
	import { loadDashboardData } from '$lib/services/dashboard-service';
	import type { NumeraiAccount } from '$lib/services/account-service';
	import type { ComputeProvider, ComputeJob } from '$lib/services/compute-service';
	import type { TrainingRun } from '$lib/services/pipeline-service';
	import type { ModelRegistryItem } from '$lib/services/registry-service';
	import { addToast } from '$lib/stores';

	const modules = [
		{
			kicker: 'Builder',
			title: 'Design training flows',
			body: 'Start from a preset graph, branch a model, sweep parameters, and route runs to the right compute provider.',
			href: '/builder',
			cta: 'Open builder'
		},
		{
			kicker: 'Models',
			title: 'Operate live candidates',
			body: 'Track production, testing, and draft models with live performance, lineage, and promote/retire actions.',
			href: '/models',
			cta: 'Review models'
		}
	] as const;

	const workflow = [
		{
			step: '01',
			title: 'Configure',
			body: 'Choose the feature set, model family, neutralization level, target setup, and compute backend.'
		},
		{
			step: '02',
			title: 'Train',
			body: 'Run experiments through SageMaker, Modal, or a local GPU runner while progress updates stream back into the app.'
		},
		{
			step: '03',
			title: 'Evaluate',
			body: 'Compare runs across Numerai metrics and dig into local sweeps, folds, and verification methods before submission.'
		},
		{
			step: '04',
			title: 'Deploy',
			body: 'Promote the strongest model, upload predictions when enabled, and keep a record of the setup that produced it.'
		}
	] as const;

	const stats = [
		{ label: 'Run templates', value: '8+' },
		{ label: 'Targets', value: '21' },
		{ label: 'Backends', value: '3' }
	] as const;

	const providerFlow = [
		{
			id: 'prime',
			name: 'Prime Intellect',
			tag: 'decentralized GPU',
			body: 'Route larger research jobs to distributed accelerator capacity when the queue or budget calls for it.',
			latency: 'batch scale',
			status: 'planned'
		},
		{
			id: 'modal',
			name: 'Modal',
			tag: 'serverless GPU',
			body: 'Spin up short-lived GPU workers for quick training runs, validation checks, and rapid iteration.',
			latency: 'fast start',
			status: 'available'
		},
		{
			id: 'sagemaker',
			name: 'SageMaker',
			tag: 'managed cloud',
			body: 'Run reproducible managed jobs with stored configs, logs, costs, and training metadata.',
			latency: 'managed jobs',
			status: 'available'
		},
		{
			id: 'local',
			name: 'Local GPU',
			tag: 'owned hardware',
			body: 'Queue experiments to your own workstation or private GPU box while keeping results in the dashboard.',
			latency: 'developer loop',
			status: 'available'
		},
		{
			id: 'future',
			name: 'More providers',
			tag: 'bring your compute',
			body: 'The provider layer is designed to add more GPU clouds and private clusters without changing the research workflow.',
			latency: 'extensible',
			status: 'roadmap'
		}
	] as const;

	const testTemplates = [
		{
			id: 'baseline',
			name: 'Baseline test',
			body: 'A low-cost smoke test that confirms data, features, training, and result tracking work end to end.',
			runtime: 'short'
		},
		{
			id: 'challenger',
			name: 'Challenger test',
			body: 'A stronger candidate run for checking whether a new approach is worth deeper tuning.',
			runtime: 'medium'
		},
		{
			id: 'ensemble',
			name: 'Ensemble test',
			body: 'A comparison pass for blending candidates and measuring whether combined predictions improve the signal.',
			runtime: 'compare'
		}
	] as const;

	type ProviderId = (typeof providerFlow)[number]['id'];
	type TestTemplateId = (typeof testTemplates)[number]['id'];

	let activeProviderId = $state<ProviderId>('prime');
	let activeTestId = $state<TestTemplateId>('baseline');

	const activeProvider = $derived(
		providerFlow.find((provider) => provider.id === activeProviderId) ?? providerFlow[0]
	);
	const activeTest = $derived(
		testTemplates.find((template) => template.id === activeTestId) ?? testTemplates[0]
	);

	let numeraiAccounts = $state<NumeraiAccount[]>([]);
	let computeProviders = $state<ComputeProvider[]>([]);
	let trainingRuns = $state<TrainingRun[]>([]);
	let computeJobs = $state<ComputeJob[]>([]);
	let registeredModels = $state<ModelRegistryItem[]>([]);
	let dashboardLoading = $state(false);
	let dashboardLoaded = $state(false);
	let seedBusy = $state(false);

	onMount(() => {
		if ($authState.user) void loadDashboard();
	});

	$effect(() => {
		if ($authState.user && !dashboardLoaded && !dashboardLoading) void loadDashboard();
		if (!$authState.user) dashboardLoaded = false;
	});

	async function loadDashboard() {
		dashboardLoading = true;
		try {
			const data = await loadDashboardData();
			numeraiAccounts = data.numeraiAccounts;
			computeProviders = data.computeProviders;
			trainingRuns = data.trainingRuns;
			computeJobs = data.computeJobs;
			registeredModels = data.registeredModels;
			dashboardLoaded = true;
		} catch (e) {
			addToast(asMessage(e, 'Failed to load dashboard'), 'error');
			dashboardLoaded = true;
		} finally {
			dashboardLoading = false;
		}
	}

	async function seedDemo() {
		seedBusy = true;
		try {
			const summary = await seedDemoWorkspace();
			await loadDashboard();
			addToast(
				summary.created > 0
					? `Demo workspace seeded with ${summary.created} records.`
					: 'Demo workspace already exists.',
				'success'
			);
		} catch (e) {
			addToast(asMessage(e, 'Failed to seed demo workspace'), 'error');
		} finally {
			seedBusy = false;
		}
	}

	const numeraiSummary = $derived(summarizeNumeraiConnection(numeraiAccounts));
	const computeSummary = $derived(summarizeComputeConnection(computeProviders));
	const activeTrainingCount = $derived(countActiveWork(trainingRuns));
	const activeJobCount = $derived(countActiveWork(computeJobs));
	const activeWorkCount = $derived(activeTrainingCount + activeJobCount);
	const latestSubmittedModel = $derived(latestSubmission(registeredModels));
	const nextAction = $derived(
		nextDashboardAction({
			numerai: numeraiSummary,
			compute: computeSummary,
			modelCount: registeredModels.length,
			activeWorkCount
		})
	);
	const recentRuns = $derived(trainingRuns.slice(0, 4));
	const recentJobs = $derived(computeJobs.slice(0, 4));

	function asMessage(e: unknown, fallback: string) {
		return e instanceof Error ? e.message : fallback;
	}

	function fmtDate(value: string | null | undefined) {
		if (!value) return 'No timestamp';
		try {
			return new Date(value).toLocaleString();
		} catch {
			return value;
		}
	}
</script>

<svelte:head>
	<meta
		name="description"
		content="A white, Prime-inspired operating surface for training, comparing, and deploying Numerai machine learning models."
	/>
</svelte:head>

{#if $authState.user}
	<section class="dashboard-page" aria-labelledby="dashboard-title">
		<header class="dashboard-head">
			<div>
				<p class="eyebrow">Dashboard</p>
				<h1 id="dashboard-title">Operate today’s Numerai work.</h1>
				<p class="lede">
					Start with account and compute readiness, then watch active training, provider jobs,
					model registry state, and the next submission step from the same page.
				</p>
			</div>
			<div class="head-actions">
				<a class="primary-action" href={nextAction.href}>{nextAction.label}</a>
				<button type="button" class="secondary-action" onclick={seedDemo} disabled={seedBusy}>
					{seedBusy ? 'Seeding…' : 'Seed demo'}
				</button>
			</div>
		</header>

		{#if dashboardLoading && !dashboardLoaded}
			<p class="muted">Loading dashboard…</p>
		{/if}

		<div class="connection-grid" aria-label="Connection status">
			<a class="status-card" class:good={numeraiSummary.tone === 'good'} href="/settings">
				<span>Numerai</span>
				<strong>{numeraiSummary.label}</strong>
				<p>{numeraiSummary.detail}</p>
			</a>
			<a class="status-card" class:good={computeSummary.tone === 'good'} href="/settings">
				<span>Compute</span>
				<strong>{computeSummary.label}</strong>
				<p>{computeSummary.detail}</p>
			</a>
		</div>

		<div class="dashboard-grid">
			<section class="ops-panel">
				<div class="panel-title">
					<span>Active work</span>
					<strong>{activeWorkCount}</strong>
				</div>
				<div class="metric-grid">
					<div class="metric">
						<span>Training runs</span>
						<strong>{activeTrainingCount}</strong>
					</div>
					<div class="metric">
						<span>Compute jobs</span>
						<strong>{activeJobCount}</strong>
					</div>
					<div class="metric">
						<span>Models</span>
						<strong>{registeredModels.length}</strong>
					</div>
				</div>
			</section>

			<section class="ops-panel">
				<div class="panel-title">
					<span>Latest submission</span>
					<strong>{latestSubmittedModel?.name ?? 'None yet'}</strong>
				</div>
				<p class="panel-copy">
					{#if latestSubmittedModel}
						Round {latestSubmittedModel.lastSubmittedRound ?? 'unknown'} · {fmtDate(latestSubmittedModel.lastSubmittedAt)}
					{:else}
						Register a model and submit predictions from Models once Numerai and compute are ready.
					{/if}
				</p>
			</section>

			<section class="ops-panel wide">
				<div class="panel-title">
					<span>Recent training runs</span>
					<a href="/builder">Open builder</a>
				</div>
				{#if recentRuns.length === 0}
					<p class="panel-copy">No training runs are tracked yet.</p>
				{:else}
					<div class="run-table">
						<div class="row head">
							<span>Run</span>
							<span>Status</span>
							<span>Cost</span>
							<span>Started</span>
						</div>
						{#each recentRuns as run}
							<div class="row">
								<span>{run.modelTemplate ?? 'custom'}</span>
								<span>{run.status ?? 'unknown'}</span>
								<span>{run.costUsd == null ? '—' : `$${run.costUsd.toFixed(2)}`}</span>
								<span>{fmtDate(run.startedAt)}</span>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<section class="ops-panel wide">
				<div class="panel-title">
					<span>Recent compute jobs</span>
					<a href="/settings">Manage providers</a>
				</div>
				{#if recentJobs.length === 0}
					<p class="panel-copy">No provider jobs are tracked yet.</p>
				{:else}
					<div class="run-table">
						<div class="row head">
							<span>Job</span>
							<span>Status</span>
							<span>Estimate</span>
							<span>Started</span>
						</div>
						{#each recentJobs as job}
							<div class="row">
								<span>{job.name}</span>
								<span>{job.status ?? 'unknown'}</span>
								<span>{job.estimatedCostUsd == null ? '—' : `$${job.estimatedCostUsd.toFixed(2)}`}</span>
								<span>{fmtDate(job.startedAt)}</span>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		</div>
	</section>
{:else}
<div class="home">
	<section class="hero" aria-labelledby="home-title">
		<div class="hero-copy">
			<p class="eyebrow">Numerai model operations</p>
			<h1 id="home-title">Train, compare, and deploy Numerai models from one clean workspace.</h1>
			<p class="lede">
				Numerai Dashboard is an experiment console for tournament modeling. It helps you launch
				training runs, monitor live progress, compare model quality, inspect research sweeps, and
				check market context without stitching together notebooks, cloud consoles, and logs.
			</p>
			<div class="actions" aria-label="Primary actions">
				<a class="primary-action" href="/builder">Open builder</a>
				<a class="secondary-action" href="/models">View models</a>
			</div>
		</div>

		<div class="hero-panel" aria-label="Dashboard preview">
			<div class="panel-top">
				<div>
					<span class="panel-label">Live run</span>
					<strong>challenger-run-042</strong>
				</div>
				<span class="status">training</span>
			</div>
			<div class="metric-grid">
				{#each stats as stat}
					<div class="metric">
						<span>{stat.label}</span>
						<strong>{stat.value}</strong>
					</div>
				{/each}
			</div>
			<div class="run-table" aria-hidden="true">
				<div class="row head">
					<span>Model</span>
					<span>Corr</span>
					<span>MMC</span>
					<span>Status</span>
				</div>
				<div class="row">
					<span>Challenger</span>
					<span>0.0118</span>
					<span>0.0040</span>
					<span class="good">best</span>
				</div>
				<div class="row">
					<span>Ensemble</span>
					<span>0.0047</span>
					<span>0.0027</span>
					<span>verify</span>
				</div>
				<div class="row">
					<span>Baseline</span>
					<span>0.0069</span>
					<span>0.0012</span>
					<span>ready</span>
				</div>
			</div>
		</div>
	</section>

	<section class="explainer" aria-labelledby="what-title">
		<div>
			<p class="section-kicker">What it offers</p>
			<h2 id="what-title">A purpose-built command center for Numerai research.</h2>
		</div>
		<p>
			The app brings together the parts of the modeling loop that usually live in separate places:
			cloud training setup, experiment tracking, validation analysis, deployment controls, and
			market reference data. It is meant for fast iteration when you are trying to understand which
			model family, target set, neutralization level, and compute budget deserves another run.
		</p>
	</section>

	<section class="provider-flow" aria-labelledby="provider-flow-title">
		<div class="flow-copy">
			<p class="section-kicker">Provider flow</p>
			<h2 id="provider-flow-title">Pick a test. Route it to the best compute.</h2>
			<p>
				Numerai Dashboard is built around a provider-agnostic training path: choose a model
				test, select compute, launch the run, and review the result in the same workspace.
			</p>
		</div>

		<div class="flow-board">
			<div class="provider-list" aria-label="Compute providers">
				{#each providerFlow as provider}
					<button
						type="button"
						class:active={activeProviderId === provider.id}
						onclick={() => (activeProviderId = provider.id)}
					>
						<span>{provider.status}</span>
						<strong>{provider.name}</strong>
						<small>{provider.tag}</small>
					</button>
				{/each}
			</div>

			<div class="flow-diagram" aria-live="polite">
				<div class="flow-node source">
					<span>Input</span>
					<strong>Numerai data</strong>
					<small>features, targets, rounds</small>
				</div>
				<div class="flow-arrow" aria-hidden="true"></div>
				<div class="flow-node selected">
					<span>Compute</span>
					<strong>{activeProvider.name}</strong>
					<small>{activeProvider.latency}</small>
				</div>
				<div class="flow-arrow" aria-hidden="true"></div>
				<div class="flow-node source">
					<span>Output</span>
					<strong>Tracked result</strong>
					<small>metrics, cost, artifacts</small>
				</div>
			</div>

			<div class="test-panel">
				<div class="test-head">
					<span>One-click tests</span>
					<strong>{activeTest.name}</strong>
					<p>{activeTest.body}</p>
				</div>
				<div class="test-buttons" aria-label="Model test templates">
					{#each testTemplates as template}
						<button
							type="button"
							class:active={activeTestId === template.id}
							onclick={() => (activeTestId = template.id)}
						>
							{template.name}
							<span>{template.runtime}</span>
						</button>
					{/each}
				</div>
				<div class="selected-route">
					<span>Selected route</span>
					<strong>{activeTest.name} → {activeProvider.name}</strong>
					<p>{activeProvider.body}</p>
				</div>
			</div>
		</div>
	</section>

	<section class="module-grid" aria-label="Product modules">
		{#each modules as module}
			<a class="module-card" href={module.href}>
				<span>{module.kicker}</span>
				<h3>{module.title}</h3>
				<p>{module.body}</p>
				<strong>{module.cta}</strong>
			</a>
		{/each}
	</section>

	<section class="workflow" aria-labelledby="workflow-title">
		<div class="workflow-head">
			<p class="section-kicker">Workflow</p>
			<h2 id="workflow-title">From config to submission signal.</h2>
		</div>
		<div class="workflow-list">
			{#each workflow as item}
				<article>
					<span>{item.step}</span>
					<h3>{item.title}</h3>
					<p>{item.body}</p>
				</article>
			{/each}
		</div>
	</section>
</div>
{/if}

<GitHubClonePrompt />

<style>
	.dashboard-page {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		padding: 2rem 0 4rem;
	}

	.dashboard-head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 2rem;
		padding-bottom: 2rem;
		border-bottom: 1px solid var(--border-light);
	}

	.head-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.6rem;
	}

	.dashboard-head h1 {
		max-width: 12ch;
		margin: 0.8rem 0 1rem;
	}

	.connection-grid,
	.dashboard-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}

	.status-card,
	.ops-panel {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: #fff;
		color: var(--text);
		text-decoration: none;
		box-shadow: var(--shadow-sm);
	}

	.status-card {
		display: block;
		padding: 1rem;
		border-left: 4px solid #d1242f;
	}

	.status-card.good {
		border-left-color: var(--green);
	}

	.status-card span,
	.panel-title span,
	.muted {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.status-card strong,
	.panel-title strong {
		display: block;
		margin-top: 0.35rem;
		font-size: 1.25rem;
	}

	.status-card p,
	.panel-copy {
		margin: 0.65rem 0 0;
		color: var(--text-secondary);
		line-height: 1.6;
	}

	.ops-panel {
		overflow: hidden;
	}

	.ops-panel.wide {
		grid-column: span 2;
	}

	.panel-title {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.15rem;
		border-bottom: 1px solid var(--border-light);
	}

	.panel-title a {
		color: var(--text-secondary);
		font-size: 0.86rem;
		font-weight: 700;
		text-decoration: none;
	}

	.panel-copy {
		padding: 0 1.15rem 1.15rem;
	}

	.home {
		display: flex;
		flex-direction: column;
		gap: 5rem;
		padding: 2.5rem 0 5rem;
	}

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1.04fr) minmax(340px, 0.72fr);
		gap: 3rem;
		align-items: center;
		min-height: min(690px, calc(100vh - 8rem));
		border-bottom: 1px solid var(--border-light);
		padding-bottom: 4rem;
	}

	.hero-copy {
		max-width: 780px;
	}

	.eyebrow,
	.section-kicker,
	.panel-label,
	.module-card > span,
	.metric span {
		display: block;
		margin: 0;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	h1 {
		max-width: 17ch;
		margin: 0.9rem 0 1.2rem;
		color: var(--text);
		font-size: clamp(2.65rem, 5.8vw, 4.9rem);
		font-weight: 760;
		letter-spacing: 0;
		line-height: 0.96;
	}

	.lede {
		max-width: 66ch;
		margin: 0;
		color: var(--text-secondary);
		font-size: 1.08rem;
		line-height: 1.75;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 2rem;
	}

	.primary-action,
	.secondary-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 2.75rem;
		padding: 0 1.05rem;
		border: 1px solid var(--text);
		border-radius: 6px;
		font-size: 0.92rem;
		font-weight: 700;
		font-family: inherit;
		text-decoration: none;
		cursor: pointer;
		transition:
			background 0.15s ease,
			color 0.15s ease,
			transform 0.15s ease,
			border-color 0.15s ease;
	}

	.primary-action {
		background: var(--text);
		color: #fff;
	}

	.secondary-action {
		background: #fff;
		color: var(--text);
	}

	.secondary-action:disabled {
		cursor: not-allowed;
		opacity: 0.65;
		transform: none;
	}

	.primary-action:hover,
	.secondary-action:hover {
		transform: translateY(-1px);
	}

	.secondary-action:hover {
		border-color: var(--border-strong);
		background: var(--hover-bg);
	}

	.hero-panel {
		border: 1px solid var(--border);
		border-radius: 8px;
		background:
			linear-gradient(#fff, #fff) padding-box,
			linear-gradient(135deg, rgba(17, 24, 39, 0.18), rgba(34, 197, 94, 0.28), rgba(245, 158, 11, 0.22)) border-box;
		box-shadow: var(--shadow-lg);
		overflow: hidden;
	}

	.panel-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.15rem;
		border-bottom: 1px solid var(--border-light);
	}

	.panel-top strong {
		display: block;
		margin-top: 0.3rem;
		font-size: 1rem;
	}

	.status {
		border: 1px solid rgba(26, 127, 55, 0.22);
		border-radius: 999px;
		background: var(--badge-green);
		color: var(--green);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 700;
		padding: 0.25rem 0.5rem;
		text-transform: uppercase;
	}

	.metric-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		border-bottom: 1px solid var(--border-light);
	}

	.metric {
		min-width: 0;
		padding: 1rem 1.15rem;
		border-right: 1px solid var(--border-light);
	}

	.metric:last-child {
		border-right: none;
	}

	.metric strong {
		display: block;
		margin-top: 0.35rem;
		font-size: 1.75rem;
		font-weight: 760;
		font-variant-numeric: tabular-nums;
	}

	.run-table {
		padding: 0.35rem 0;
	}

	.row {
		display: grid;
		grid-template-columns: 1.1fr 0.8fr 0.8fr 0.8fr;
		gap: 0.75rem;
		padding: 0.75rem 1.15rem;
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 0.78rem;
		border-top: 1px solid transparent;
	}

	.row:not(.head) {
		border-top-color: var(--border-light);
	}

	.row.head {
		color: var(--text-muted);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.good {
		color: var(--green);
		font-weight: 700;
	}

	.explainer {
		display: grid;
		grid-template-columns: minmax(220px, 0.8fr) minmax(0, 1.2fr);
		gap: 2rem;
		align-items: start;
	}

	h2 {
		margin: 0.55rem 0 0;
		color: var(--text);
		font-size: clamp(1.8rem, 4vw, 3.5rem);
		font-weight: 740;
		letter-spacing: 0;
		line-height: 1;
	}

	.explainer > p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 1rem;
		line-height: 1.8;
	}

	.provider-flow {
		display: grid;
		grid-template-columns: minmax(240px, 0.62fr) minmax(0, 1.38fr);
		gap: 2rem;
		align-items: start;
	}

	.flow-copy {
		position: sticky;
		top: 7rem;
	}

	.flow-copy p:not(.section-kicker) {
		margin: 1rem 0 0;
		color: var(--text-secondary);
		font-size: 0.98rem;
		line-height: 1.75;
	}

	.flow-board {
		display: grid;
		grid-template-columns: minmax(180px, 0.72fr) minmax(260px, 1fr) minmax(220px, 0.88fr);
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		box-shadow: var(--shadow-md);
		overflow: hidden;
	}

	.provider-list {
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--border-light);
	}

	.provider-list button,
	.test-buttons button {
		border: none;
		background: transparent;
		color: var(--text);
		cursor: pointer;
		font: inherit;
		text-align: left;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}

	.provider-list button {
		display: grid;
		gap: 0.3rem;
		min-height: 6.3rem;
		padding: 1rem;
		border-bottom: 1px solid var(--border-light);
	}

	.provider-list button:last-child {
		border-bottom: none;
	}

	.provider-list button:hover,
	.provider-list button.active,
	.test-buttons button:hover,
	.test-buttons button.active {
		background: var(--hover-bg);
	}

	.provider-list button.active {
		box-shadow: inset 3px 0 0 var(--text);
	}

	.provider-list span,
	.test-head span,
	.selected-route span,
	.flow-node span,
	.test-buttons button span {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.provider-list strong {
		font-size: 0.95rem;
		font-weight: 760;
	}

	.provider-list small,
	.flow-node small {
		color: var(--text-secondary);
		font-size: 0.78rem;
		line-height: 1.35;
	}

	.flow-diagram {
		display: flex;
		min-height: 34rem;
		flex-direction: column;
		align-items: stretch;
		justify-content: center;
		gap: 1rem;
		padding: 1.2rem;
		background:
			linear-gradient(rgba(23, 23, 23, 0.035) 1px, transparent 1px),
			linear-gradient(90deg, rgba(23, 23, 23, 0.035) 1px, transparent 1px),
			#fff;
		background-size: 28px 28px;
	}

	.flow-node {
		display: grid;
		gap: 0.35rem;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.92);
		box-shadow: var(--shadow-sm);
	}

	.flow-node strong {
		font-size: 1.15rem;
		font-weight: 760;
	}

	.flow-node.selected {
		border-color: var(--text);
		box-shadow: 0 16px 38px rgba(23, 23, 23, 0.12);
	}

	.flow-arrow {
		position: relative;
		width: 1px;
		height: 2.5rem;
		margin: 0 auto;
		background: var(--border);
	}

	.flow-arrow::after {
		position: absolute;
		bottom: -1px;
		left: 50%;
		width: 0.45rem;
		height: 0.45rem;
		border-right: 1px solid var(--border-strong);
		border-bottom: 1px solid var(--border-strong);
		content: '';
		transform: translateX(-50%) rotate(45deg);
	}

	.test-panel {
		display: flex;
		flex-direction: column;
		border-left: 1px solid var(--border-light);
	}

	.test-head,
	.selected-route {
		padding: 1rem;
	}

	.test-head {
		border-bottom: 1px solid var(--border-light);
	}

	.test-head strong,
	.selected-route strong {
		display: block;
		margin-top: 0.45rem;
		font-size: 1.15rem;
		font-weight: 760;
		line-height: 1.15;
	}

	.test-head p,
	.selected-route p {
		margin: 0.75rem 0 0;
		color: var(--text-secondary);
		font-size: 0.88rem;
		line-height: 1.6;
	}

	.test-buttons {
		display: grid;
		border-bottom: 1px solid var(--border-light);
	}

	.test-buttons button {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.85rem 1rem;
		border-bottom: 1px solid var(--border-light);
		font-size: 0.88rem;
		font-weight: 720;
	}

	.test-buttons button:last-child {
		border-bottom: none;
	}

	.test-buttons button.active {
		box-shadow: inset 3px 0 0 var(--green);
	}

	.selected-route {
		margin-top: auto;
		background: var(--badge-green);
		border-top: 1px solid rgba(26, 127, 55, 0.16);
	}

	.module-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		overflow: hidden;
	}

	.module-card {
		display: flex;
		min-height: 290px;
		flex-direction: column;
		padding: 1.35rem;
		color: inherit;
		text-decoration: none;
		border-right: 1px solid var(--border-light);
		transition:
			background 0.15s ease,
			transform 0.15s ease;
	}

	.module-card:last-child {
		border-right: none;
	}

	.module-card:hover {
		background: var(--hover-bg);
		transform: translateY(-1px);
	}

	.module-card h3,
	.workflow article h3 {
		margin: 1.15rem 0 0.7rem;
		color: var(--text);
		font-size: 1.35rem;
		font-weight: 720;
		letter-spacing: 0;
		line-height: 1.1;
	}

	.module-card p,
	.workflow article p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.93rem;
		line-height: 1.65;
	}

	.module-card strong {
		margin-top: auto;
		padding-top: 1.5rem;
		color: var(--text);
		font-size: 0.88rem;
	}

	.workflow {
		display: grid;
		grid-template-columns: minmax(220px, 0.72fr) minmax(0, 1.28fr);
		gap: 2rem;
		align-items: start;
	}

	.workflow-list {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		overflow: hidden;
	}

	.workflow article {
		min-height: 220px;
		padding: 1.2rem;
		border-right: 1px solid var(--border-light);
		border-bottom: 1px solid var(--border-light);
	}

	.workflow article:nth-child(2n) {
		border-right: none;
	}

	.workflow article:nth-last-child(-n + 2) {
		border-bottom: none;
	}

	.workflow article > span {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.8rem;
		font-weight: 800;
	}

	@media (max-width: 980px) {
		.dashboard-head {
			display: grid;
			align-items: start;
		}

		.connection-grid,
		.dashboard-grid {
			grid-template-columns: 1fr;
		}

		.ops-panel.wide {
			grid-column: span 1;
		}

		.home {
			gap: 3.5rem;
			padding-top: 1.25rem;
		}

		.hero,
		.explainer,
		.provider-flow,
		.workflow {
			grid-template-columns: 1fr;
		}

		.flow-copy {
			position: static;
		}

		.flow-board {
			grid-template-columns: 1fr;
		}

		.provider-list {
			display: grid;
			grid-template-columns: repeat(5, minmax(10rem, 1fr));
			border-right: none;
			border-bottom: 1px solid var(--border-light);
			overflow-x: auto;
		}

		.provider-list button {
			min-height: 0;
			border-right: 1px solid var(--border-light);
			border-bottom: none;
		}

		.provider-list button:last-child {
			border-right: none;
		}

		.provider-list button.active {
			box-shadow: inset 0 -3px 0 var(--text);
		}

		.flow-diagram {
			min-height: 0;
		}

		.test-panel {
			border-left: none;
			border-top: 1px solid var(--border-light);
		}

		.hero {
			min-height: 0;
			gap: 2rem;
		}

		h1 {
			max-width: 14ch;
		}

		.module-grid {
			grid-template-columns: 1fr;
		}

		.module-card {
			min-height: 0;
			border-right: none;
			border-bottom: 1px solid var(--border-light);
		}

		.module-card:last-child {
			border-bottom: none;
		}
	}

	@media (max-width: 640px) {
		.home {
			gap: 3rem;
			padding-bottom: 3rem;
		}

		.hero {
			padding-bottom: 3rem;
		}

		h1 {
			font-size: clamp(2.35rem, 11vw, 3.5rem);
		}

		.lede,
		.explainer > p {
			font-size: 0.97rem;
		}

		.metric-grid,
		.workflow-list {
			grid-template-columns: 1fr;
		}

		.provider-list {
			grid-template-columns: 1fr;
			overflow-x: visible;
		}

		.provider-list button,
		.provider-list button:last-child {
			border-right: none;
			border-bottom: 1px solid var(--border-light);
		}

		.provider-list button:last-child {
			border-bottom: none;
		}

		.provider-list button.active {
			box-shadow: inset 3px 0 0 var(--text);
		}

		.metric,
		.workflow article,
		.workflow article:nth-child(2n),
		.workflow article:nth-last-child(-n + 2) {
			border-right: none;
			border-bottom: 1px solid var(--border-light);
		}

		.metric:last-child,
		.workflow article:last-child {
			border-bottom: none;
		}

		.row {
			grid-template-columns: 1fr 0.75fr 0.75fr;
		}

		.row span:last-child {
			display: none;
		}
	}
</style>
