<script lang="ts">
	import { onMount } from 'svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { authState } from '$lib/auth';
	import { dataClient } from '$lib/data';
	import { addToast } from '$lib/stores';
	import type { Schema } from '../../../amplify/data/resource';

	type ModelRegistryItem = Schema['ModelRegistryItem']['type'];
	type Stage = 'draft' | 'testing' | 'live' | 'retired';
	const stages: Stage[] = ['draft', 'testing', 'live', 'retired'];
	const stageLabel: Record<Stage, string> = {
		draft: 'Draft',
		testing: 'Testing',
		live: 'Live',
		retired: 'Retired'
	};

	let models = $state<ModelRegistryItem[]>([]);
	let loading = $state(true);
	let stageFilter = $state<Stage | 'all'>('all');

	type Drawer =
		| { kind: 'none' }
		| { kind: 'new' }
		| { kind: 'edit'; id: string };
	let drawer = $state<Drawer>({ kind: 'none' });

	let form = $state({
		name: '',
		stage: 'draft' as Stage,
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
			const { data } = await dataClient().models.ModelRegistryItem.list();
			models = (data ?? []) as ModelRegistryItem[];
		} catch (e) {
			addToast(asMessage(e, 'Failed to load models'), 'error');
		} finally {
			loading = false;
		}
	}

	const filtered = $derived(
		stageFilter === 'all' ? models : models.filter((m) => (m.stage as Stage) === stageFilter)
	);
	const stageCounts = $derived({
		draft: models.filter((m) => m.stage === 'draft').length,
		testing: models.filter((m) => m.stage === 'testing').length,
		live: models.filter((m) => m.stage === 'live').length,
		retired: models.filter((m) => m.stage === 'retired').length
	});
	const editing = $derived.by(() => {
		const d = drawer;
		if (d.kind !== 'edit') return null;
		return models.find((m) => m.id === d.id) ?? null;
	});

	function openNew() {
		form = { name: '', stage: 'draft', numeraiModelId: '', parentModelId: '', changeSummary: '' };
		drawer = { kind: 'new' };
	}

	function openEdit(model: ModelRegistryItem) {
		form = {
			name: model.name ?? '',
			stage: (model.stage as Stage) ?? 'draft',
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
			const payload = {
				name: form.name.trim(),
				stage: form.stage,
				numeraiModelId: form.numeraiModelId.trim() || null,
				parentModelId: form.parentModelId || null,
				changeSummary: form.changeSummary.trim() || null
			};
			if (d.kind === 'edit') {
				await dataClient().models.ModelRegistryItem.update({ id: d.id, ...payload });
				addToast('Model updated', 'success');
			} else {
				await dataClient().models.ModelRegistryItem.create(payload);
				addToast(`${payload.name} registered`, 'success');
			}
			await load();
			closeDrawer();
		} catch (e) {
			addToast(asMessage(e, 'Failed to save model'), 'error');
		} finally {
			busy = false;
		}
	}

	async function quickStage(id: string, stage: Stage) {
		busy = true;
		try {
			await dataClient().models.ModelRegistryItem.update({ id, stage });
			await load();
		} catch (e) {
			addToast(asMessage(e, 'Failed to change stage'), 'error');
		} finally {
			busy = false;
		}
	}

	async function remove() {
		const d = drawer;
		if (d.kind !== 'edit') return;
		const m = models.find((mm) => mm.id === d.id);
		if (!m) return;
		if (!confirm(`Delete model “${m.name}”?`)) return;
		busy = true;
		try {
			await dataClient().models.ModelRegistryItem.delete({ id: d.id });
			addToast('Model deleted', 'success');
			await load();
			closeDrawer();
		} catch (e) {
			addToast(asMessage(e, 'Failed to delete model'), 'error');
		} finally {
			busy = false;
		}
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
</script>

<svelte:head>
	<title>Models | Numerai Dashboard</title>
</svelte:head>

<AuthGate>
	<section class="models-page">
		<header class="page-head">
			<div>
				<p class="eyebrow">Models · Registry</p>
				<h1>Your registered Numerai models.</h1>
				<p class="lede">
					Register a model in the dashboard so submissions, scores, and lineage flow back into one
					place. Stages move manually here until a submission worker reports them.
				</p>
			</div>
			<button type="button" class="primary" onclick={openNew}>Register model</button>
		</header>

		<nav class="stage-tabs" aria-label="Stage filter">
			<button class:active={stageFilter === 'all'} onclick={() => (stageFilter = 'all')}>
				<span>All</span><strong>{models.length}</strong>
			</button>
			{#each stages as s (s)}
				<button class:active={stageFilter === s} onclick={() => (stageFilter = s)} data-stage={s}>
					<span>{stageLabel[s]}</span><strong>{stageCounts[s]}</strong>
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
										<span class="stage-chip" data-stage={model.stage}>{stageLabel[model.stage as Stage]}</span>
									</td>
									<td class="mono small">{model.numeraiModelId || '—'}</td>
									<td class="num mono">{fmtNum(model.liveCorr)}</td>
									<td class="num mono">{fmtNum(model.liveMmc)}</td>
									<td class="num mono">{fmtNum(model.payoutNmr, 2)}</td>
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
										<button type="button" onclick={() => openEdit(model)}>Edit</button>
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
								{#each stages as s (s)}
									<option value={s}>{stageLabel[s]}</option>
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

	.stage-tabs {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
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
	.stage-chip[data-stage='testing'] {
		border-color: var(--orange);
		background: var(--badge-orange);
		color: var(--orange);
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
