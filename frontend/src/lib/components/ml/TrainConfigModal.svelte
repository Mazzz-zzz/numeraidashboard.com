<script lang="ts">
	import type { TrainRequest } from '$lib/api';

	interface Props {
		open: boolean;
		onclose: () => void;
		onsubmit: (config: TrainRequest) => void;
		loading?: boolean;
	}

	let { open, onclose, onsubmit, loading = false }: Props = $props();

	let experimentName = $state('');
	let featureSet = $state('medium');
	let modelType = $state('lgbm');
	let instanceType = $state('ml.m5.xlarge');
	let showAdvanced = $state(false);
	
	// Advanced options
	let description = $state('');
	let neutralizationPct = $state(50);
	let uploadToNumerai = $state(false);
	let hyperparamsText = $state('');

	function handleSubmit() {
		if (!experimentName.trim()) return;

		const config: TrainRequest = {
			experiment_name: experimentName.trim(),
			feature_set: featureSet,
			model_type: modelType,
			instance_type: instanceType,
			neutralization_pct: neutralizationPct,
		};

		if (description.trim()) config.description = description.trim();
		if (uploadToNumerai) config.upload = true;

		if (hyperparamsText.trim()) {
			try {
				config.hyperparams = JSON.parse(hyperparamsText);
			} catch {
				return;
			}
		}

		onsubmit(config);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
</script>

{#if open}
	<div class="modal-overlay" role="dialog" aria-modal="true" onkeydown={handleKeydown}>
		<div class="modal">
			<header>
				<h2>Start Training</h2>
				<button class="close-btn" onclick={onclose} aria-label="Close">&times;</button>
			</header>

			<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
				<!-- Required -->
				<div class="field">
					<label for="exp-name">Experiment Name</label>
					<input 
						id="exp-name"
						type="text" 
						bind:value={experimentName} 
						placeholder="e.g., catboost-baseline" 
						required 
					/>
				</div>

				<!-- Model & Features -->
				<div class="row">
					<div class="field">
						<label for="model-type">Model</label>
						<select id="model-type" bind:value={modelType}>
							<option value="lgbm">LightGBM</option>
							<option value="catboost">CatBoost</option>
							<option value="mlp">MLP</option>
							<option value="ft_transformer">FT-Transformer</option>
							<option value="tabm">TabM (BatchEnsemble)</option>
							<option value="modern_nca">ModernNCA (Retrieval)</option>
							<option value="tabpfn">TabPFN v2.5 (In-Context)</option>
							<option value="tabicl">TabICL v2 (In-Context)</option>
						</select>
					</div>
					<div class="field">
						<label for="feature-set">Features</label>
						<select id="feature-set" bind:value={featureSet}>
							<option value="small">Small (42)</option>
							<option value="medium">Medium (705)</option>
							<option value="all">All (2376)</option>
						</select>
					</div>
				</div>

			<!-- Compute -->
			<div class="field">
				<label for="instance-type">Instance</label>
				<select id="instance-type" bind:value={instanceType}>
					<optgroup label="Local GPU">
						<option value="local:l4">Local L4</option>
					</optgroup>
					<optgroup label="Modal (Cloud GPU)">
						<option value="modal:t4">Modal T4 — $0.59/hr</option>
						<option value="modal:a10g">Modal A10G — $1.10/hr</option>
						<option value="modal:l4">Modal L4 — $0.80/hr</option>
						<option value="modal:a100">Modal A100 40GB — $3.00/hr</option>
						<option value="modal:h100">Modal H100 — $4.41/hr</option>
					</optgroup>
					<optgroup label="SageMaker (AWS)">
						<option value="ml.m5.xlarge">m5.xlarge — 4 vCPU, 16 GB</option>
						<option value="ml.m5.2xlarge">m5.2xlarge — 8 vCPU, 32 GB</option>
						<option value="ml.m5.4xlarge">m5.4xlarge — 16 vCPU, 64 GB</option>
						<option value="ml.m5.12xlarge">m5.12xlarge — 48 vCPU, 192 GB</option>
					</optgroup>
				</select>
			</div>

			<!-- Local GPU notice -->
			{#if instanceType.startsWith('local:')}
				<div class="local-notice">
					⚡ Local GPU selected — after clicking Start, run the command shown on your GPU machine.
				</div>
			{/if}

				<!-- Advanced Toggle -->
				<button 
					type="button" 
					class="advanced-toggle" 
					class:open={showAdvanced}
					onclick={() => showAdvanced = !showAdvanced}
				>
					<svg class="chevron" viewBox="0 0 24 24" width="16" height="16">
						<path fill="currentColor" d="M7 10l5 5 5-5z"/>
					</svg>
					Advanced Options
				</button>

				{#if showAdvanced}
					<div class="advanced-panel">
						<div class="field">
							<label for="description">Description</label>
							<input 
								id="description"
								type="text" 
								bind:value={description} 
								placeholder="Optional notes about this run"
							/>
						</div>

						<div class="field">
							<label for="neutralization">
								Feature Neutralization
								<span class="value">{neutralizationPct}%</span>
							</label>
							<input 
								id="neutralization"
								type="range" 
								bind:value={neutralizationPct} 
								min="0" 
								max="100" 
								step="5"
							/>
						</div>

						<label class="checkbox">
							<input type="checkbox" bind:checked={uploadToNumerai} />
							<span>Auto-upload to Numerai</span>
						</label>

						<div class="field">
							<label for="hyperparams">Custom Hyperparameters (JSON)</label>
							<textarea 
								id="hyperparams"
								bind:value={hyperparamsText} 
								placeholder={'{"learning_rate": 0.01}'}
								rows="3"
							/>
						</div>
					</div>
				{/if}

				<div class="actions">
					<button type="button" class="btn-secondary" onclick={onclose}>Cancel</button>
					<button type="submit" class="btn-primary" disabled={!experimentName.trim() || loading}>
						{loading ? 'Starting...' : 'Start Training'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<style>
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		backdrop-filter: blur(2px);
	}

	.modal {
		background: var(--bg-card, #1a1a2e);
		border: 1px solid var(--border, #2d2d44);
		border-radius: 12px;
		padding: 1.5rem;
		width: 100%;
		max-width: 420px;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
	}

	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1.25rem;
	}

	h2 {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 0;
		color: var(--text, #e4e4e7);
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-muted, #71717a);
		padding: 0;
		line-height: 1;
		transition: color 0.15s;
	}

	.close-btn:hover {
		color: var(--text, #e4e4e7);
	}

	.field {
		margin-bottom: 1rem;
	}

	.field label {
		display: block;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--text-secondary, #a1a1aa);
		margin-bottom: 0.375rem;
	}

	.field label .value {
		float: right;
		color: var(--blue, #3b82f6);
		font-weight: 600;
	}

	input,
	select,
	textarea {
		width: 100%;
		padding: 0.5rem 0.75rem;
		background: var(--bg-input, #0f0f1a);
		border: 1px solid var(--border, #2d2d44);
		border-radius: 8px;
		color: var(--text, #e4e4e7);
		font-size: 0.875rem;
		font-family: inherit;
		transition: border-color 0.15s, box-shadow 0.15s;
	}

	input:focus,
	select:focus,
	textarea:focus {
		outline: none;
		border-color: var(--blue, #3b82f6);
		box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
	}

	input::placeholder,
	textarea::placeholder {
		color: var(--text-muted, #71717a);
	}

	select {
		cursor: pointer;
		appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 0.5rem center;
		padding-right: 2rem;
	}

	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	.row .field {
		margin-bottom: 0;
	}

	.advanced-toggle {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: none;
		border: none;
		color: var(--text-secondary, #a1a1aa);
		font-size: 0.85rem;
		cursor: pointer;
		padding: 0.5rem 0;
		margin: 0.5rem 0;
		transition: color 0.15s;
	}

	.advanced-toggle:hover {
		color: var(--text, #e4e4e7);
	}

	.advanced-toggle.open .chevron {
		transform: rotate(180deg);
	}

	.chevron {
		transition: transform 0.2s;
	}

	.advanced-panel {
		padding: 0.75rem;
		background: rgba(255, 255, 255, 0.02);
		border-radius: 8px;
		margin-bottom: 0.75rem;
	}

	.advanced-panel .field:first-child {
		margin-top: 0;
	}

	.checkbox {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		font-size: 0.875rem;
		color: var(--text-secondary, #a1a1aa);
		margin: 0.75rem 0;
	}

	.checkbox input {
		width: auto;
		accent-color: var(--blue, #3b82f6);
	}

	textarea {
		font-family: 'SF Mono', 'Consolas', monospace;
		font-size: 0.8rem;
		resize: vertical;
		min-height: 60px;
	}

	input[type="range"] {
		padding: 0;
		height: 4px;
		background: var(--border, #2d2d44);
		border-radius: 2px;
		cursor: pointer;
	}

	input[type="range"]::-webkit-slider-thumb {
		appearance: none;
		width: 16px;
		height: 16px;
		background: var(--blue, #3b82f6);
		border-radius: 50%;
		cursor: pointer;
		transition: transform 0.15s;
	}

	input[type="range"]::-webkit-slider-thumb:hover {
		transform: scale(1.1);
	}

	.actions {
		display: flex;
		gap: 0.75rem;
		justify-content: flex-end;
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border, #2d2d44);
	}

	.btn-secondary,
	.btn-primary {
		padding: 0.5rem 1rem;
		border-radius: 8px;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
	}

	.btn-secondary {
		background: transparent;
		border: 1px solid var(--border, #2d2d44);
		color: var(--text-secondary, #a1a1aa);
	}

	.btn-secondary:hover {
		background: rgba(255, 255, 255, 0.05);
		color: var(--text, #e4e4e7);
	}

	.btn-primary {
		background: var(--blue, #3b82f6);
		border: none;
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		background: #2563eb;
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.local-notice {
		background: rgba(250, 204, 21, 0.08);
		border: 1px solid rgba(250, 204, 21, 0.2);
		border-radius: 8px;
		padding: 0.625rem 0.75rem;
		font-size: 0.8rem;
		color: #facc15;
		margin-bottom: 0.75rem;
		line-height: 1.4;
	}
</style>
