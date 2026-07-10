<script lang="ts">
	import { onMount } from 'svelte';
	import { authState } from '$lib/auth';
	import { addToast } from '$lib/stores';
	import type { NumeraiAccount } from '$lib/services/account-service';
	import type { ComputeProvider } from '$lib/services/compute-service';
	import type { ModelRegistryItem } from '$lib/services/registry-service';
	import {
		createSubmissionPlan,
		latestSubmissionForModel,
		loadSubmissionSetup,
		parseRoundNumber,
		roundLabel,
		submissionStatusLabel,
		submitModel,
		type ModelSubmission,
		type RoundDataset,
		type ValidationMode
	} from '$lib/services/submission-service';

	import { SvelteFlow, Background, Controls, type Node, type Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	import PredictNode from '$lib/components/flow-nodes/PredictNode.svelte';

	type ProviderType = 'prime_intellect' | 'modal' | 'sagemaker' | 'local' | 'custom';
	type DrawerKind = 'none' | 'model' | 'artifact' | 'provider' | 'inference' | 'checks' | 'upload' | 'record';

	const nodeTypes = { predict: PredictNode };

	const providerLabels: Record<ProviderType, string> = {
		prime_intellect: 'Prime Intellect',
		modal: 'Modal',
		sagemaker: 'AWS SageMaker',
		local: 'Local',
		custom: 'Custom'
	};
	const validationLabels: Record<ValidationMode, string> = {
		schema: 'Schema only',
		schema_range: 'Schema + range',
		schema_range_rank: 'Schema + range + rank'
	};

	let models = $state<ModelRegistryItem[]>([]);
	let providers = $state<ComputeProvider[]>([]);
	let numeraiAccount = $state<NumeraiAccount | null>(null);
	let submissions = $state<ModelSubmission[]>([]);
	let rounds = $state<RoundDataset[]>([]);
	let loading = $state(true);
	let busy = $state(false);

	let selectedModelId = $state('');
	let selectedProviderId = $state('');
	let drawer = $state<DrawerKind>('none');
	let uploadEnabled = $state(true);
	let roundNumber = $state('');
	let neutralizationPct = $state(50);
	let validationMode = $state<ValidationMode>('schema_range_rank');
	let predictionSet = $state('live');
	let initialized = false;

	onMount(() => {
		if ($authState.user) void loadAll();
	});

	$effect(() => {
		if ($authState.user && loading) void loadAll();
	});

	async function loadAll() {
		loading = true;
		try {
			const setup = await loadSubmissionSetup();
			models = setup.models;
			providers = setup.providers;
			numeraiAccount = setup.numeraiAccount;
			submissions = setup.submissions;
			rounds = setup.rounds;
			if (!initialized) {
				selectedModelId = defaultModelId(models);
				selectedProviderId = defaultProviderId(providers);
				roundNumber = defaultRound(models.find((model) => model.id === selectedModelId), rounds);
				initialized = true;
			}
		} catch (e) {
			addToast(asMessage(e, 'Failed to load prediction setup'), 'error');
		} finally {
			loading = false;
		}
	}

	const selectedModel = $derived(models.find((model) => model.id === selectedModelId) ?? null);
	const selectedProvider = $derived(providers.find((provider) => provider.id === selectedProviderId) ?? null);
	const selectedSubmission = $derived(
		selectedModelId ? latestSubmissionForModel(selectedModelId, submissions) : null
	);
	const currentRound = $derived(
		[...rounds].sort((a, b) => (b.roundNumber ?? 0) - (a.roundNumber ?? 0))[0] ?? null
	);
	const uploadReady = $derived(
		!uploadEnabled || (!!numeraiAccount?.verifiedAt && !numeraiAccount.lastVerifyError)
	);
	const modelReady = $derived(!!selectedModel && !!selectedModel.numeraiModelId);
	const artifactReady = $derived(!!selectedModel?.runId || !!selectedModel?.lineageJson);
	const providerReady = $derived(!!selectedProvider && selectedProvider.status !== 'disabled' && providerOperational(selectedProvider));
	const inferenceReady = $derived(modelReady && providerReady);
	const checksReady = $derived(inferenceReady && validationMode !== 'schema');
	const canQueue = $derived(inferenceReady && checksReady && uploadReady);

	const nodes = $derived<Node[]>([
		{
			id: 'model',
			type: 'predict',
			position: { x: 0, y: 120 },
			selected: drawer === 'model',
			data: {
				eyebrow: 'Model',
				label: selectedModel?.name ?? 'Choose model',
				sub: selectedModel?.numeraiModelId ? `Numerai ${short(selectedModel.numeraiModelId)}` : 'Needs Numerai model ID',
				status: modelReady ? 'ready' : 'blocked',
				statusLabel: modelReady ? 'ready' : 'missing',
				icon: 'model'
			}
		},
		{
			id: 'artifact',
			type: 'predict',
			position: { x: 310, y: 120 },
			selected: drawer === 'artifact',
			data: {
				eyebrow: 'Artifact',
				label: artifactReady ? 'Trained artifact' : 'Artifact source',
				sub: selectedModel?.runId ? `Run ${short(selectedModel.runId)}` : 'Attach a run or lineage artifact',
				status: artifactReady ? 'ready' : 'idle',
				statusLabel: artifactReady ? 'found' : 'manual',
				icon: 'artifact'
			}
		},
		{
			id: 'provider',
			type: 'predict',
			position: { x: 310, y: -20 },
			selected: drawer === 'provider',
			data: {
				eyebrow: 'Provider',
				label: selectedProvider?.name ?? 'Choose provider',
				sub: selectedProvider ? providerSub(selectedProvider) : 'Add one in Settings',
				status: providerReady ? 'ready' : 'blocked',
				statusLabel: providerReady ? 'ready' : 'check',
				icon: 'provider'
			}
		},
		{
			id: 'inference',
			type: 'predict',
			position: { x: 640, y: 80 },
			selected: drawer === 'inference',
			data: {
				eyebrow: 'Inference',
				label: 'Generate predictions',
				sub: `${predictionSet} set · neutralize ${neutralizationPct}%`,
				status: inferenceReady ? 'ready' : 'blocked',
				statusLabel: inferenceReady ? 'ready' : 'blocked',
				icon: 'inference'
			}
		},
		{
			id: 'checks',
			type: 'predict',
			position: { x: 960, y: -20 },
			selected: drawer === 'checks',
			data: {
				eyebrow: 'Checks',
				label: validationLabels[validationMode],
				sub: 'CSV schema, prediction bounds, row order',
				status: checksReady ? 'ready' : 'idle',
				statusLabel: checksReady ? 'guarded' : 'basic',
				icon: 'check'
			}
		},
		{
			id: 'upload',
			type: 'predict',
			position: { x: 960, y: 160 },
			selected: drawer === 'upload',
			data: {
				eyebrow: 'Numerai',
				label: uploadEnabled ? 'Upload to round' : 'Export only',
				sub: uploadEnabled ? uploadSub() : 'Prediction CSV only',
				status: uploadReady ? 'ready' : uploadEnabled ? 'blocked' : 'idle',
				statusLabel: uploadReady ? 'linked' : uploadEnabled ? 'auth' : 'off',
				icon: 'upload'
			}
		},
		{
				id: 'record',
			type: 'predict',
			position: { x: 1280, y: 80 },
			selected: drawer === 'record',
				data: {
					eyebrow: 'Record',
					label: 'Submission history',
					sub: submissionStatusLabel(selectedSubmission),
					status: canQueue ? 'ready' : 'idle',
					statusLabel: canQueue ? 'armed' : 'pending',
					icon: 'record'
			}
		}
	]);

	const edges = $derived<Edge[]>([
		edge('model-artifact', 'model', 'artifact', modelReady),
		edge('artifact-inference', 'artifact', 'inference', artifactReady),
		edge('provider-inference', 'provider', 'inference', providerReady),
		edge('inference-checks', 'inference', 'checks', inferenceReady),
		edge('checks-upload', 'checks', 'upload', checksReady),
		edge('upload-record', 'upload', 'record', uploadReady)
	]);

	function onNodeClick({ node }: { node: Node; event: MouseEvent | TouchEvent }) {
		drawer = node.id as DrawerKind;
	}

	function defaultModelId(items: ModelRegistryItem[]) {
		return (
			items.find((model) => model.stage === 'live' && model.numeraiModelId)?.id ??
			items.find((model) => model.numeraiModelId)?.id ??
			items[0]?.id ??
			''
		);
	}

	function defaultProviderId(items: ComputeProvider[]) {
		return (
			items.find((provider) => providerOperational(provider) && provider.status !== 'disabled')?.id ??
			items.find((provider) => provider.status !== 'disabled')?.id ??
			items[0]?.id ??
			''
		);
	}

	function defaultRound(model: ModelRegistryItem | undefined, cachedRounds: RoundDataset[] = rounds) {
		const cached = [...cachedRounds].sort((a, b) => (b.roundNumber ?? 0) - (a.roundNumber ?? 0))[0];
		if (cached?.roundNumber) return String(cached.roundNumber);
		if (model?.lastSubmittedRound) return String(model.lastSubmittedRound + 1);
		return '';
	}

	function providerOperational(provider: ComputeProvider) {
		if (provider.providerType === 'local') return true;
		return !!provider.verifiedAt && !provider.lastVerifyError;
	}

	function providerSub(provider: ComputeProvider) {
		const type = (provider.providerType as ProviderType) ?? 'custom';
		if (provider.lastVerifyError) return 'verification failed';
		if (provider.verifiedAt) return `${providerLabels[type]} · verified`;
		return `${providerLabels[type]} · not verified`;
	}

	function uploadSub() {
		const round = roundNumber.trim() ? `Round ${roundNumber.trim()}` : 'Next open round';
		const account = numeraiAccount?.label || (numeraiAccount ? `id ${short(numeraiAccount.publicId)}` : 'link account');
		return `${round} · ${account}`;
	}

	function selectModel(id: string) {
		selectedModelId = id;
		const model = models.find((item) => item.id === id);
		if (!roundNumber.trim()) roundNumber = defaultRound(model);
	}

	function edge(id: string, source: string, target: string, animated: boolean): Edge {
		return {
			id,
			source,
			target,
			type: 'smoothstep',
			animated,
			style: `stroke: var(--text); stroke-width: ${animated ? '1.5' : '1.2'}; ${animated ? '' : 'stroke-dasharray: 4 4;'}`
		};
	}

	async function preparePlan() {
		if (!canQueue) {
			addToast('Complete model, provider, validation, and Numerai account before upload', 'error');
			return;
		}
		busy = true;
		try {
			const parsedRound = parseRoundNumber(roundNumber);
			const created = await createSubmissionPlan({
				selectedModelId,
				selectedProviderId,
				numeraiAccountId: numeraiAccount?.id ?? null,
				roundNumber,
				predictionSet,
				neutralizationPct,
				validationMode,
				uploadEnabled,
				modelName: selectedModel?.name ?? null,
				providerName: selectedProvider?.name ?? null
			});
			if (created.data) submissions = [created.data as ModelSubmission, ...submissions];
			const round = parsedRound == null ? 'the next open round' : `round ${parsedRound}`;
			addToast(`Submission plan created for ${selectedModel?.name} on ${selectedProvider?.name} for ${round}`, 'success');
		} catch (e) {
			addToast(asMessage(e, 'Failed to create submission plan'), 'error');
		} finally {
			busy = false;
		}
	}

	async function queueSubmission() {
		if (!canQueue) {
			addToast('Complete model, provider, validation, and Numerai account before upload', 'error');
			return;
		}
		busy = true;
		try {
			const { result, created } = await submitModel({
				selectedModelId,
				selectedProviderId,
				numeraiAccountId: numeraiAccount?.id ?? null,
				roundNumber,
				predictionSet,
				neutralizationPct,
				validationMode,
				uploadEnabled,
				modelName: selectedModel?.name ?? null,
				providerName: selectedProvider?.name ?? null
			});
			if (created.data) submissions = [created.data as ModelSubmission, ...submissions];
			models = models.map((model) =>
				model.id === selectedModelId
					? {
							...model,
							lastSubmittedRound: result.roundNumber ?? parseRoundNumber(roundNumber),
							lastSubmittedAt: result.checkedAt
						}
					: model
			);
			addToast(result.logTail ?? `Submission ${result.status}`, result.ok ? 'success' : 'error');
		} catch (e) {
			addToast(asMessage(e, 'Failed to queue submission'), 'error');
		} finally {
			busy = false;
		}
	}

	function closeDrawer() {
		drawer = 'none';
	}

	function asMessage(e: unknown, fallback: string) {
		return e instanceof Error ? e.message : fallback;
	}

	function fmtDate(value: string | null | undefined) {
		if (!value) return '—';
		try {
			return new Date(value).toLocaleString();
		} catch {
			return value;
		}
	}

	function short(value: string | null | undefined) {
		if (!value) return '—';
		return value.length > 10 ? `${value.slice(0, 8)}…` : value;
	}
</script>

<section class="submit-view">
		<div class="flow-shell" class:drawer-open={drawer !== 'none'}>
			<div class="flow-canvas">
				{#if loading}
					<p class="loading-msg">Loading prediction setup…</p>
				{:else}
					<SvelteFlow
						{nodes}
						{edges}
						{nodeTypes}
						fitView
						proOptions={{ hideAttribution: true }}
						nodesDraggable={false}
						nodesConnectable={false}
						onnodeclick={onNodeClick}
					>
						<Background patternColor="rgba(23,23,23,0.08)" gap={28} />
						<Controls showLock={false} />
					</SvelteFlow>
				{/if}
			</div>

			{#if drawer !== 'none'}
				<aside class="drawer" aria-label="Prediction setup">
					<header class="drawer-head">
						<div>
							<span class="eyebrow">Submit</span>
							<h2>
								{#if drawer === 'model'}Model source{/if}
								{#if drawer === 'artifact'}Artifact input{/if}
								{#if drawer === 'provider'}Inference provider{/if}
								{#if drawer === 'inference'}Inference run{/if}
								{#if drawer === 'checks'}Validation checks{/if}
								{#if drawer === 'upload'}Numerai upload{/if}
								{#if drawer === 'record'}Submission record{/if}
							</h2>
						</div>
						<button type="button" class="ghost" onclick={closeDrawer} aria-label="Close">✕</button>
					</header>

					<div class="drawer-body">
						{#if drawer === 'model'}
							{#if models.length === 0}
								<div class="empty">
									<p class="eyebrow">No models</p>
									<h3>Register a model before predicting.</h3>
									<p class="muted">The Predict flow needs a model with a Numerai model ID.</p>
									<a class="button-link primary" href="/models">Open models</a>
								</div>
							{:else}
								<label class="field">
									<span>Model</span>
									<select bind:value={selectedModelId} onchange={(event) => selectModel(event.currentTarget.value)}>
										{#each models as model (model.id)}
											<option value={model.id}>{model.name}</option>
										{/each}
									</select>
								</label>
								<dl class="kv">
									<dt>Stage</dt><dd>{selectedModel?.stage ?? '—'}</dd>
									<dt>Numerai ID</dt><dd class="mono">{selectedModel?.numeraiModelId ?? '—'}</dd>
									<dt>Live corr</dt><dd class="mono">{selectedModel?.liveCorr?.toFixed(4) ?? '—'}</dd>
									<dt>Live mmc</dt><dd class="mono">{selectedModel?.liveMmc?.toFixed(4) ?? '—'}</dd>
								</dl>
							{/if}
						{:else if drawer === 'artifact'}
							<dl class="kv">
								<dt>Run ID</dt><dd class="mono">{selectedModel?.runId ?? '—'}</dd>
								<dt>Branch ID</dt><dd class="mono">{selectedModel?.branchId ?? '—'}</dd>
								<dt>Pipeline ID</dt><dd class="mono">{selectedModel?.pipelineId ?? '—'}</dd>
								<dt>Lineage</dt><dd>{selectedModel?.lineageJson ? 'available' : 'not attached'}</dd>
							</dl>
							<p class="muted">
								The inference worker should resolve the promoted run artifact, download the live
								feature set, and emit a Numerai-compatible prediction CSV.
							</p>
						{:else if drawer === 'provider'}
							{#if providers.length === 0}
								<div class="empty">
									<p class="eyebrow">No providers</p>
									<h3>Add an inference provider in Settings.</h3>
									<p class="muted">Prime Intellect, Modal, SageMaker, local, and custom providers can be used.</p>
									<a class="button-link primary" href="/settings">Open settings</a>
								</div>
							{:else}
								<label class="field">
									<span>Provider</span>
									<select bind:value={selectedProviderId}>
										{#each providers as provider (provider.id)}
											<option value={provider.id}>{provider.name}</option>
										{/each}
									</select>
								</label>
								<dl class="kv">
									<dt>Type</dt><dd>{selectedProvider ? providerLabels[(selectedProvider.providerType as ProviderType) ?? 'custom'] : '—'}</dd>
									<dt>Status</dt><dd>{selectedProvider?.status ?? '—'}</dd>
									<dt>Verified</dt><dd>{fmtDate(selectedProvider?.verifiedAt)}</dd>
									<dt>Budget</dt><dd>{selectedProvider?.monthlyBudgetUsd ? `$${selectedProvider.monthlyBudgetUsd}` : '—'}</dd>
								</dl>
								<a class="button-link" href="/settings">Manage providers</a>
							{/if}
						{:else if drawer === 'inference'}
							<label class="field">
								<span>Prediction set</span>
								<select bind:value={predictionSet}>
									<option value="live">Live tournament data</option>
									<option value="validation">Validation data</option>
									<option value="diagnostic">Diagnostic sample</option>
								</select>
							</label>
							<label class="field">
								<span>Neutralization</span>
								<div class="range-row">
									<input type="range" min="0" max="100" step="5" bind:value={neutralizationPct} />
									<strong>{neutralizationPct}%</strong>
								</div>
							</label>
							<div class="readiness" class:ready={inferenceReady}>
								<span></span>
								<div>
									<strong>{inferenceReady ? 'Ready to generate predictions' : 'Inference is blocked'}</strong>
									<p>{inferenceReady ? 'Model and provider are selected.' : 'Select a model with a Numerai ID and an operational provider.'}</p>
								</div>
							</div>
						{:else if drawer === 'checks'}
							<label class="field">
								<span>Validation mode</span>
								<select bind:value={validationMode}>
									<option value="schema">Schema only</option>
									<option value="schema_range">Schema + range</option>
									<option value="schema_range_rank">Schema + range + rank</option>
								</select>
							</label>
							<ul class="rows">
								<li>Confirm required columns and row count.</li>
								<li>Confirm prediction values are finite and bounded.</li>
								<li>Confirm IDs stay aligned with the live data download.</li>
							</ul>
						{:else if drawer === 'upload'}
							<label class="toggle">
								<input type="checkbox" bind:checked={uploadEnabled} />
								<span>Upload prediction CSV to Numerai</span>
							</label>
							<div class="readiness" class:ready={!!currentRound}>
								<span></span>
								<div>
									<strong>{roundLabel(currentRound)}</strong>
									<p>
										{currentRound?.cachedAt ? `Cached ${fmtDate(currentRound.cachedAt)}` : 'Round cache will populate from the submission function path.'}
									</p>
								</div>
							</div>
							<label class="field">
								<span>Round</span>
								<input type="number" min="1" step="1" bind:value={roundNumber} placeholder="Next open round" />
							</label>
							<dl class="kv">
								<dt>Account</dt><dd>{numeraiAccount?.label ?? (numeraiAccount ? 'Linked account' : '—')}</dd>
								<dt>Public ID</dt><dd class="mono">{short(numeraiAccount?.publicId)}</dd>
								<dt>Verified</dt><dd>{fmtDate(numeraiAccount?.verifiedAt)}</dd>
								<dt>Error</dt><dd>{numeraiAccount?.lastVerifyError ?? '—'}</dd>
							</dl>
							<a class="button-link" href="/settings">Manage Numerai credentials</a>
						{:else if drawer === 'record'}
							<dl class="kv">
								<dt>Latest submission</dt><dd>{submissionStatusLabel(selectedSubmission)}</dd>
								<dt>External ID</dt><dd class="mono">{short(selectedSubmission?.externalSubmissionId)}</dd>
								<dt>Artifact</dt><dd class="mono">{short(selectedSubmission?.artifactUri)}</dd>
								<dt>Submitted at</dt><dd>{fmtDate(selectedSubmission?.submittedAt)}</dd>
								<dt>Last round</dt><dd>{selectedModel?.lastSubmittedRound ?? '—'}</dd>
								<dt>Last submit</dt><dd>{fmtDate(selectedModel?.lastSubmittedAt)}</dd>
								<dt>Payout</dt><dd class="mono">{selectedModel?.payoutNmr?.toFixed(2) ?? '—'}</dd>
								<dt>Current state</dt><dd>{canQueue ? 'ready' : 'pending setup'}</dd>
							</dl>
							<div class="button-row">
								<button type="button" onclick={preparePlan} disabled={busy || !canQueue}>
									{busy ? 'Preparing…' : 'Prepare plan'}
								</button>
								<button type="button" class="primary" onclick={queueSubmission} disabled={busy || !canQueue}>
									{busy ? 'Queueing…' : 'Queue submission'}
								</button>
							</div>
						{/if}
					</div>
				</aside>
			{/if}
		</div>
</section>

<style>
	.submit-view { display: block; }

	.flow-shell {
		position: relative;
		display: grid;
		--drawer-width: clamp(440px, 36vw, 600px);
		grid-template-columns: 1fr;
		height: calc(100vh - var(--nav-height, 88px));
		min-height: 520px;
		background: var(--bg-page);
		overflow: hidden;
	}

	.flow-canvas {
		min-width: 0;
		position: relative;
		background: var(--bg-page);
	}
	.flow-canvas :global(.svelte-flow) { background: var(--bg-page); }
	.flow-canvas :global(.svelte-flow__controls) {
		border: 1px solid var(--text);
		box-shadow: 2px 2px 0 var(--text);
		background: var(--bg-card);
	}
	.flow-canvas :global(.svelte-flow__controls-button) {
		background: var(--bg-card);
		border-bottom: 1px solid var(--border-light);
		color: var(--text);
	}
	.flow-canvas :global(.svelte-flow__controls-button:hover) { background: var(--hover-bg); }

	.loading-msg {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--text-muted);
	}

	.drawer {
		position: absolute;
		inset: 12px 12px 12px auto;
		z-index: 10;
		display: grid;
		grid-template-rows: auto 1fr;
		width: var(--drawer-width);
		max-width: calc(100% - 24px);
		height: calc(100% - 24px);
		min-height: 0;
		padding: 1.2rem;
		background: var(--bg-card);
		border: 1.5px solid var(--text);
		box-shadow: -4px 4px 0 var(--text);
		overflow: hidden;
	}

	.drawer-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		padding-bottom: 0.9rem;
		margin-bottom: 1rem;
		border-bottom: 1.5px solid var(--text);
		min-width: 0;
	}
	.drawer-head > div { min-width: 0; }
	.eyebrow {
		font-family: var(--font-mono);
		font-size: 0.62rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin: 0;
	}
	.drawer-head h2 {
		margin: 0.25rem 0 0;
		font-size: 1.1rem;
		font-weight: 740;
	}

	.drawer-body {
		display: grid;
		align-content: start;
		gap: 1rem;
		min-height: 0;
		overflow-y: auto;
		padding: 0.1rem 0.3rem 0.3rem 0;
	}

	button,
	.button-link {
		font: inherit;
		font-size: 0.82rem;
		font-weight: 720;
		min-height: 38px;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.5rem 0.85rem;
		border-radius: 4px;
		border: 1px solid var(--text);
		background: var(--bg-card);
		color: var(--text);
		text-decoration: none;
		cursor: pointer;
	}
	button:hover:not(:disabled),
	.button-link:hover { background: var(--hover-bg); }
	button:disabled { opacity: 0.55; cursor: not-allowed; }
	button.primary,
	.button-link.primary {
		background: var(--text);
		color: white;
		box-shadow: 3px 3px 0 var(--text);
	}
	button.primary:hover:not(:disabled),
	.button-link.primary:hover { background: #303030; }
	button.ghost {
		min-height: 0;
		border: none;
		background: none;
		font-size: 1rem;
		padding: 0.25rem 0.4rem;
	}

	.field {
		display: grid;
		gap: 0.35rem;
		min-width: 0;
		font-size: 0.85rem;
	}
	.field > span {
		font-family: var(--font-mono);
		color: var(--text-muted);
		font-size: 0.62rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		padding-left: 0.75rem;
	}
	input,
	select {
		font: inherit;
		width: 100%;
		height: 42px;
		min-width: 0;
		box-sizing: border-box;
		padding: 0.6rem 0.75rem;
		border: 1.5px solid var(--text);
		border-radius: 4px;
		background: var(--bg-page);
		color: var(--text);
	}
	input:focus,
	select:focus {
		outline: none;
		box-shadow: 3px 3px 0 var(--text);
		background: var(--bg-card);
	}

	.range-row {
		display: grid;
		grid-template-columns: 1fr 54px;
		align-items: center;
		gap: 0.7rem;
	}
	.range-row input { padding: 0; height: auto; box-shadow: none; }
	.range-row strong { font-family: var(--font-mono); font-size: 0.86rem; }

	.toggle {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.72rem 0.8rem;
		border: 1.5px solid var(--text);
		border-radius: 4px;
		background: var(--bg-page);
		font-weight: 700;
	}
	.toggle input {
		width: 1rem;
		height: 1rem;
		padding: 0;
	}

	.kv {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.5rem 0.8rem;
		margin: 0;
		padding: 0.8rem 0.85rem;
		background: var(--bg-page);
		border: 1.5px solid var(--text);
		border-radius: 4px;
		box-shadow: 3px 3px 0 var(--text);
	}
	.kv dt {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.62rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		align-self: center;
	}
	.kv dd {
		min-width: 0;
		margin: 0;
		font-size: 0.85rem;
		overflow-wrap: anywhere;
	}
	.mono { font-family: var(--font-mono); }
	.muted {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.86rem;
		line-height: 1.45;
	}

	.rows {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.rows li {
		padding: 0.7rem 0.8rem;
		background: var(--bg-page);
		border: 1.5px solid var(--text);
		border-radius: 4px;
		font-size: 0.85rem;
	}

	.button-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.6rem;
	}

	.readiness {
		display: grid;
		grid-template-columns: 10px minmax(0, 1fr);
		gap: 0.65rem;
		align-items: start;
		padding: 0.75rem 0.85rem;
		border: 1.5px solid var(--text);
		border-radius: 4px;
		background: var(--bg-page);
	}
	.readiness > span {
		width: 8px;
		height: 8px;
		margin-top: 0.25rem;
		border-radius: 50%;
		background: var(--red);
	}
	.readiness.ready > span { background: var(--green); box-shadow: 0 0 0 2px rgba(26, 127, 55, 0.18); }
	.readiness strong { display: block; font-size: 0.86rem; }
	.readiness p {
		margin: 0.2rem 0 0;
		color: var(--text-secondary);
		font-size: 0.78rem;
		line-height: 1.4;
	}

	.empty {
		display: grid;
		gap: 0.55rem;
		padding: 0.9rem;
		border: 1.5px solid var(--text);
		border-radius: 4px;
		background: var(--bg-page);
		box-shadow: 3px 3px 0 var(--text);
	}
	.empty h3 {
		margin: 0;
		font-size: 1rem;
	}

	@media (max-width: 880px) {
		.flow-shell {
			height: calc(100vh - var(--nav-height, 88px));
			min-height: 560px;
		}
		.drawer {
			inset: 10px;
			width: auto;
			max-width: none;
			height: auto;
		}
	}
</style>
