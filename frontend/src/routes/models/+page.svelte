<script lang="ts">
	import { onMount } from 'svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { authState } from '$lib/auth';
	import { addToast } from '$lib/stores';
	import ModelLineageView from '$lib/components/ModelLineageView.svelte';
	import ModelSubmitView from '$lib/components/ModelSubmitView.svelte';
	import {
		createRegistryModel,
		deleteRegistryModel,
		listRegistryModels,
		modelStageLabels,
		modelStages,
		updateRegistryModel,
		updateRegistryModelStage,
		type ModelRegistryItem,
		type ModelStage
	} from '$lib/services/registry-service';
	import {
		latestRoundDataset,
		latestSubmissionForModel,
		listRoundDatasets,
		listModelSubmissions,
		refreshRoundMetricsForModel,
		roundFreshnessLabel,
		roundLabel,
		submissionStatusLabel,
		type ModelSubmission,
		type RoundDataset
	} from '$lib/services/submission-service';

	let models = $state<ModelRegistryItem[]>([]);
	let submissions = $state<ModelSubmission[]>([]);
	let rounds = $state<RoundDataset[]>([]);
	let loading = $state(true);
	let stageFilter = $state<ModelStage | 'all'>('all');
	let viewMode = $state<'registry' | 'lineage' | 'submit'>('registry');
	let refreshError = $state<string | null>(null);

	type Drawer =
		| { kind: 'none' }
		| { kind: 'new' }
		| { kind: 'edit'; id: string };
	let drawer = $state<Drawer>({ kind: 'none' });

	let form = $state({
		name: '',
		stage: 'draft' as ModelStage,
		numeraiModelId: '',
		parentModelId: '',
		changeSummary: ''
	});
	let busy = $state(false);

	onMount(() => {
		if ($authState.user) void load();
	});

	$effect(() => {
		if ($authState.user && loading) void load();
	});

	async function load() {
		loading = true;
		try {
			const [modelRows, submissionRows, roundRows] = await Promise.all([
				listRegistryModels(),
				listModelSubmissions(),
				listRoundDatasets()
			]);
			models = modelRows;
			submissions = submissionRows;
			rounds = roundRows;
		} catch (e) {
			addToast(asMessage(e, 'Failed to load models'), 'error');
		} finally {
			loading = false;
		}
	}

	const filtered = $derived(
		stageFilter === 'all' ? models : models.filter((m) => (m.stage as ModelStage) === stageFilter)
	);
	const stageCounts = $derived.by(() =>
		Object.fromEntries(modelStages.map((stage) => [stage, models.filter((m) => m.stage === stage).length])) as Record<
			ModelStage,
			number
		>
	);
	const editing = $derived.by(() => {
		const d = drawer;
		if (d.kind !== 'edit') return null;
		return models.find((m) => m.id === d.id) ?? null;
	});
	const latestRound = $derived(latestRoundDataset(rounds));
	const roundFreshness = $derived(roundFreshnessLabel(latestRound));

	function openNew() {
		form = { name: '', stage: 'draft', numeraiModelId: '', parentModelId: '', changeSummary: '' };
		drawer = { kind: 'new' };
	}

	function openEdit(model: ModelRegistryItem) {
		form = {
			name: model.name ?? '',
			stage: (model.stage as ModelStage) ?? 'draft',
			numeraiModelId: model.numeraiModelId ?? '',
			parentModelId: model.parentModelId ?? '',
			changeSummary: model.changeSummary ?? ''
		};
		drawer = { kind: 'edit', id: model.id };
	}

	function closeDrawer() {
		drawer = { kind: 'none' };
	}

	async function save(event: Event) {
		event.preventDefault();
		if (!form.name.trim()) {
			addToast('Name is required', 'error');
			return;
		}
		const d = drawer;
		busy = true;
		try {
			if (d.kind === 'edit') {
				await updateRegistryModel(d.id, form);
				addToast('Model updated', 'success');
			} else {
				await createRegistryModel(form);
				addToast(`${form.name.trim()} registered`, 'success');
			}
			await load();
			closeDrawer();
		} catch (e) {
			addToast(asMessage(e, 'Failed to save model'), 'error');
		} finally {
			busy = false;
		}
	}

	async function quickStage(id: string, stage: ModelStage) {
		busy = true;
		try {
			await updateRegistryModelStage(id, stage);
			await load();
		} catch (e) {
			addToast(asMessage(e, 'Failed to change stage'), 'error');
		} finally {
			busy = false;
		}
	}

	async function refreshModelMetrics(model: ModelRegistryItem) {
		const submission = latestSubmissionForModel(model.id, submissions);
		const roundNumber = submission?.roundNumber ?? model.lastSubmittedRound ?? null;
		if (!roundNumber) {
			addToast('Refresh needs a submitted round for this model.', 'error');
			return;
		}
		busy = true;
		refreshError = null;
		try {
			const refresh = await refreshRoundMetricsForModel({
				modelId: model.id,
				submissionId: submission?.id ?? null,
				roundNumber
			});
			if (refresh.round.data) {
				const nextRound = refresh.round.data as RoundDataset;
				rounds = [nextRound, ...rounds.filter((round) => round.id !== nextRound.id)];
			}
			if (refresh.submission?.data) {
				const nextSubmission = refresh.submission.data as ModelSubmission;
				submissions = [
					nextSubmission,
					...submissions.filter((item) => item.id !== nextSubmission.id)
				];
			}
			if (refresh.model.data) {
				const nextModel = refresh.model.data as ModelRegistryItem;
				models = models.map((item) => (item.id === nextModel.id ? nextModel : item));
			}
			addToast(refresh.result.notes ?? 'Round metrics refreshed.', 'success');
		} catch (e) {
			refreshError = asMessage(e, 'Round metrics refresh failed');
			addToast(refreshError, 'error');
		} finally {
			busy = false;
		}
	}

	async function removeModel(model: ModelRegistryItem, closeAfter = false, confirmFirst = false) {
		if (confirmFirst && !confirm(`Delete model "${model.name}"?`)) return;
		busy = true;
		try {
			await deleteRegistryModel(model.id);
			addToast('Model deleted', 'success');
			await load();
			if (closeAfter) closeDrawer();
		} catch (e) {
			addToast(asMessage(e, 'Failed to delete model'), 'error');
		} finally {
			busy = false;
		}
	}

	async function remove() {
		const d = drawer;
		if (d.kind !== 'edit') return;
		const m = models.find((mm) => mm.id === d.id);
		if (!m) return;
		await removeModel(m, true, true);
	}

	function asMessage(e: unknown, fallback: string) {
		return e instanceof Error ? e.message : fallback;
	}

	function fmtNum(value: number | null | undefined, digits = 4) {
		if (value == null) return '—';
		return value.toFixed(digits);
	}

	function fmtDate(value: string | null | undefined) {
		if (!value) return '—';
		try {
			return new Date(value).toLocaleString();
		} catch {
			return value;
		}
	}

	function latestSubmissionLabel(modelId: string) {
		return submissionStatusLabel(latestSubmissionForModel(modelId, submissions));
	}

	function stageName(stage: string | null | undefined): string {
		return modelStageLabels[(stage ?? 'draft') as ModelStage] ?? 'Draft';
	}
