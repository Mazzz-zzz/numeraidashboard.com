<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		api,
		type MlRunData,
		type MlEpochMetric,
		type MlExperimentData,
		type TrainRequest
	} from '$lib/api';
	import { addToast } from '$lib/stores';
	import {
		mlOverview,
		loadMlOverview,
		mlExperiments,
		mlModels,
		loadMlModels,
		mlRounds,
		loadMlRounds,
		triggerTraining,
		startPolling,
		stopPolling,
		setMetricsRefreshCallback
	} from '$lib/ml-stores';
	import MetricCard from '$lib/components/ml/MetricCard.svelte';
	import LossChart from '$lib/components/ml/LossChart.svelte';
	import ModelComparisonChart from '$lib/components/ml/ModelComparisonChart.svelte';
	import TrainingProgress from '$lib/components/ml/TrainingProgress.svelte';
	import MlAnalysis from '$lib/components/ml/MlAnalysis.svelte';

	let activeTab = $state<'overview' | 'deploy' | 'experiments' | 'models' | 'rounds' | 'analysis'>('overview');
	let loading = $state(false);
	let error = $state<string | null>(null);

	// Experiments tab state
	let expandedExp = $state<number | null>(null);
	let expRuns = $state<MlRunData[]>([]);
	let expRunsLoading = $state(false);

	// Overview tab state
	let selectedRunId = $state<number | null>(null);
	let epochMetrics = $state<MlEpochMetric[]>([]);
	let metricsLoading = $state(false);
	let metricsError = $state<string | null>(null);

	// Deploy tab state
	let deployExpName = $state('');
	let deployDescription = $state('');
	let deployFeatureSet = $state('medium');
	let deployInstanceType = $state('ml.m5.xlarge');
	let deployModelType = $state('lgbm');
	let deployUpload = $state(false);
	let deployNeutralizationPct = $state(50);
	let deployHyperparams = $state('{}');
	let deployLoading = $state(false);

	// History of past hyperparams from completed runs
	let paramHistory = $derived.by(() => {
		const runs = $mlOverview?.recent_runs ?? [];
		return runs
			.filter((r: MlRunData) => r.hyperparams_json)
			.slice(0, 10)
			.map((r: MlRunData) => ({
				label: `Run #${r.id} — ${r.model_type} (${r.status})`,
				json: r.hyperparams_json!,
			}));
	});

	// Default hyperparams per model type
	// Available Numerai targets (v5.2 Faith II)
	const ALL_TARGETS = [
		"target", "target_agnes_20", "target_alpha_20", "target_bravo_20",
		"target_caroline_20", "target_charlie_20", "target_claudia_20", "target_cyrusd_20",
		"target_delta_20", "target_echo_20", "target_ender_20", "target_jasper_20",
		"target_jeremy_20", "target_ralph_20", "target_rowan_20", "target_sam_20",
		"target_teager2b_20", "target_tyler_20", "target_victor_20", "target_waldo_20",
		"target_xerxes_20",
	];

	const modelDefaults: Record<string, Record<string, unknown>> = {
		lgbm: {
			learning_rate: 0.005, num_rounds: 10000, num_leaves: 512,
			max_depth: 8, feature_fraction: 0.1, bagging_fraction: 0.5,
			early_stopping_rounds: 200, multi_target_enabled: true,
			target_cols: ALL_TARGETS,
			max_train_eras: 400, enable_era_stats: true, enable_group_aggregates: true,
		},
		catboost: {
			learning_rate: 0.005, iterations: 10000, depth: 8,
			l2_leaf_reg: 3.0, bagging_temperature: 0.5,
			early_stopping_rounds: 200, multi_target_enabled: true,
			target_cols: ALL_TARGETS,
			max_train_eras: 400, enable_era_stats: true, enable_group_aggregates: true,
		},
		mlp: {
			learning_rate: 0.001, hidden_dims: "512,512,512",
			dropout: 0.1, weight_decay: 0.0001, noise_std: 0.05,
			batch_size: 8192, mixup_alpha: 0.0, swa: false,
			warmup_epochs: 0, multi_head: false, multi_target_enabled: true,
			target_cols: ALL_TARGETS,
			max_train_eras: 400, enable_era_stats: true, enable_group_aggregates: true,
		},
		ft_transformer: {
			learning_rate: 0.0001, d_token: 192, n_blocks: 3, n_heads: 8,
			attn_dropout: 0.2, ff_dropout: 0.1, noise_std: 0.05,
			weight_decay: 0.001, batch_size: 1024, multi_target_enabled: true,
			target_cols: ALL_TARGETS,
			max_train_eras: 400, enable_era_stats: true, enable_group_aggregates: true,
		},
		tabm: {
			learning_rate: 0.001, n_ensemble: 16, hidden_dims: "512,512,512",
			dropout: 0.1, weight_decay: 0.0001, noise_std: 0.05,
			batch_size: 8192, multi_target_enabled: true,
			target_cols: ALL_TARGETS,
			max_train_eras: 400, enable_era_stats: true, enable_group_aggregates: true,
		},
		modern_nca: {
			learning_rate: 0.001, hidden_dims: "512,512", d_embedding: 128,
			n_neighbors: 64, dropout: 0.1, weight_decay: 0.0001,
			noise_std: 0.05, batch_size: 4096, multi_target_enabled: true,
			target_cols: ALL_TARGETS,
			max_train_eras: 400, enable_era_stats: true, enable_group_aggregates: true,
		},
		tabpfn: {
			n_bags: 8, context_rows: 10000, features_per_bag: 500,
			n_recent_eras: 24, n_estimators_per_bag: 4,
			multi_target_enabled: true, target_cols: ALL_TARGETS,
			max_train_eras: 400,
			enable_era_stats: true, enable_group_aggregates: true,
		},
		tabicl: {
			n_bags: 8, context_rows: 10000, features_per_bag: 42,
			n_recent_eras: 24, n_estimators_per_bag: 8,
			multi_target_enabled: true, target_cols: ALL_TARGETS,
			max_train_eras: 400,
			enable_era_stats: true, enable_group_aggregates: true,
		},
	};

	// Auto-populate defaults when model type changes
	$effect(() => {
		const defaults = modelDefaults[deployModelType];
		if (defaults) {
			deployHyperparams = JSON.stringify(defaults, null, 2);
		}
	});

	// Estimated cost
	const instanceRates: Record<string, { rate: number; spec: string }> = {
		// SageMaker CPU
		'ml.m5.large': { rate: 0.134, spec: '2 vCPU, 8 GB' },
		'ml.m5.xlarge': { rate: 0.269, spec: '4 vCPU, 16 GB' },
		'ml.m5.2xlarge': { rate: 0.538, spec: '8 vCPU, 32 GB' },
		'ml.m5.4xlarge': { rate: 1.075, spec: '16 vCPU, 64 GB' },
		'ml.m5.12xlarge': { rate: 3.226, spec: '48 vCPU, 192 GB' },
		'ml.c5.xlarge': { rate: 0.235, spec: '4 vCPU, 8 GB' },
		'ml.c5.2xlarge': { rate: 0.470, spec: '8 vCPU, 16 GB' },
		// Modal GPU
		'modal:t4': { rate: 0.59, spec: 'T4 16 GB GPU' },
		'modal:a10g': { rate: 1.10, spec: 'A10G 24 GB GPU' },
		'modal:l4': { rate: 0.80, spec: 'L4 24 GB GPU' },
		'modal:a100': { rate: 3.00, spec: 'A100 40 GB GPU' },
		'modal:a100-80gb': { rate: 3.73, spec: 'A100 80 GB GPU' },
		'modal:h100': { rate: 4.41, spec: 'H100 80 GB GPU' },
	};
	let estimatedCost = $derived.by(() => {
		const info = instanceRates[deployInstanceType];
		if (!info) return null;
		const minutes = deployFeatureSet === 'small' ? 15 : deployFeatureSet === 'medium' ? 30 : 60;
		return {
			low: (info.rate * minutes / 60).toFixed(2),
			high: (info.rate * minutes * 1.5 / 60).toFixed(2),
			minutes
		};
	});

	async function handleDeploy() {
		if (!deployExpName.trim()) return;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(deployHyperparams);
		} catch {
			addToast('Invalid JSON in hyperparameters', 'error');
			return;
		}
		deployLoading = true;
		try {
			const config: TrainRequest = {
				experiment_name: deployExpName.trim(),
				feature_set: deployFeatureSet,
				model_type: deployModelType,
				instance_type: deployInstanceType,
				upload: deployUpload,
				neutralization_pct: deployNeutralizationPct,
				hyperparams: parsed,
			};
			if (deployDescription.trim()) {
				config.description = deployDescription.trim();
			}
			const result = await triggerTraining(config, 'classic');
			if (deployInstanceType.startsWith('local:')) {
				const jobName = result.sagemaker_job_name;
				addToast(`Local run created: ${jobName}. Run on your GPU:\npython3.11 sagemaker/local_runner.py --job-name ${jobName} --feature-set ${deployFeatureSet} --model-type ${deployModelType} --gpu ${deployInstanceType.split(':')[1]}`, 'success');
			} else {
				addToast(`Training started: Run #${result.run_id}`, 'success');
			}
			activeTab = 'overview';
			await loadMlOverview('classic');
		} catch (e) {
			addToast(e instanceof Error ? e.message : 'Failed to start training', 'error');
		} finally {
			deployLoading = false;
		}
	}

	/** Silently refresh metrics for the selected run (called by polling). */
	async function refreshSelectedMetrics() {
		if (selectedRunId === null) return;
		try {
			const res = await api.getMlRunMetrics(selectedRunId);
			epochMetrics = res.data;
		} catch {
			// Silent — don't toast on background refresh failures
		}
	}

	onMount(async () => {
		loading = true;
		setMetricsRefreshCallback(refreshSelectedMetrics);
		try {
			await Promise.all([
				loadMlOverview('classic'),
				mlExperiments.refresh('classic'),
				loadMlModels('classic'),
				loadMlRounds('classic')
			]);
			// Auto-start polling if there are active runs
			if (($mlOverview?.active_runs ?? 0) > 0) {
				startPolling('classic');
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load ML data';
			addToast(error!, 'error');
		} finally {
			loading = false;
		}
	});

	onDestroy(() => {
		setMetricsRefreshCallback(null);
		stopPolling();
	});

	async function handleCancelRun(runId: number) {
		try {
			await api.cancelTraining(runId);
			addToast(`Run #${runId} cancelled`, 'success');
			await loadMlOverview('classic');
		} catch (e) {
			addToast(e instanceof Error ? e.message : 'Failed to cancel run', 'error');
		}
	}

	async function toggleExperiment(exp: MlExperimentData) {
		if (expandedExp === exp.id) {
			expandedExp = null;
			expRuns = [];
			return;
		}
		expandedExp = exp.id;
		expRunsLoading = true;
		try {
			const res = await api.getMlRuns(exp.id);
			expRuns = res.data;
		} catch {
			expRuns = [];
		} finally {
			expRunsLoading = false;
		}
	}

	async function loadRunMetrics(runId: number) {
		selectedRunId = runId;
		metricsLoading = true;
		metricsError = null;
		epochMetrics = [];
		try {
			const res = await api.getMlRunMetrics(runId);
			epochMetrics = res.data;
		} catch (e) {
			metricsError = e instanceof Error ? e.message : `Failed to load metrics for run #${runId}`;
			addToast(metricsError, 'error');
		} finally {
			metricsLoading = false;
		}
	}

	async function promoteModel(modelId: number, stage: string) {
		try {
			await api.updateMlModel(modelId, { stage });
			await loadMlModels('classic');
			addToast(`Model promoted to ${stage}`, 'success');
		} catch (e) {
			addToast(e instanceof Error ? e.message : 'Failed to promote model', 'error');
		}
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'completed':
			case 'resolved':
				return 'var(--green)';
			case 'running':
			case 'pending':
				return 'var(--blue)';
			case 'failed':
				return 'var(--red)';
			default:
				return 'var(--text-muted)';
		}
	}

	function stageColor(stage: string): string {
		switch (stage) {
			case 'prod':
				return 'var(--green)';
			case 'staging':
				return 'var(--orange)';
			default:
				return 'var(--text-muted)';
		}
	}

	function stageBadgeBg(stage: string): string {
		switch (stage) {
			case 'prod':
				return 'var(--badge-green)';
			case 'staging':
				return 'var(--badge-orange)';
			default:
				return 'var(--badge-muted)';
		}
	}

	function fmt(v: number | null, decimals = 4): string {
		if (v === null) return '\u2014';
		return v.toFixed(decimals);
	}
