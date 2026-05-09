<script lang="ts">
	const modules = [
		{
			kicker: 'ML',
			title: 'Train Numerai models',
			body: 'Launch baseline, challenger, ensemble, and deep-learning experiments on managed compute or local runners.',
			href: '/ml',
			cta: 'Open ML console'
		},
		{
			kicker: 'Analysis',
			title: 'Compare what worked',
			body: 'Track correlation, MMC, Sharpe, feature exposure, drawdown, run history, validation curves, and post-run diagnostics.',
			href: '/ml',
			cta: 'Review experiments'
		},
		{
			kicker: 'Market',
			title: 'Read market context',
			body: 'Inspect price action and option-chain structure from the same workspace you use to decide model deployment timing.',
			href: '/chart',
			cta: 'Open chart'
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
</script>

<svelte:head>
	<meta
		name="description"
		content="A white, Prime-inspired operating surface for training, comparing, and deploying Numerai machine learning models."
	/>
</svelte:head>

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
				<a class="primary-action" href="/ml">Start training</a>
				<a class="secondary-action" href="/chart">View chart</a>
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

<style>
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
		max-width: 13ch;
		margin: 0.9rem 0 1.2rem;
		color: var(--text);
		font-size: clamp(3.1rem, 8vw, 6.6rem);
		font-weight: 760;
		letter-spacing: 0;
		line-height: 0.9;
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
		text-decoration: none;
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
		.home {
			gap: 3.5rem;
			padding-top: 1.25rem;
		}

		.hero,
		.explainer,
		.workflow {
			grid-template-columns: 1fr;
		}

		.hero {
			min-height: 0;
			gap: 2rem;
		}

		h1 {
			max-width: 11ch;
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
			font-size: clamp(2.8rem, 15vw, 4.4rem);
		}

		.lede,
		.explainer > p {
			font-size: 0.97rem;
		}

		.metric-grid,
		.workflow-list {
			grid-template-columns: 1fr;
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