</script>

<svelte:head>
	<title>Models | Numerai Dashboard</title>
</svelte:head>

<AuthGate>
	<section class="models-page">
		<header class="page-head">
			<div>
				<p class="eyebrow">Models</p>
				<h1>Your registered Numerai models.</h1>
				<p class="lede">
					Register a model in the dashboard so submissions, scores, and lineage flow back into one
					place. Stages move manually here until a submission worker reports them.
				</p>
				<p class="round-cache" class:stale={roundFreshness === 'Round cache stale'}>
					{roundLabel(latestRound)} · {roundFreshness}
					{#if refreshError}
						<span>{refreshError}</span>
					{/if}
				</p>
			</div>
			<button type="button" class="primary" onclick={openNew}>Register model</button>
		</header>

		<nav class="view-tabs" aria-label="Models views">
			<button type="button" class:active={viewMode === 'registry'} onclick={() => (viewMode = 'registry')}>
				Registry
			</button>
			<button type="button" class:active={viewMode === 'lineage'} onclick={() => (viewMode = 'lineage')}>
				Lineage
			</button>
			<button type="button" class:active={viewMode === 'submit'} onclick={() => (viewMode = 'submit')}>
				Submit
			</button>
		</nav>

		{#if viewMode === 'registry'}
			<nav class="stage-tabs" aria-label="Stage filter">
				<button class:active={stageFilter === 'all'} onclick={() => (stageFilter = 'all')}>
					<span>All</span><strong>{models.length}</strong>
				</button>
				{#each modelStages as s (s)}
					<button class:active={stageFilter === s} onclick={() => (stageFilter = s)} data-stage={s}>
						<span>{modelStageLabels[s]}</span><strong>{stageCounts[s]}</strong>
					</button>
				{/each}
			</nav>

			<div class="models-shell" class:drawer-open={drawer.kind !== 'none'}>
				<div class="list-wrap">
					{#if loading}
						<p class="muted pad">Loading models…</p>
					{:else if models.length === 0}
						<div class="empty">
							<p class="eyebrow">No models yet</p>
							<h2>Register your first model.</h2>
							<p class="muted">
								Pick a name, paste the Numerai model ID if you have one, and set a stage. Metrics
								will populate as submissions land.
							</p>
							<button type="button" class="primary" onclick={openNew}>Register model</button>
						</div>
					{:else if filtered.length === 0}
						<p class="muted pad">No models in this stage.</p>
					{:else}
						<table>
							<thead>
								<tr>
									<th>Name</th>
									<th>Stage</th>
									<th>Numerai ID</th>
									<th class="num">Corr</th>
									<th class="num">MMC</th>
									<th class="num">Payout (NMR)</th>
									<th>Submission</th>
									<th>Last submitted</th>
									<th aria-label="Actions"></th>
								</tr>
							</thead>
							<tbody>
								{#each filtered as model (model.id)}
									<tr class="row" onclick={() => openEdit(model)}>
										<td>
											<strong>{model.name}</strong>
										</td>
										<td>
					<span class="stage-chip" data-stage={model.stage}>{stageName(model.stage)}</span>
										</td>
										<td class="mono small">{model.numeraiModelId || '—'}</td>
										<td class="num mono">{fmtNum(model.liveCorr)}</td>
										<td class="num mono">{fmtNum(model.liveMmc)}</td>
										<td class="num mono">{fmtNum(model.payoutNmr, 2)}</td>
										<td class="small">{latestSubmissionLabel(model.id)}</td>
										<td class="small">
											{model.lastSubmittedRound != null ? `r${model.lastSubmittedRound}` : '—'}
											<span class="muted">{fmtDate(model.lastSubmittedAt)}</span>
										</td>
										<td class="actions" onclick={(e) => e.stopPropagation()}>
											{#if model.stage !== 'live'}
												<button type="button" onclick={() => quickStage(model.id, 'live')} disabled={busy}>Promote</button>
											{:else}
												<button type="button" onclick={() => quickStage(model.id, 'retired')} disabled={busy}>Retire</button>
											{/if}
											{#if model.stage !== 'live' && model.stage !== 'retired'}
												<button type="button" onclick={() => quickStage(model.id, 'retired')} disabled={busy}>Archive</button>
											{/if}
											<button type="button" onclick={() => refreshModelMetrics(model)} disabled={busy}>
												Refresh
											</button>
											<button type="button" onclick={() => openEdit(model)}>Edit</button>
											<button
												type="button"
												class="icon-danger"
												aria-label={`Delete ${model.name}`}
												title="Delete model"
												onclick={() => removeModel(model)}
												disabled={busy}
											>
												×
											</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
				</div>

				{#if drawer.kind !== 'none'}
					<aside class="drawer">
						<header class="drawer-head">
							<div>
								<span class="eyebrow">{drawer.kind === 'new' ? 'Register' : 'Edit'}</span>
								<h2>{drawer.kind === 'new' ? 'New model' : editing?.name || 'Model'}</h2>
							</div>
							<button type="button" class="ghost" onclick={closeDrawer} aria-label="Close">✕</button>
						</header>

						{#if drawer.kind === 'edit' && editing}
							<dl class="kv">
								<dt>Live corr</dt><dd class="mono">{fmtNum(editing.liveCorr)}</dd>
								<dt>Live mmc</dt><dd class="mono">{fmtNum(editing.liveMmc)}</dd>
								<dt>Payout (NMR)</dt><dd class="mono">{fmtNum(editing.payoutNmr, 2)}</dd>
								<dt>Last round</dt><dd>{editing.lastSubmittedRound ?? '—'}</dd>
								<dt>Last submitted</dt><dd>{fmtDate(editing.lastSubmittedAt)}</dd>
							</dl>
							<p class="muted small">
								These fields update when a submission worker reports back. They aren't editable here.
							</p>
						{/if}

						<form class="form" onsubmit={save}>
							<label>
								<span>Name</span>
								<input type="text" bind:value={form.name} required placeholder="baseline-v4" />
							</label>
							<label>
								<span>Stage</span>
								<select bind:value={form.stage}>
									{#each modelStages as s (s)}
											<option value={s}>{modelStageLabels[s]}</option>
									{/each}
								</select>
							</label>
							<label>
								<span>Parent model</span>
								<select bind:value={form.parentModelId}>
									<option value="">— root (no parent) —</option>
									{#each models.filter((m) => drawer.kind !== 'edit' || m.id !== drawer.id) as p (p.id)}
										<option value={p.id}>{p.name}</option>
									{/each}
								</select>
							</label>
							<label>
								<span>Change summary</span>
								<input type="text" bind:value={form.changeSummary} placeholder="what changed from parent" />
							</label>
							<label>
								<span>Numerai model ID</span>
								<input type="text" bind:value={form.numeraiModelId} placeholder="optional · paste from numer.ai/models" />
							</label>
							<div class="form-actions">
								<button type="submit" class="primary" disabled={busy}>
									{busy ? 'Saving…' : drawer.kind === 'new' ? 'Register' : 'Save changes'}
								</button>
								{#if drawer.kind === 'edit'}
									<button type="button" class="danger" onclick={remove} disabled={busy}>Delete</button>
								{/if}
							</div>
						</form>
					</aside>
				{/if}
			</div>
		{:else if viewMode === 'lineage'}
			<ModelLineageView />
		{:else}
			<ModelSubmitView />
		{/if}
	</section>
</AuthGate>

<style>
	.models-page {
		display: grid;
		gap: 1rem;
	}

	.page-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 1rem;
		padding-bottom: 0.5rem;
	}
	.page-head .eyebrow {
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin: 0 0 0.35rem;
	}
	.page-head h1 {
		margin: 0 0 0.3rem;
		font-size: 1.5rem;
		line-height: 1.2;
	}
	.page-head .lede {
		color: var(--text-secondary);
		margin: 0;
		max-width: 60ch;
	}
	.round-cache {
		margin: 0.55rem 0 0;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 700;
	}
	.round-cache.stale {
		color: var(--orange);
	}
	.round-cache span {
		display: block;
		margin-top: 0.15rem;
		color: var(--red);
	}

	.stage-tabs {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.view-tabs {
		display: inline-flex;
		width: fit-content;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-card);
		overflow: hidden;
	}
	.view-tabs button {
		border: none;
		border-right: 1px solid var(--border-light);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 0.84rem;
		font-weight: 800;
		padding: 0.45rem 0.8rem;
		cursor: pointer;
	}
	.view-tabs button:last-child {
		border-right: none;
	}
	.view-tabs button:hover {
		background: var(--hover-bg);
	}
	.view-tabs button.active {
		background: var(--text);
		color: #fff;
	}
	.stage-tabs button {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-card);
		color: var(--text);
		font: inherit;
		font-size: 0.82rem;
		font-weight: 700;
		cursor: pointer;
	}
	.stage-tabs button:hover { background: var(--hover-bg); }
	.stage-tabs button.active {
		border-color: var(--text);
		background: var(--text);
		color: #fff;
	}
	.stage-tabs button strong {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		font-weight: 800;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.08);
	}
	.stage-tabs button.active strong { background: rgba(255, 255, 255, 0.2); }

	.models-shell {
		display: grid;
		grid-template-columns: 1fr 0;
		gap: 0;
		transition: grid-template-columns 0.25s ease;
		border: 1px solid var(--text);
		border-radius: 6px;
		background: var(--bg-card);
		box-shadow: 4px 4px 0 var(--text);
		overflow: hidden;
		min-height: 320px;
	}
	.models-shell.drawer-open { grid-template-columns: 1fr 380px; }

	.list-wrap {
		min-width: 0;
		overflow-x: auto;
	}

	table { width: 100%; border-collapse: collapse; }
	th {
		text-align: left;
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text-muted);
		padding: 0.7rem 0.85rem;
		background: var(--bg-page);
		border-bottom: 1px solid var(--text);
		white-space: nowrap;
	}
	th.num { text-align: right; }
	td {
		padding: 0.7rem 0.85rem;
		border-bottom: 1px solid var(--border-light);
		font-size: 0.85rem;
		vertical-align: middle;
	}
	td.num { text-align: right; font-variant-numeric: tabular-nums; }
	td.mono { font-family: var(--font-mono); }
	td.small { font-size: 0.78rem; color: var(--text-secondary); }
	td.small .muted { display: block; font-size: 0.72rem; }

	.row { cursor: pointer; }
	.row:hover { background: var(--hover-bg); }

	.actions { display: flex; gap: 0.35rem; justify-content: flex-end; }
	.actions button {
		font-size: 0.74rem;
		font-weight: 700;
		padding: 0.32rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-card);
		color: var(--text);
		cursor: pointer;
	}
	.actions button:hover:not(:disabled) { background: var(--hover-bg); }
	.actions .icon-danger {
		min-width: 1.85rem;
		padding-inline: 0.45rem;
		border-color: var(--red);
		color: var(--red);
		font-size: 1rem;
		line-height: 1;
	}
	.actions .icon-danger:hover:not(:disabled) {
		background: var(--badge-red);
	}

	.stage-chip {
		display: inline-block;
		font-family: var(--font-mono);
		font-size: 0.68rem;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		padding: 0.18rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg-input);
		color: var(--text);
		white-space: nowrap;
	}
		.stage-chip[data-stage='live'] {
			border-color: var(--green);
			background: var(--badge-green);
			color: var(--green);
		}
		.stage-chip[data-stage='success'] {
			border-color: var(--green);
			background: var(--badge-green);
			color: var(--green);
		}
		.stage-chip[data-stage='testing'] {
			border-color: var(--orange);
			background: var(--badge-orange);
			color: var(--orange);
		}
		.stage-chip[data-stage='training'] {
			border-color: var(--orange);
			background: var(--badge-orange);
			color: var(--orange);
		}
		.stage-chip[data-stage='failed'] {
			border-color: var(--red);
			background: var(--badge-red);
			color: var(--red);
		}
	.stage-chip[data-stage='retired'] {
		color: var(--text-muted);
	}

	.empty {
		display: grid;
		gap: 0.4rem;
		justify-items: start;
		padding: 2.5rem 1.5rem;
	}
	.empty .eyebrow {
		font-family: var(--font-mono);
		font-size: 0.7rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin: 0;
	}
	.empty h2 { margin: 0; font-size: 1.2rem; }
	.empty .muted { max-width: 50ch; }
	.empty .primary { margin-top: 0.4rem; }

	.muted { color: var(--text-muted); margin: 0; font-size: 0.85rem; }
	.pad { padding: 1rem 1.2rem; }

	.drawer {
		display: grid;
		grid-template-rows: auto 1fr;
		gap: 1rem;
		padding: 1rem 1.1rem 1.2rem;
		background: var(--bg-card);
		border-left: 1px solid var(--text);
		overflow-y: auto;
	}
	.drawer-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.5rem;
	}
	.drawer-head .eyebrow {
		font-family: var(--font-mono);
		font-size: 0.65rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
		display: block;
		margin-bottom: 0.15rem;
	}
	.drawer-head h2 { margin: 0; font-size: 1rem; }

	.kv {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.35rem 0.85rem;
		margin: 0 0 0.4rem;
		padding-bottom: 0.7rem;
		border-bottom: 1px solid var(--border-light);
	}
	.kv dt {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.62rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		align-self: center;
	}
	.kv dd { margin: 0; font-size: 0.85rem; }
	.small { font-size: 0.78rem; }

	.form { display: grid; gap: 0.7rem; }
	.form label { display: grid; gap: 0.3rem; font-size: 0.85rem; }
	.form label > span {
		color: var(--text-secondary);
		font-size: 0.74rem;
		font-weight: 700;
	}
	.form input,
	.form select {
		font: inherit;
		font-size: 0.88rem;
		padding: 0.5rem 0.65rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-input);
		color: var(--text);
	}
	.form-actions { display: flex; gap: 0.5rem; margin-top: 0.3rem; }

	button.primary {
		background: var(--text);
		color: #fff;
		border: 1px solid var(--text);
		border-radius: 4px;
		padding: 0.5rem 0.85rem;
		font-size: 0.85rem;
		font-weight: 700;
		cursor: pointer;
	}
	button.primary:hover:not(:disabled) { background: #303030; }
	button.primary:disabled { opacity: 0.6; cursor: not-allowed; }

	button.danger {
		font: inherit;
		font-size: 0.82rem;
		font-weight: 700;
		padding: 0.5rem 0.85rem;
		border: 1px solid var(--red);
		border-radius: 4px;
		background: var(--bg-card);
		color: var(--red);
		cursor: pointer;
	}
	button.danger:hover:not(:disabled) { background: var(--badge-red); }

	button.ghost {
		border: none;
		background: none;
		font-size: 1rem;
		padding: 0.25rem 0.4rem;
		cursor: pointer;
	}

	@media (max-width: 880px) {
		.models-shell { grid-template-columns: 1fr; }
		.models-shell.drawer-open { grid-template-columns: 1fr; }
		.drawer { border-left: none; border-top: 1px solid var(--text); }
		.page-head { flex-direction: column; align-items: flex-start; }
	}
</style>
