<script lang="ts">
	import { goto } from '$app/navigation';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { addToast } from '$lib/stores';
	import { parseSweepValues, sweepCandidates as buildSweepCandidates } from '$lib/services/pipeline-service';
	import { createRegistryModel } from '$lib/services/registry-service';

	type ModelType =
		| 'lgbm'
		| 'xgboost'
		| 'catboost'
		| 'mlp'
		| 'ft_transformer'
		| 'modern_nca'
		| 'tabm'
		| 'tabpfn'
		| 'tabicl';
	type ModelFamily = 'boosting' | 'neural' | 'foundation';
	type Tournament = 'classic' | 'signals';

	type ParamField = {
		readonly key: string;
		readonly label: string;
		readonly families: readonly ModelFamily[];
		readonly min?: number;
		readonly max?: number;
		readonly step?: number;
		// When present, a range slider (bounded to slider.min/max) is paired with
		// the number input. Only appropriate for params with a natural range.
		readonly slider?: { readonly min: number; readonly max: number; readonly step: number };
		readonly help: string;
	};

	type FlagField = {
		readonly key: 'multi_target_enabled' | 'neutralizer_aware' | 'sample_weight_aware';
		readonly label: string;
		readonly families: readonly ModelFamily[];
		readonly help: string;
	};

	type DraftCandidate = {
		readonly id: string;
		readonly name: string;
		readonly value: string | null;
	};

	// Model types supported by the ml/ training pipeline (create_model / the
	// tournament trainers). Grouped by family; neural + foundation models run on
	// the Apple Silicon (MPS) GPU via the local provider. The family drives which
	// hyperparameters are shown — see paramFields below.
	const modelCatalog: { family: ModelFamily; group: string; options: { value: ModelType; label: string }[] }[] = [
		{
			family: 'boosting',
			group: 'Gradient boosting',
			options: [
				{ value: 'lgbm', label: 'LightGBM' },
				{ value: 'xgboost', label: 'XGBoost' },
				{ value: 'catboost', label: 'CatBoost' }
			]
		},
		{
			family: 'neural',
			group: 'Neural (GPU / MPS)',
			options: [
				{ value: 'mlp', label: 'MLP' },
				{ value: 'ft_transformer', label: 'FT-Transformer' },
				{ value: 'modern_nca', label: 'ModernNCA' },
				{ value: 'tabm', label: 'TabM' }
			]
		},
		{
			family: 'foundation',
			group: 'Foundation (in-context)',
			options: [
				{ value: 'tabpfn', label: 'TabPFN' },
				{ value: 'tabicl', label: 'TabICL' }
			]
		}
	];

	const modelFamily: Record<ModelType, ModelFamily> = Object.fromEntries(
		modelCatalog.flatMap((group) => group.options.map((option) => [option.value, group.family]))
	) as Record<ModelType, ModelFamily>;

	const modelLabels: Record<ModelType, string> = Object.fromEntries(
		modelCatalog.flatMap((group) => group.options.map((option) => [option.value, option.label]))
	) as Record<ModelType, string>;

	// Curated hyperparameters, each tagged with the families it applies to. Model
	// families that need knobs not listed here (e.g. FT-Transformer's d_token,
	// TabPFN's context_rows) can set them through the Advanced (JSON) box, which
	// merges directly into runConfig.
	const paramFields: ParamField[] = [
		{ key: 'num_rounds', label: 'num_rounds', families: ['boosting'], min: 1, step: 1, help: 'Number of boosting rounds / trees.' },
		{ key: 'learning_rate', label: 'learning_rate', families: ['boosting', 'neural'], min: 0, step: 0.001, slider: { min: 0, max: 0.05, step: 0.001 }, help: 'Step size per update. Lower is slower to train but often generalizes better.' },
		{ key: 'num_leaves', label: 'num_leaves', families: ['boosting'], min: 2, step: 1, help: 'Max leaves per tree (LightGBM). Higher = more capacity, more overfitting risk.' },
		{ key: 'max_depth', label: 'max_depth', families: ['boosting'], min: -1, step: 1, help: 'Tree depth cap. -1 means unlimited.' },
		{ key: 'feature_fraction', label: 'feature_fraction', families: ['boosting'], min: 0, max: 1, step: 0.01, slider: { min: 0, max: 1, step: 0.01 }, help: 'Fraction of features sampled for each tree.' },
		{ key: 'bagging_fraction', label: 'bagging_fraction', families: ['boosting'], min: 0, max: 1, step: 0.01, slider: { min: 0, max: 1, step: 0.01 }, help: 'Fraction of rows sampled for each iteration.' },
		{ key: 'batch_size', label: 'batch_size', families: ['neural'], min: 1, step: 1, help: 'Rows per gradient step.' },
		{ key: 'dropout', label: 'dropout', families: ['neural'], min: 0, max: 1, step: 0.01, slider: { min: 0, max: 1, step: 0.01 }, help: 'Dropout regularization rate.' },
		{ key: 'weight_decay', label: 'weight_decay', families: ['neural'], min: 0, step: 0.0001, help: 'L2 weight regularization strength.' },
		{ key: 'early_stopping_rounds', label: 'early_stopping', families: ['boosting', 'neural'], min: 0, step: 1, help: 'Stop when validation stalls for N rounds. 0 disables.' },
		{ key: 'max_train_eras', label: 'max_train_eras', families: ['boosting', 'neural', 'foundation'], min: 0, step: 1, help: 'Cap the number of training eras (0 = all). Lower is faster and cheaper.' }
	];

	const flagFields: FlagField[] = [
		{ key: 'multi_target_enabled', label: 'multi_target_enabled', families: ['boosting', 'neural'], help: 'Train against multiple targets at once.' },
		{ key: 'neutralizer_aware', label: 'neutralizer_aware', families: ['boosting', 'neural'], help: 'Make training aware of feature neutralization.' },
		{ key: 'sample_weight_aware', label: 'sample_weight_aware', families: ['boosting', 'neural'], help: 'Apply per-sample weights during training.' }
	];

	const categoricalSweepParams: Record<string, string[]> = {
		model_type: modelCatalog.flatMap((group) => group.options.map((option) => option.value)),
		feature_set: ['small', 'medium', 'all']
	};

	let busy = $state(false);
	let tournament = $state<Tournament>('classic');
	let featureSet = $state('small');
	let modelType = $state<ModelType>('lgbm');
	let neutralizationPct = $state(25);
	let upload = $state(false);

	// All numeric hyperparameters live in one reactive map so the JSON preview and
	// the sweep can read them generically.
	let params = $state<Record<string, number>>({
		num_rounds: 10000,
		learning_rate: 0.005,
		num_leaves: 512,
		max_depth: 8,
		feature_fraction: 0.1,
		bagging_fraction: 0.5,
		batch_size: 1024,
		dropout: 0.1,
		weight_decay: 0.0001,
		early_stopping_rounds: 200,
		max_train_eras: 0
	});
	let flags = $state<Record<FlagField['key'], boolean>>({
		multi_target_enabled: true,
		neutralizer_aware: true,
		sample_weight_aware: true
	});
	let advancedJson = $state('{}');

	let sweepEnabled = $state(false);
	let sweepParameter = $state<string>('learning_rate');
	let sweepValues = $state('0.003, 0.005, 0.008, 0.012');
	let maxRuns = $state(4);

	const family = $derived(modelFamily[modelType]);
	const modelLabel = $derived(modelLabels[modelType]);
	const visibleParamFields = $derived(paramFields.filter((field) => field.families.includes(family)));
	const visibleFlagFields = $derived(flagFields.filter((field) => field.families.includes(family)));
	const isFoundation = $derived(family === 'foundation');

	// Advanced JSON overrides — parsed once, reused by the preview and the payload.
	const advancedParsed = $derived.by<{ ok: boolean; value: Record<string, unknown>; error?: string }>(() => {
		const raw = advancedJson.trim();
		if (!raw || raw === '{}') return { ok: true, value: {} };
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return { ok: true, value: parsed as Record<string, unknown> };
			}
			return { ok: false, value: {}, error: 'Advanced config must be a JSON object.' };
		} catch (error) {
			return { ok: false, value: {}, error: error instanceof Error ? error.message : 'Invalid JSON.' };
		}
	});

	const sweepParamOptions = $derived([
		...visibleParamFields.map((field) => field.key),
		'neutralization_pct',
		'feature_set',
		'model_type'
	]);

	// Keep the sweep parameter valid when the model family changes the field set.
	$effect(() => {
		if (!sweepParamOptions.includes(sweepParameter)) {
			sweepParameter = sweepParamOptions[0];
		}
	});

	const isCategoricalSweep = $derived(sweepParameter in categoricalSweepParams);
	const sweepPlaceholder = $derived(sweepExample(sweepParameter));
	const sweepValueList = $derived(parseSweepValues(sweepValues, maxRuns));
	const candidateRuns = $derived(
		sweepEnabled
			? buildSweepCandidates({ templateName: modelLabel, parameter: sweepParameter, values: sweepValueList })
			: []
	);
	const draftCandidates = $derived.by<DraftCandidate[]>(() =>
		candidateRuns.length
			? candidateRuns.map((candidate) => ({ ...candidate, value: candidate.value }))
			: [{ id: 'single-draft', name: `${modelLabel} draft`, value: null }]
	);

	const runConfig = $derived(baseRunConfig());
	const configPreview = $derived(JSON.stringify(runConfig, null, 2));
	const summary = $derived(
		`${draftCandidates.length} draft${draftCandidates.length === 1 ? '' : 's'} · ${tournament} · ${modelLabel} · ${featureSet}`
	);
	let copied = $state(false);

	function baseRunConfig(): Record<string, unknown> {
		const config: Record<string, unknown> = {
			mode: 'train',
			tournament,
			feature_set: featureSet,
			model_type: modelType,
			neutralization_pct: neutralizationPct,
			upload
		};
		for (const field of visibleParamFields) config[field.key] = params[field.key];
		for (const field of visibleFlagFields) config[field.key] = flags[field.key];
		Object.assign(config, advancedParsed.value);
		return config;
	}

	function coerceSweepValue(value: string): string | number {
		if (isCategoricalSweep) return value;
		const asNumber = Number(value);
		return Number.isFinite(asNumber) && value.trim() !== '' ? asNumber : value;
	}

	function sweepExample(parameter: string): string {
		if (parameter in categoricalSweepParams) return categoricalSweepParams[parameter].slice(0, 3).join(', ');
		if (parameter === 'neutralization_pct') return '0, 25, 50, 100';
		if (parameter === 'learning_rate') return '0.003, 0.005, 0.008, 0.012';
		const current = params[parameter];
		if (typeof current === 'number' && Number.isFinite(current)) {
			return [current, current * 2, current * 4].map((value) => Number(value.toFixed(4))).join(', ');
		}
		return 'value one, value two';
	}

	async function copyConfig() {
		try {
			await navigator.clipboard.writeText(configPreview);
			copied = true;
			setTimeout(() => (copied = false), 1400);
		} catch {
			addToast('Could not copy config to clipboard.', 'error');
		}
	}

	async function draftModels() {
		if (!advancedParsed.ok) {
			addToast('Fix the Advanced (JSON) config before drafting.', 'error');
			return;
		}
		busy = true;
		try {
			for (const candidate of draftCandidates) {
				const valueConfig =
					candidate.value === null ? {} : { [sweepParameter]: coerceSweepValue(candidate.value) };
				const result = await createRegistryModel({
					name: candidate.name,
					stage: 'draft',
					numeraiModelId: '',
					parentModelId: '',
					changeSummary: `${modelLabel} ${candidate.value === null ? 'base' : `${sweepParameter}=${candidate.value}`} draft`,
					lineageJson: {
						source: 'builder',
						runConfig: {
							...runConfig,
							...valueConfig
						},
						sweep: sweepEnabled
							? {
									parameter: candidate.value === null ? null : sweepParameter,
									value: candidate.value,
									values: sweepValueList
								}
							: null
					}
				});
				if (result.errors?.length) {
					throw new Error(result.errors.map((error) => error.message).filter(Boolean).join('; '));
				}
			}
			addToast(
				`${draftCandidates.length} model draft${draftCandidates.length === 1 ? '' : 's'} created.`,
				'success'
			);
			await goto('/models');
		} catch (error) {
			console.error(error);
			addToast(error instanceof Error ? error.message : 'Model drafts could not be created.', 'error');
		} finally {
			busy = false;
		}
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
				<h1>Draft Numerai model candidates.</h1>
				<p class="lede">Pick a model, tune the params that apply to it, and draft one run or a sweep.</p>
			</div>
			<div class="head-actions">
				<span class="summary" title="What will be created">{summary}</span>
				<button type="button" class="primary" disabled={busy || !advancedParsed.ok} onclick={draftModels}>
					{busy ? 'Drafting…' : `Draft ${draftCandidates.length}`}
				</button>
			</div>
		</header>

		<div class="builder-grid">
			<section class="panel params-panel">
				<div class="panel-head">
					<h2>Parameters</h2>
					<span>{modelLabel} · {family}</span>
				</div>
				<div class="form-grid three">
					<label>
						<span>Model type</span>
						<select bind:value={modelType}>
							{#each modelCatalog as group (group.group)}
								<optgroup label={group.group}>
									{#each group.options as option (option.value)}
										<option value={option.value}>{option.label}</option>
									{/each}
								</optgroup>
							{/each}
						</select>
					</label>
					<label>
						<span>Tournament</span>
						<select bind:value={tournament}>
							<option value="classic">classic</option>
							<option value="signals">signals</option>
						</select>
					</label>
					<label>
						<span>Feature set</span>
						<select bind:value={featureSet}>
							<option value="small">small</option>
							<option value="medium">medium</option>
							<option value="all">all</option>
						</select>
					</label>
					<label>
						<span>Mode</span>
						<input value="train" disabled />
					</label>
					<label class="span-two">
						<span>Neutralization % · {neutralizationPct}</span>
						<div class="control">
							<input type="range" min="0" max="100" step="1" bind:value={neutralizationPct} />
							<input class="num" type="number" min="0" max="100" step="1" bind:value={neutralizationPct} />
						</div>
					</label>
				</div>

				{#if isFoundation}
					<div class="note">
						<strong>{modelLabel} trains in-context.</strong>
						<span>
							No boosting or optimizer hyperparameters to tune — it predicts from context at inference
							time. Use <em>Advanced (JSON)</em> below for context settings like
							<code>context_rows</code> or <code>n_bags</code>.
						</span>
					</div>
				{:else}
					<div class="form-grid two">
						{#each visibleParamFields as field (field.key)}
							<label>
								<span class="field-label">
									{field.label}{#if field.slider} · {params[field.key]}{/if}
									<Tooltip tip={field.help}><span class="hint" aria-hidden="true">?</span></Tooltip>
								</span>
								{#if field.slider}
									<div class="control">
										<input
											type="range"
											min={field.slider.min}
											max={field.slider.max}
											step={field.slider.step}
											bind:value={params[field.key]}
										/>
										<input
											class="num"
											type="number"
											min={field.min}
											max={field.max}
											step={field.step}
											bind:value={params[field.key]}
										/>
									</div>
								{:else}
									<input
										type="number"
										min={field.min}
										max={field.max}
										step={field.step}
										bind:value={params[field.key]}
									/>
								{/if}
							</label>
						{/each}
					</div>

					<div class="checks">
						{#each visibleFlagFields as field (field.key)}
							<label>
								<input type="checkbox" bind:checked={flags[field.key]} />
								<span class="field-label">
									{field.label}
									<Tooltip tip={field.help}><span class="hint" aria-hidden="true">?</span></Tooltip>
								</span>
							</label>
						{/each}
						<label>
							<input type="checkbox" bind:checked={upload} />
							<span>upload</span>
						</label>
					</div>
				{/if}

				<details class="advanced">
					<summary>Advanced (JSON) overrides</summary>
					<p class="advanced-help">
						Merged into <code>runConfig</code> last — set any model-specific kwarg the fields above
						don't expose (e.g. <code>{'{'}"hidden_dims": [512, 256]{'}'}</code>).
					</p>
					<textarea
						class:invalid={!advancedParsed.ok}
						spellcheck="false"
						rows="4"
						bind:value={advancedJson}
					></textarea>
					{#if !advancedParsed.ok}
						<p class="error-text">{advancedParsed.error}</p>
					{/if}
				</details>
			</section>

			<section class="panel">
				<div class="panel-head">
					<h2>Sweep</h2>
					<label class="switch">
						<input type="checkbox" bind:checked={sweepEnabled} />
						<span>{sweepEnabled ? 'on' : 'off'}</span>
					</label>
				</div>
				{#if sweepEnabled}
					<div class="form-grid two">
						<label>
							<span>Parameter</span>
							<select bind:value={sweepParameter}>
								{#each sweepParamOptions as parameter (parameter)}
									<option value={parameter}>{parameter}</option>
								{/each}
							</select>
						</label>
						<label>
							<span>Max drafts</span>
							<input type="number" min="1" max="64" bind:value={maxRuns} />
						</label>
						<label class="span-two">
							<span>Values ({isCategoricalSweep ? 'names' : 'numbers'}, comma-separated)</span>
							<input bind:value={sweepValues} placeholder={sweepPlaceholder} />
						</label>
					</div>
					{#if !sweepValueList.length}
						<p class="error-text">Add at least one value, e.g. {sweepPlaceholder}</p>
					{/if}
				{:else}
					<p class="muted-text">Off — a single draft is created from the parameters. Turn on to fan out one parameter across several values.</p>
				{/if}
			</section>

			<section class="panel preview-panel">
				<div class="panel-head">
					<h2>Drafts</h2>
					<span>{draftCandidates.length} to create</span>
				</div>
				<div class="draft-list">
					{#each draftCandidates as candidate (candidate.id)}
						<div class="draft-item">
							<strong>{candidate.name}</strong>
							{#if candidate.value !== null}
								<span class="chip">{sweepParameter} = {candidate.value}</span>
							{:else}
								<span class="chip muted">base config</span>
							{/if}
						</div>
					{/each}
				</div>
			</section>

			<section class="panel config-panel">
				<div class="panel-head">
					<h2>runConfig</h2>
					<button type="button" class="ghost" onclick={copyConfig}>{copied ? 'Copied' : 'Copy'}</button>
				</div>
				<pre class="config-json">{configPreview}</pre>
				{#if sweepEnabled && draftCandidates.length > 1}
					<p class="muted-text">Each draft overrides <code>{sweepParameter}</code> with its own value.</p>
				{/if}
			</section>
		</div>
	</section>
</AuthGate>

<style>
	.builder-page {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1rem 0 4rem;
	}

	.page-head {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: end;
		border-bottom: 1px solid var(--border-light);
		padding-bottom: 1.2rem;
	}

	.eyebrow {
		margin: 0 0 0.45rem;
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
		font-size: clamp(1.9rem, 3.5vw, 2.6rem);
		line-height: 1.05;
		letter-spacing: -0.01em;
	}

	.lede {
		margin-top: 0.5rem;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.head-actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}

	.summary {
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		text-align: right;
		max-width: 18rem;
	}

	button,
	select,
	input,
	textarea {
		font: inherit;
	}

	button {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: #fff;
		color: var(--text);
		cursor: pointer;
		font-weight: 720;
		min-height: 2.5rem;
		padding: 0 0.9rem;
	}

	button.primary {
		background: var(--text);
		color: #fff;
		border-color: var(--text);
		white-space: nowrap;
	}

	button.ghost {
		min-height: 2rem;
		padding: 0 0.7rem;
		font-size: 0.78rem;
		font-weight: 700;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.builder-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.8fr);
		gap: 1rem;
		align-items: start;
	}

	.panel,
	.draft-item {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
	}

	.panel {
		padding: 1rem;
	}

	.params-panel {
		grid-row: span 3;
	}

	.panel-head {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: center;
		margin-bottom: 0.9rem;
	}

	.panel-head h2 {
		font-size: 1rem;
	}

	.panel-head > span,
	.draft-list span {
		color: var(--text-secondary);
		font-size: 0.78rem;
		line-height: 1.45;
	}

	label > span,
	.panel-head > span {
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
		min-width: 0;
	}

	.field-label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}

	.hint {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1px solid var(--border);
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.6rem;
		font-weight: 800;
		text-transform: none;
		letter-spacing: 0;
	}

	select,
	input,
	textarea {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text);
		min-height: 2.45rem;
		padding: 0.55rem 0.65rem;
	}

	textarea {
		min-height: unset;
		resize: vertical;
		font-family: var(--font-mono);
		font-size: 0.78rem;
		line-height: 1.5;
	}

	textarea.invalid {
		border-color: var(--red);
	}

	input:disabled {
		color: var(--text-secondary);
	}

	.control {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.control input[type='range'] {
		flex: 1;
		min-width: 0;
		min-height: unset;
		padding: 0;
		background: transparent;
		border: none;
		accent-color: var(--text);
		cursor: pointer;
	}

	.control input.num {
		flex: 0 0 5.5rem;
		width: 5.5rem;
		text-align: right;
	}

	.form-grid {
		display: grid;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.form-grid.two {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.form-grid.three {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.span-two {
		grid-column: span 2;
	}

	.checks {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.55rem;
	}

	.checks label {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-height: 2.3rem;
		border: 1px solid var(--border-light);
		border-radius: 6px;
		padding: 0 0.65rem;
		background: var(--bg-input);
	}

	.checks input {
		width: 16px;
		min-height: 16px;
		padding: 0;
	}

	.note {
		display: grid;
		gap: 0.35rem;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-input);
		padding: 0.85rem;
		margin-bottom: 1rem;
	}

	.note span {
		color: var(--text-secondary);
		font-size: 0.82rem;
		line-height: 1.5;
	}

	.note code,
	.advanced-help code,
	.muted-text code {
		font-family: var(--font-mono);
		font-size: 0.78rem;
	}

	.advanced {
		border-top: 1px solid var(--border-light);
		padding-top: 0.85rem;
	}

	.advanced summary {
		cursor: pointer;
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.advanced-help {
		margin: 0.6rem 0;
		color: var(--text-secondary);
		font-size: 0.8rem;
		line-height: 1.5;
	}

	.switch {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	.switch span {
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		text-transform: uppercase;
	}

	.error-text {
		margin-top: 0.5rem;
		color: var(--red);
		font-size: 0.78rem;
	}

	.muted-text {
		color: var(--text-secondary);
		font-size: 0.82rem;
		line-height: 1.5;
	}

	.draft-list {
		display: grid;
		gap: 0.5rem;
	}

	.draft-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		border-color: var(--border-light);
		padding: 0.65rem;
		background: var(--bg-input);
	}

	.draft-item strong {
		font-size: 0.85rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chip {
		flex-shrink: 0;
		border-radius: 999px;
		background: var(--badge-blue);
		color: var(--text);
		font-family: var(--font-mono);
		font-size: 0.7rem;
		padding: 0.15rem 0.55rem;
	}

	.chip.muted {
		background: var(--badge-muted);
		color: var(--text-secondary);
	}

	.config-json {
		margin: 0;
		max-height: 22rem;
		overflow: auto;
		border: 1px solid var(--border-light);
		border-radius: 8px;
		background: var(--bg-input);
		padding: 0.85rem;
		font-family: var(--font-mono);
		font-size: 0.74rem;
		line-height: 1.55;
		white-space: pre;
	}

	@media (max-width: 1100px) {
		.builder-grid,
		.checks {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.params-panel {
			grid-row: auto;
		}
	}

	@media (max-width: 700px) {
		.page-head {
			display: grid;
			align-items: start;
		}

		.head-actions {
			justify-content: space-between;
		}

		.summary {
			text-align: left;
		}

		.builder-grid,
		.form-grid.two,
		.form-grid.three,
		.checks,
		.span-two {
			display: grid;
			grid-template-columns: 1fr;
			grid-column: auto;
		}

		h1 {
			font-size: clamp(1.7rem, 8vw, 2.2rem);
		}
	}
</style>