</script>

<div class="ml-page">
	<header>
		<h1>Numerai Classic</h1>
		{#if loading}
			<span class="loading-indicator">Loading...</span>
		{/if}
	</header>

	{#if error}
		<p class="error">{error}</p>
	{/if}

	<div class="tabs">
		<button class:active={activeTab === 'overview'} onclick={() => (activeTab = 'overview')}>Overview</button>
		<button class:active={activeTab === 'deploy'} onclick={() => (activeTab = 'deploy')}>Deploy</button>
		<button class:active={activeTab === 'experiments'} onclick={() => (activeTab = 'experiments')}>Experiments</button>
		<button class:active={activeTab === 'models'} onclick={() => (activeTab = 'models')}>Models</button>
		<button class:active={activeTab === 'rounds'} onclick={() => (activeTab = 'rounds')}>Rounds</button>
		<button class:active={activeTab === 'analysis'} onclick={() => (activeTab = 'analysis')}>Analysis</button>
	</div>

	<!-- Overview Tab -->
	{#if activeTab === 'overview'}
		<div class="cards">
			<MetricCard
				label="Active Runs"
				value={$mlOverview?.active_runs?.toString() ?? '0'}
				sub="Currently training"
				color={($mlOverview?.active_runs ?? 0) > 0 ? 'var(--blue)' : ''}
			/>
			<MetricCard
				label="Best Correlation"
				value={$mlOverview?.best_model ? fmt($mlOverview.best_model.correlation, 4) : '\u2014'}
				sub={$mlOverview?.best_model?.name ?? 'No production model'}
				color="var(--green)"
			/>
			<MetricCard
				label="Best Sharpe"
				value={$mlOverview?.best_model ? fmt($mlOverview.best_model.sharpe, 2) : '\u2014'}
				sub={$mlOverview?.best_model?.name ?? 'No production model'}
				color="var(--blue)"
			/>
			<MetricCard
				label="MMC"
				value={$mlOverview?.best_model ? fmt($mlOverview.best_model.mmc, 4) : '\u2014'}
				sub={$mlOverview?.best_model?.name ?? 'No production model'}
				color={($mlOverview?.best_model?.mmc ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'}
			/>
			<MetricCard
				label="Est. Payout"
				value={$mlOverview?.best_model?.correlation != null && $mlOverview?.best_model?.mmc != null
					? (0.75 * $mlOverview.best_model.correlation + 2.25 * $mlOverview.best_model.mmc).toFixed(4)
					: '\u2014'}
				sub="0.75 CORR + 2.25 MMC"
				color={$mlOverview?.best_model?.correlation != null && $mlOverview?.best_model?.mmc != null
					? (0.75 * $mlOverview.best_model.correlation + 2.25 * $mlOverview.best_model.mmc) >= 0 ? 'var(--green)' : 'var(--red)'
					: ''}
			/>
			<MetricCard
				label="Max Drawdown"
				value={$mlOverview?.best_model ? fmt($mlOverview.best_model.max_drawdown, 4) : '\u2014'}
				sub={$mlOverview?.best_model?.name ?? 'No production model'}
				color="var(--red)"
			/>
			<MetricCard
				label="Total Cost"
				value={$mlOverview ? `$${$mlOverview.total_cost_usd.toFixed(2)}` : '\u2014'}
				sub="Last 10 runs"
				color="var(--orange)"
			/>
			<MetricCard
				label="Latest Round"
				value={$mlOverview?.latest_round ? `#${$mlOverview.latest_round.round_number}` : '\u2014'}
				sub={$mlOverview?.latest_round?.status ?? 'No submissions'}
			/>
		</div>

		{#if $mlOverview?.recent_runs}
			<TrainingProgress runs={$mlOverview.recent_runs} oncancel={handleCancelRun} />
		{/if}

		{#if $mlOverview?.recent_runs && $mlOverview.recent_runs.length > 0}
			<div class="section">
				<h2>Recent Runs</h2>
				<div class="table-wrapper">
					<table>
						<thead>
							<tr>
								<th>ID</th>
								<th>Model Type</th>
								<th>Status</th>
								<th class="num">Corr</th>
								<th class="num">MMC</th>
								<th class="num">Payout</th>
								<th class="num">Sharpe</th>
								<th class="num">Feat Exp</th>
								<th class="num">Max DD</th>
								<th>Instance</th>
								<th class="num">Cost</th>
								<th>Started</th>
							</tr>
						</thead>
						<tbody>
							{#each $mlOverview.recent_runs as run}
								<tr class="clickable" onclick={() => loadRunMetrics(run.id)}>
									<td class="mono">#{run.id}</td>
									<td>{run.model_type}</td>
									<td><span class="status-dot" style="color: {statusColor(run.status)}">{run.status}</span></td>
									<td class="num">{fmt(run.correlation)}</td>
									<td class="num">{fmt(run.mmc)}</td>
									<td class="num" style="color: {run.correlation != null && run.mmc != null ? ((0.75 * run.correlation + 2.25 * run.mmc) >= 0 ? 'var(--green)' : 'var(--red)') : ''}">{run.correlation != null && run.mmc != null ? (0.75 * run.correlation + 2.25 * run.mmc).toFixed(4) : '\u2014'}</td>
									<td class="num">{fmt(run.sharpe, 2)}</td>
									<td class="num">{fmt(run.feature_exposure)}</td>
									<td class="num">{fmt(run.max_drawdown)}</td>
									<td class="dim">{run.instance_type ?? '\u2014'}</td>
									<td class="num">{run.cost_usd !== null ? `$${run.cost_usd.toFixed(2)}` : '\u2014'}</td>
									<td class="dim">{run.started_at || '\u2014'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}

		{#if selectedRunId !== null}
			<div class="section">
				<h2>Loss Curve &mdash; Run #{selectedRunId}</h2>
				{#if metricsLoading}
					<p class="placeholder">Loading metrics...</p>
				{:else if metricsError}
					<div class="error-box">{metricsError}</div>
				{:else}
					<LossChart metrics={epochMetrics} />
				{/if}
			</div>
		{/if}

	<!-- Deploy Tab -->
	{:else if activeTab === 'deploy'}
		<form class="deploy-form" onsubmit={(e) => { e.preventDefault(); handleDeploy(); }}>
			<div class="deploy-section">
				<h2>Run Configuration</h2>
				<div class="field-grid">
					<label>
						<span>Experiment Name</span>
						<input type="text" bind:value={deployExpName} placeholder="e.g. baseline-v3" required />
					</label>
					<label>
						<span>Description</span>
						<input type="text" bind:value={deployDescription} placeholder="Optional" />
					</label>
					<label>
						<span>Feature Set</span>
						<select bind:value={deployFeatureSet}>
							<option value="small">Small (42 features)</option>
							<option value="medium">Medium (705 features)</option>
							<option value="all">All (2376 features)</option>
						</select>
					</label>
					<label>
						<span>Model Type</span>
						<select bind:value={deployModelType}>
							<option value="lgbm">LightGBM</option>
							<option value="catboost">CatBoost</option>
							<option value="mlp">MLP</option>
							<option value="ft_transformer">FT-Transformer</option>
							<option value="tabm">TabM (BatchEnsemble)</option>
							<option value="modern_nca">ModernNCA (Retrieval)</option>
							<option value="tabpfn">TabPFN v2.5 (In-Context)</option>
							<option value="tabicl">TabICL v2 (In-Context)</option>
						</select>
					</label>
					<label>
						<span>Instance Type</span>
						<select bind:value={deployInstanceType}>
							{#each Object.entries(instanceRates) as [type, info]}
								<option value={type}>{type} ({info.spec})</option>
							{/each}
						</select>
					</label>
				</div>
			</div>

			<div class="deploy-section">
				<h2>Hyperparameters (JSON)</h2>
				{#if paramHistory.length > 0}
					<div class="history-row">
						<select class="history-select" onchange={(e) => {
							const val = (e.target as HTMLSelectElement).value;
							if (val) deployHyperparams = val;
						}}>
							<option value="">Load from previous run...</option>
							{#each paramHistory as entry}
								<option value={entry.json}>{entry.label}</option>
							{/each}
						</select>
					</div>
				{/if}
				<textarea
					class="params-editor"
					bind:value={deployHyperparams}
					rows="8"
					spellcheck="false"
					placeholder={'{\n  "learning_rate": 0.005,\n  "num_rounds": 10000\n}'}
				></textarea>
			</div>

			<div class="deploy-section">
				<h2>Options</h2>
				<div class="option-grid">
					<label class="option-check">
						<input type="checkbox" bind:checked={deployUpload} />
						<span>Upload to Numerai</span>
					</label>
				</div>

				<div class="neut-inline">
					<span class="neut-label">Neutralization</span>
					<input type="range" bind:value={deployNeutralizationPct} min="0" max="100" step="5" />
					<span class="neut-value">{deployNeutralizationPct}%</span>
				</div>
			</div>

			<div class="deploy-section deploy-launch-section">
				{#if estimatedCost}
					<div class="cost-inline">
						<span>~{estimatedCost.minutes} min</span>
						<span class="cost-highlight">${estimatedCost.low}&ndash;${estimatedCost.high}</span>
						<span>${instanceRates[deployInstanceType]?.rate}/hr</span>
					</div>
				{/if}
				<button type="submit" class="launch-btn" disabled={!deployExpName.trim() || deployLoading}>
					{#if deployLoading}
						<span class="launch-spinner"></span> Launching...
					{:else}
						Launch Training
					{/if}
				</button>
			</div>
		</form>

	<!-- Experiments Tab -->
	{:else if activeTab === 'experiments'}
		<div class="section">
			{#if $mlExperiments.items.length === 0 && !$mlExperiments.loading}
				<p class="placeholder">No experiments yet. Training runs will appear here.</p>
			{:else}
				<div class="table-wrapper">
					<table>
						<thead>
							<tr>
								<th></th>
								<th>Name</th>
								<th>Status</th>
								<th class="num">Runs</th>
								<th class="num">Best Corr</th>
								<th>Created</th>
							</tr>
						</thead>
						<tbody>
							{#each $mlExperiments.items as exp}
								<tr class="clickable" onclick={() => toggleExperiment(exp)}>
									<td class="expand-icon">{expandedExp === exp.id ? '\u25BC' : '\u25B6'}</td>
									<td class="mono">{exp.name}</td>
									<td><span class="status-dot" style="color: {statusColor(exp.status)}">{exp.status}</span></td>
									<td class="num">{exp.run_count}</td>
									<td class="num">{fmt(exp.best_corr)}</td>
									<td class="dim">{exp.created_at}</td>
								</tr>

								{#if expandedExp === exp.id}
									<tr class="expanded-row">
										<td colspan="6">
											{#if expRunsLoading}
												<p class="loading-text">Loading runs...</p>
											{:else if expRuns.length === 0}
												<p class="loading-text">No runs in this experiment</p>
											{:else}
												<div class="inner-table-wrapper">
													<table class="inner-table">
														<thead>
															<tr>
																<th>ID</th>
																<th>Type</th>
																<th>Status</th>
																<th class="num">Corr</th>
																<th class="num">MMC</th>
																<th class="num">Sharpe</th>
																<th class="num">Feat Exp</th>
																<th class="num">Max DD</th>
																<th class="num">Cost</th>
																<th>Hyperparams</th>
															</tr>
														</thead>
														<tbody>
															{#each expRuns as run}
																<tr>
																	<td class="mono">#{run.id}</td>
																	<td>{run.model_type}</td>
																	<td><span class="status-dot" style="color: {statusColor(run.status)}">{run.status}</span></td>
																	<td class="num">{fmt(run.correlation)}</td>
																	<td class="num">{fmt(run.mmc)}</td>
																	<td class="num">{fmt(run.sharpe, 2)}</td>
																	<td class="num">{fmt(run.feature_exposure)}</td>
																	<td class="num">{fmt(run.max_drawdown)}</td>
																	<td class="num">{run.cost_usd !== null ? `$${run.cost_usd.toFixed(2)}` : '\u2014'}</td>
																	<td class="mono params">{run.hyperparams_json ?? '\u2014'}</td>
																</tr>
															{/each}
														</tbody>
													</table>
												</div>
												<ModelComparisonChart runs={expRuns} />
											{/if}
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>

				{#if $mlExperiments.hasMore}
					<button class="load-more" onclick={() => mlExperiments.load()}>
						{$mlExperiments.loading ? 'Loading...' : 'Load More'}
					</button>
				{/if}
			{/if}
		</div>

	<!-- Models Tab -->
	{:else if activeTab === 'models'}
		<div class="section">
			{#if $mlModels.length === 0}
				<p class="placeholder">No registered models. Promote a run to create one.</p>
			{:else}
				<div class="table-wrapper">
					<table>
						<thead>
							<tr>
								<th>Name</th>
								<th>Type</th>
								<th>Stage</th>
								<th class="num">Version</th>
								<th class="num">Corr</th>
								<th class="num">MMC</th>
								<th class="num">Sharpe</th>
								<th class="num">Feat Exp</th>
								<th class="num">Max DD</th>
								<th>Actions</th>
							</tr>
						</thead>
						<tbody>
							{#each $mlModels as model}
								<tr>
									<td class="mono">{model.name}</td>
									<td>{model.model_type}</td>
									<td>
										<span class="stage-badge" style="background: {stageBadgeBg(model.stage)}; color: {stageColor(model.stage)}">
											{model.stage}
										</span>
									</td>
									<td class="num">v{model.version}</td>
									<td class="num">{fmt(model.correlation)}</td>
									<td class="num">{fmt(model.mmc)}</td>
									<td class="num">{fmt(model.sharpe, 2)}</td>
									<td class="num">{fmt(model.feature_exposure)}</td>
									<td class="num">{fmt(model.max_drawdown)}</td>
									<td class="actions">
										{#if model.stage === 'dev'}
											<button class="promote-btn staging" onclick={() => promoteModel(model.id, 'staging')}>Staging</button>
										{/if}
										{#if model.stage === 'staging'}
											<button class="promote-btn prod" onclick={() => promoteModel(model.id, 'prod')}>Prod</button>
										{/if}
										{#if model.stage === 'prod'}
											<span class="dim">In production</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

	<!-- Analysis Tab -->
	{:else if activeTab === 'analysis'}
		<MlAnalysis />

	<!-- Rounds Tab -->
	{:else if activeTab === 'rounds'}
		<div class="section">
			{#if $mlRounds.length === 0}
				<p class="placeholder">No Numerai submissions yet. Round history will appear here.</p>
			{:else}
				<div class="table-wrapper">
					<table>
						<thead>
							<tr>
								<th class="num">Round</th>
								<th>Model</th>
								<th>Status</th>
								<th class="num">Live Corr</th>
								<th class="num">Resolved Corr</th>
								<th class="num">Payout (NMR)</th>
								<th>Submitted</th>
							</tr>
						</thead>
						<tbody>
							{#each $mlRounds as round}
								<tr>
									<td class="num mono">#{round.round_number}</td>
									<td>{round.model_name}</td>
									<td><span class="status-dot" style="color: {statusColor(round.status)}">{round.status}</span></td>
									<td class="num" class:positive={round.live_corr !== null && round.live_corr > 0} class:negative={round.live_corr !== null && round.live_corr < 0}>
										{fmt(round.live_corr)}
									</td>
									<td class="num" class:positive={round.resolved_corr !== null && round.resolved_corr > 0} class:negative={round.resolved_corr !== null && round.resolved_corr < 0}>
										{fmt(round.resolved_corr)}
									</td>
									<td class="num">{round.payout_nmr !== null ? round.payout_nmr.toFixed(2) : '\u2014'}</td>
									<td class="dim">{round.submitted_at ?? '\u2014'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>

	{/if}
</div>

<style>
	.ml-page header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	h1 { font-size: 1.5rem; margin: 0; }
	h2 { font-size: 1rem; margin: 0 0 0.75rem 0; color: var(--text); }

	.loading-indicator { color: var(--text-secondary); font-size: 0.8rem; }
	.error { color: var(--red); }
	.error-box {
		color: var(--red);
		background: rgba(255, 107, 107, 0.1);
		border: 1px solid var(--red);
		border-radius: 6px;
		padding: 1rem;
		font-size: 0.85rem;
		font-family: var(--font-mono);
	}

	.tabs {
		display: flex;
		gap: 0;
		margin-bottom: 1rem;
		border-bottom: 2px solid var(--border-light);
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
	}

	.tabs::-webkit-scrollbar { display: none; }

	.tabs button {
		background: none;
		border: none;
		padding: 0.5rem 1rem;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 0.85rem;
		font-weight: 500;
		border-bottom: 2px solid transparent;
		margin-bottom: -2px;
		transition: color 0.15s, border-color 0.15s;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.tabs button:hover { color: var(--text); }
	.tabs button.active {
		color: var(--blue);
		border-bottom-color: var(--blue);
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.6rem;
		margin-bottom: 1rem;
	}

	.section { margin-bottom: 1.25rem; }
	.table-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; }

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.78rem;
	}

	th {
		text-align: left;
		padding: 0.5rem 0.875rem;
		border-bottom: 2px solid var(--border);
		color: var(--text-secondary);
		font-weight: 600;
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		white-space: nowrap;
	}

	td {
		padding: 0.45rem 0.875rem;
		border-bottom: 1px solid var(--border-light);
	}

	tr:hover { background: var(--hover-bg); }
	tr.expanded-row:hover { background: transparent; }
	tr.expanded-row td { padding: 0.75rem; background: var(--bg-page); }

	.clickable { cursor: pointer; }

	.mono {
		font-family: 'SF Mono', 'Consolas', monospace;
		font-size: 0.73rem;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.dim { color: var(--text-muted); font-size: 0.73rem; }

	.status-dot { font-weight: 600; font-size: 0.75rem; }

	.stage-badge {
		display: inline-block;
		padding: 0.15rem 0.5rem;
		border-radius: 12px;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.positive { color: var(--green); }
	.negative { color: var(--red); }

	.expand-icon {
		width: 1.5rem;
		font-size: 0.6rem;
		color: var(--text-muted);
	}

	.inner-table-wrapper {
		margin-bottom: 0.75rem;
		overflow-x: auto;
	}

	.inner-table {
		font-size: 0.73rem;
	}

	.inner-table th {
		font-size: 0.6rem;
		border-bottom-width: 1px;
	}

	.params {
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.65rem;
		color: var(--text-muted);
	}

	.loading-text {
		color: var(--text-muted);
		font-size: 0.8rem;
		padding: 0.5rem;
	}

	.actions { white-space: nowrap; }

	.promote-btn {
		border: none;
		padding: 0.25rem 0.6rem;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.7rem;
		font-weight: 600;
		transition: opacity 0.15s;
	}

	.promote-btn:hover { opacity: 0.8; }

	.promote-btn.staging {
		background: var(--badge-orange);
		color: var(--orange);
	}

	.promote-btn.prod {
		background: var(--badge-green);
		color: var(--green);
	}

	.load-more {
		display: block;
		margin: 0.75rem auto;
		background: var(--bg-input);
		border: 1px solid var(--border);
		padding: 0.4rem 1rem;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.load-more:hover { color: var(--text); }

	.placeholder {
		color: var(--text-secondary);
		text-align: center;
		padding: 3rem;
	}

	/* ── Deploy tab ── */
	.deploy-form {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.deploy-section {
		background: var(--bg-card);
		border: 1px solid var(--border-light);
		border-radius: 8px;
		padding: 0.75rem 0.85rem;
	}

	.deploy-form h2 {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-secondary);
		margin: 0 0 0.5rem 0;
	}

	.deploy-form label > span:first-child {
		display: block;
		font-size: 0.6rem;
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 0.15rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.deploy-form input[type="text"],
	.deploy-form input[type="number"],
	.deploy-form select {
		width: 100%;
		max-width: 200px;
		padding: 0.3rem 0.4rem;
		background: var(--bg-input);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text);
		font-size: 0.72rem;
		font-family: 'SF Mono', 'Consolas', monospace;
		transition: border-color 0.15s;
	}

	.deploy-form input:focus,
	.deploy-form select:focus {
		outline: none;
		border-color: var(--blue);
		box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.15);
	}

	.field-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
	}

	.field-grid label {
		width: 150px;
	}

	/* Params editor */
	.params-editor {
		width: 100%;
		padding: 0.5rem;
		background: var(--bg-input);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text);
		font-size: 0.72rem;
		font-family: 'SF Mono', 'Consolas', monospace;
		resize: vertical;
		min-height: 120px;
		line-height: 1.4;
		tab-size: 2;
	}

	.params-editor:focus {
		outline: none;
		border-color: var(--blue);
		box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.15);
	}

	.history-row {
		margin-bottom: 0.4rem;
	}

	.history-select {
		width: 100%;
		padding: 0.3rem 0.4rem;
		background: var(--bg-input);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text-secondary);
		font-size: 0.7rem;
		cursor: pointer;
	}

	/* Options checkboxes */
	.option-grid {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.option-check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		cursor: pointer;
		padding: 0.2rem 0;
		font-size: 0.72rem;
		color: var(--text);
	}

	.option-check input[type="checkbox"] {
		accent-color: var(--blue);
		width: 13px;
		height: 13px;
		flex-shrink: 0;
	}

	/* Neutralization inline */
	.neut-inline {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border-light);
	}

	.neut-label {
		font-size: 0.6rem;
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		white-space: nowrap;
	}

	.neut-inline input[type="range"] {
		flex: 1;
		accent-color: var(--blue);
	}

	.neut-value {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--blue);
		font-variant-numeric: tabular-nums;
		min-width: 2.5rem;
		text-align: right;
	}

	/* Cost + launch */
	.deploy-launch-section {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.cost-inline {
		display: flex;
		gap: 0.6rem;
		font-size: 0.68rem;
		color: var(--text-muted);
		font-family: 'SF Mono', 'Consolas', monospace;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.cost-highlight {
		color: var(--orange);
		font-weight: 600;
	}

	.launch-btn {
		margin-left: auto;
		background: var(--blue);
		border: none;
		padding: 0.5rem 1.25rem;
		border-radius: 6px;
		cursor: pointer;
		color: white;
		font-size: 0.75rem;
		font-weight: 700;
		transition: opacity 0.15s, transform 0.1s;
		box-shadow: 0 2px 4px rgba(9, 105, 218, 0.25);
		display: flex;
		align-items: center;
		gap: 0.4rem;
		white-space: nowrap;
	}

	.launch-btn:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
	.launch-btn:active:not(:disabled) { transform: translateY(0); }
	.launch-btn:disabled { opacity: 0.5; cursor: not-allowed; }

	.launch-spinner {
		display: inline-block;
		width: 0.8rem;
		height: 0.8rem;
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-top-color: white;
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}

	@keyframes spin { to { transform: rotate(360deg); } }

	/* ── Responsive ── */
	@media (max-width: 900px) {
		.cards { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
	}

	@media (max-width: 640px) {
		.cards { grid-template-columns: repeat(2, 1fr); }
	}

	@media (max-width: 540px) {
		h1 { font-size: 1.25rem; }
		.cards { grid-template-columns: 1fr 1fr; gap: 0.4rem; }
		.field-grid { grid-template-columns: 1fr 1fr; }
		.deploy-launch-section { flex-direction: column; }
		.launch-btn { margin-left: 0; width: 100%; justify-content: center; }
		.tabs button { padding: 0.5rem 0.75rem; font-size: 0.8rem; }
	}
</style>
