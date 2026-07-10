<script lang="ts">
	import { goto } from '$app/navigation';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { addToast } from '$lib/stores';
	import {
		parseSweepValues,
		sweepCandidates as buildSweepCandidates,
		type PipelineTemplate
	} from '$lib/services/pipeline-service';
	import { createRegistryModel } from '$lib/services/registry-service';

	type ModelType = 'lgbm' | 'catboost' | 'mlp';
	type Tournament = 'classic' | 'signals';
	type SweepParameter =
		| 'learning_rate'
		| 'num_rounds'
		| 'num_leaves'
		| 'max_depth'
		| 'feature_fraction'
		| 'bagging_fraction'
		| 'neutralization_pct'
		| 'feature_set'
		| 'model_type';

	type RunParams = {
		readonly mode: 'train';
		readonly tournament: Tournament;
		readonly feature_set: string;
		readonly model_type: ModelType;
		readonly neutralization_pct: number;
		readonly upload: boolean;
		readonly num_rounds: number;
		readonly learning_rate: number;
		readonly num_leaves: number;
		readonly max_depth: number;
		readonly feature_fraction: number;
		readonly bagging_fraction: number;
		readonly early_stopping_rounds: number;
		readonly max_train_eras: number;
		readonly multi_target_enabled: boolean;
		readonly neutralizer_aware: boolean;
		readonly sample_weight_aware: boolean;
	};

	type DraftCandidate = {
		readonly id: string;
		readonly name: string;
		readonly value: string | null;
	};

	const modelTemplates: { id: PipelineTemplate; name: string }[] = [
		{ id: 'baseline', name: 'Baseline' },
		{ id: 'challenger', name: 'Challenger' },
		{ id: 'ensemble', name: 'Ensemble' }
	];

	const sweepParameters: SweepParameter[] = [
		'learning_rate',
		'num_rounds',
		'num_leaves',
		'max_depth',
		'feature_fraction',
		'bagging_fraction',
		'neutralization_pct',
		'feature_set',
		'model_type'
	];

	let busy = $state(false);
	let selectedTemplateId = $state<PipelineTemplate>('baseline');
	let tournament = $state<Tournament>('classic');
	let featureSet = $state('small');
	let modelType = $state<ModelType>('lgbm');
	let neutralizationPct = $state(25);
	let upload = $state(false);
	let numRounds = $state(10000);
	let learningRate = $state(0.005);
	let numLeaves = $state(512);
	let maxDepth = $state(8);
	let featureFraction = $state(0.1);
	let baggingFraction = $state(0.5);
	let earlyStoppingRounds = $state(200);
	let maxTrainEras = $state(0);
	let multiTargetEnabled = $state(true);
	let neutralizerAware = $state(true);
	let sampleWeightAware = $state(true);
	let sweepParameter = $state<SweepParameter>('learning_rate');
	let sweepValues = $state('0.003, 0.005, 0.008, 0.012');
	let maxRuns = $state(4);

	const selectedTemplate = $derived(
		modelTemplates.find((template) => template.id === selectedTemplateId) ?? modelTemplates[0]
	);
	const runParams = $derived(currentRunParams());
	const sweepValueList = $derived(parseSweepValues(sweepValues, maxRuns));
	const candidateRuns = $derived(
		buildSweepCandidates({
			templateName: selectedTemplate.name,
			parameter: sweepParameter,
			values: sweepValueList
		})
	);
	const draftCandidates = $derived.by<DraftCandidate[]>(() =>
		candidateRuns.length
			? candidateRuns.map((candidate) => ({ ...candidate, value: candidate.value }))
			: [{ id: 'single-draft', name: `${selectedTemplate.name} draft`, value: null }]
	);

	function currentRunParams(): RunParams {
		return {
			mode: 'train',
			tournament,
			feature_set: featureSet,
			model_type: modelType,
			neutralization_pct: neutralizationPct,
			upload,
			num_rounds: numRounds,
			learning_rate: learningRate,
			num_leaves: numLeaves,
			max_depth: maxDepth,
			feature_fraction: featureFraction,
			bagging_fraction: baggingFraction,
			early_stopping_rounds: earlyStoppingRounds,
			max_train_eras: maxTrainEras,
			multi_target_enabled: multiTargetEnabled,
			neutralizer_aware: neutralizerAware,
			sample_weight_aware: sampleWeightAware
		};
	}

	async function draftModels() {
		busy = true;
		try {
			for (const candidate of draftCandidates) {
				const valueConfig = candidate.value === null ? {} : { [sweepParameter]: candidate.value };
				const result = await createRegistryModel({
					name: candidate.name,
					stage: 'draft',
					numeraiModelId: '',
					parentModelId: '',
					changeSummary: `${selectedTemplate.name} ${candidate.value === null ? 'base' : `${sweepParameter}=${candidate.value}`} draft`,
					lineageJson: {
						source: 'builder',
						template: selectedTemplateId,
						runConfig: {
							...runParams,
							...valueConfig
						},
						sweep: {
							parameter: candidate.value === null ? null : sweepParameter,
							value: candidate.value,
							values: sweepValueList
						}
					}
				});
				if (result.errors?.length) {
					throw new Error(result.errors.map((error) => error.message).filter(Boolean).join('; '));
				}
			}
			addToast(`${draftCandidates.length} model draft${draftCandidates.length === 1 ? '' : 's'} created.`, 'success');
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
			</div>
			<div class="head-actions">
				<button type="button" class="primary" disabled={busy} onclick={draftModels}>
					{busy ? 'Drafting' : 'Draft'}
				</button>
			</div>
		</header>

		<div class="builder-grid">
			<section class="panel params-panel">
				<div class="panel-head">
					<h2>Params</h2>
					<span>Training config</span>
				</div>
				<div class="form-grid three">
					<label>
						<span>Template</span>
						<select bind:value={selectedTemplateId}>
							{#each modelTemplates as template}
								<option value={template.id}>{template.name}</option>
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
						<span>Mode</span>
						<input value="train" disabled />
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
						<span>Model type</span>
						<select bind:value={modelType}>
							<option value="lgbm">lgbm</option>
							<option value="catboost">catboost</option>
							<option value="mlp">mlp</option>
						</select>
					</label>
					<label>
						<span>Neutralization %</span>
						<input type="number" min="0" max="100" step="1" bind:value={neutralizationPct} />
					</label>
				</div>

				<div class="form-grid four">
					<label>
						<span>num_rounds</span>
						<input type="number" min="1" bind:value={numRounds} />
					</label>
					<label>
						<span>learning_rate</span>
						<input type="number" min="0" step="0.001" bind:value={learningRate} />
					</label>
					<label>
						<span>num_leaves</span>
						<input type="number" min="2" bind:value={numLeaves} />
					</label>
					<label>
						<span>max_depth</span>
						<input type="number" min="-1" bind:value={maxDepth} />
					</label>
					<label>
						<span>feature_fraction</span>
						<input type="number" min="0" max="1" step="0.01" bind:value={featureFraction} />
					</label>
					<label>
						<span>bagging_fraction</span>
						<input type="number" min="0" max="1" step="0.01" bind:value={baggingFraction} />
					</label>
					<label>
						<span>early_stopping</span>
						<input type="number" min="0" bind:value={earlyStoppingRounds} />
					</label>
					<label>
						<span>max_train_eras</span>
						<input type="number" min="0" bind:value={maxTrainEras} />
					</label>
				</div>

				<div class="checks">
					<label><input type="checkbox" bind:checked={multiTargetEnabled} /> <span>multi_target_enabled</span></label>
					<label><input type="checkbox" bind:checked={neutralizerAware} /> <span>neutralizer_aware</span></label>
					<label><input type="checkbox" bind:checked={sampleWeightAware} /> <span>sample_weight_aware</span></label>
					<label><input type="checkbox" bind:checked={upload} /> <span>upload</span></label>
				</div>
			</section>

			<section class="panel">
				<div class="panel-head">
					<h2>Sweep</h2>
					<span>{draftCandidates.length} drafts</span>
				</div>
				<div class="form-grid two">
					<label>
						<span>Parameter</span>
						<select bind:value={sweepParameter}>
							{#each sweepParameters as parameter}
								<option value={parameter}>{parameter}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>Values</span>
						<input bind:value={sweepValues} />
					</label>
					<label>
						<span>Max drafts</span>
						<input type="number" min="1" max="64" bind:value={maxRuns} />
					</label>
				</div>
			</section>

			<section class="panel preview-panel">
				<div class="panel-head">
					<h2>Drafts</h2>
					<span>Models</span>
				</div>
				<div class="draft-list">
					{#each draftCandidates as candidate}
						<div>
							<strong>{candidate.name}</strong>
							<span>draft model</span>
						</div>
					{/each}
				</div>
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
		font-size: clamp(2.6rem, 6vw, 4.8rem);
		line-height: 0.95;
		letter-spacing: 0;
	}

	.head-actions {
		display: flex;
		gap: 0.55rem;
	}

	button,
	select,
	input {
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
	.draft-list div {
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
	}

	.panel {
		padding: 1rem;
	}

	.params-panel {
		grid-row: span 2;
	}

	.panel-head {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: baseline;
		margin-bottom: 0.9rem;
	}

	.panel-head h2 {
		font-size: 1rem;
	}

	.panel-head span,
	label > span,
	.draft-list span {
		color: var(--text-secondary);
		font-size: 0.78rem;
		line-height: 1.45;
	}

	label > span,
	.panel-head span {
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

	select,
	input {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text);
		min-height: 2.45rem;
		padding: 0.55rem 0.65rem;
	}

	input:disabled {
		color: var(--text-secondary);
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

	.form-grid.four {
		grid-template-columns: repeat(4, minmax(0, 1fr));
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

	.draft-list {
		display: grid;
		gap: 0.5rem;
	}

	.draft-list div {
		display: grid;
		gap: 0.25rem;
		border-color: var(--border-light);
		padding: 0.65rem;
		background: var(--bg-input);
	}

	@media (max-width: 1100px) {
		.builder-grid,
		.form-grid.four,
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

		.head-actions,
		.builder-grid,
		.form-grid.two,
		.form-grid.three,
		.form-grid.four,
		.checks {
			display: grid;
			grid-template-columns: 1fr;
		}

		h1 {
			font-size: clamp(2.4rem, 15vw, 3.7rem);
		}
	}
</style>
