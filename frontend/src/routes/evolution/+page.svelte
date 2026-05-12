<script lang="ts">
	import { onMount } from 'svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { authState } from '$lib/auth';
	import { dataClient } from '$lib/data';
	import { addToast } from '$lib/stores';
	import type { Schema } from '../../../amplify/data/resource';

	import { SvelteFlow, Background, Controls, type Node, type Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	import ModelNode from '$lib/components/flow-nodes/ModelNode.svelte';

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

	let selectedId = $state<string | null>(null);

	let form = $state({
		name: '',
		stage: 'draft' as Stage,
		parentModelId: '' as string,
		changeSummary: '',
		numeraiModelId: ''
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

	const selected = $derived(selectedId ? models.find((m) => m.id === selectedId) ?? null : null);
	const parentCandidates = $derived(models.filter((m) => m.id !== selectedId));

	const nodeTypes = { model: ModelNode };

	const { nodes, edges } = $derived.by(() => {
		const byId = new Map(models.map((m) => [m.id, m]));
		const childrenOf = new Map<string, ModelRegistryItem[]>();
		const roots: ModelRegistryItem[] = [];
		for (const m of models) {
			const pid = m.parentModelId ?? null;
			if (pid && byId.has(pid)) {
				const arr = childrenOf.get(pid) ?? [];
				arr.push(m);
				childrenOf.set(pid, arr);
			} else {
				roots.push(m);
			}
		}

		const xStep = 240;
		const yStep = 180;
		const positions = new Map<string, { x: number; y: number }>();
		let rootCursor = 0;

		function layout(m: ModelRegistryItem, depth: number, col: { v: number }) {
			const kids = (childrenOf.get(m.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
			if (kids.length === 0) {
				positions.set(m.id, { x: col.v * xStep, y: depth * yStep });
				col.v += 1;
				return col.v - 1;
			}
			const childCols: number[] = [];
			for (const k of kids) {
				childCols.push(layout(k, depth + 1, col));
			}
			const center = (childCols[0] + childCols[childCols.length - 1]) / 2;
			positions.set(m.id, { x: center * xStep, y: depth * yStep });
			return center;
		}

		for (const r of roots.sort((a, b) => a.name.localeCompare(b.name))) {
			const col = { v: rootCursor };
			layout(r, 0, col);
			rootCursor = col.v;
		}

		const ns: Node[] = models.map((m) => ({
			id: m.id,
			type: 'model',
			position: positions.get(m.id) ?? { x: 0, y: 0 },
			data: {
				label: m.name,
				stage: (m.stage as Stage) ?? 'draft',
				numeraiModelId: m.numeraiModelId,
				corr: m.liveCorr,
				mmc: m.liveMmc
			},
			selected: m.id === selectedId
		}));

		const es: Edge[] = [];
		for (const m of models) {
			if (m.parentModelId && byId.has(m.parentModelId)) {
				es.push({
					id: `e-${m.parentModelId}-${m.id}`,
					source: m.parentModelId,
					target: m.id,
					type: 'smoothstep',
					style: 'stroke: var(--text); stroke-width: 1.4;'
				});
			}
		}

		return { nodes: ns, edges: es };
	});

	function onNodeClick({ node }: { node: Node; event: MouseEvent | TouchEvent }) {
		const m = models.find((mm) => mm.id === node.id);
		if (!m) return;
		selectedId = m.id;
		form = {
			name: m.name ?? '',
			stage: (m.stage as Stage) ?? 'draft',
			parentModelId: m.parentModelId ?? '',
			changeSummary: m.changeSummary ?? '',
			numeraiModelId: m.numeraiModelId ?? ''
		};
	}

	function closeDrawer() {
		selectedId = null;
	}

	async function save(event: Event) {
		event.preventDefault();
		if (!selectedId) return;
		if (!form.name.trim()) {
			addToast('Name is required', 'error');
			return;
		}
		busy = true;
		try {
			await dataClient().models.ModelRegistryItem.update({
				id: selectedId,
				name: form.name.trim(),
				stage: form.stage,
				parentModelId: form.parentModelId || null,
				changeSummary: form.changeSummary.trim() || null,
				numeraiModelId: form.numeraiModelId.trim() || null
			});
			addToast('Model updated', 'success');
			await load();
		} catch (e) {
			addToast(asMessage(e, 'Failed to save model'), 'error');
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!selected) return;
		if (!confirm(`Delete model “${selected.name}”? Any children will lose their parent link.`)) return;
		busy = true;
		try {
			await dataClient().models.ModelRegistryItem.delete({ id: selected.id });
			selectedId = null;
			await load();
			addToast('Model deleted', 'success');
		} catch (e) {
			addToast(asMessage(e, 'Failed to delete model'), 'error');
		} finally {
			busy = false;
		}
	}

	function asMessage(e: unknown, fallback: string) {
		return e instanceof Error ? e.message : fallback;
	}

	function fmt(n: number | null | undefined, d = 4) {
		return n == null ? '—' : n.toFixed(d);
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
	<title>Evolution | Numerai Dashboard</title>
</svelte:head>

<AuthGate>
	<section class="evolution-page">
		<div class="flow-shell" class:drawer-open={selectedId !== null}>
			<div class="flow-canvas">
				{#if loading}
					<p class="loading-msg">Loading models…</p>
				{:else if models.length === 0}
					<div class="empty">
						<p class="eyebrow">Empty evolution</p>
						<h2>Register a model to start a tree.</h2>
						<p class="muted">
							Head to <a href="/models">Models</a>, register one, then come back here to set parents
							and watch the lineage take shape.
						</p>
					</div>
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

			{#if selected}
				<aside class="drawer">
					<header class="drawer-head">
						<div>
							<span class="eyebrow">Model</span>
							<h2>{selected.name}</h2>
						</div>
						<button type="button" class="ghost" onclick={closeDrawer} aria-label="Close">✕</button>
					</header>

					<dl class="kv">
						<dt>Stage</dt><dd><span class="stage-chip" data-stage={selected.stage}>{stageLabel[selected.stage as Stage]}</span></dd>
						<dt>Numerai ID</dt><dd class="mono">{selected.numeraiModelId || '—'}</dd>
						<dt>Live corr</dt><dd class="mono">{fmt(selected.liveCorr)}</dd>
						<dt>Live mmc</dt><dd class="mono">{fmt(selected.liveMmc)}</dd>
						<dt>Payout (NMR)</dt><dd class="mono">{fmt(selected.payoutNmr, 2)}</dd>
						<dt>Last round</dt><dd>{selected.lastSubmittedRound ?? '—'}</dd>
						<dt>Last submitted</dt><dd>{fmtDate(selected.lastSubmittedAt)}</dd>
					</dl>

					<form class="form" onsubmit={save}>
						<h3>Lineage</h3>
						<label>
							<span>Parent model</span>
							<select bind:value={form.parentModelId}>
								<option value="">— root (no parent) —</option>
								{#each parentCandidates as p (p.id)}
									<option value={p.id}>{p.name}</option>
								{/each}
							</select>
						</label>
						<label>
							<span>Change summary</span>
							<textarea bind:value={form.changeSummary} rows="3" placeholder="What changed from the parent?"></textarea>
						</label>

						<h3>Identity</h3>
						<label>
							<span>Name</span>
							<input type="text" bind:value={form.name} required />
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
							<span>Numerai model ID</span>
							<input type="text" bind:value={form.numeraiModelId} />
						</label>

						<div class="form-actions">
							<button type="submit" class="primary" disabled={busy}>
								{busy ? 'Saving…' : 'Save'}
							</button>
							<button type="button" class="danger" onclick={remove} disabled={busy}>Delete</button>
						</div>
					</form>
				</aside>
			{/if}
		</div>
	</section>
</AuthGate>

<style>
	.evolution-page { display: block; }

	.flow-shell {
		position: relative;
		display: grid;
		grid-template-columns: 1fr 0;
		gap: 0;
		transition: grid-template-columns 0.25s ease;
		height: calc(100vh - var(--nav-height, 88px));
		min-height: 480px;
		background: var(--bg-page);
		overflow: hidden;
	}
	.flow-shell.drawer-open { grid-template-columns: 1fr 380px; }

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
		color: var(--text-muted);
		margin: 0;
	}

	.empty {
		display: grid;
		gap: 0.4rem;
		justify-items: start;
		max-width: 38rem;
		margin: 4rem auto;
		padding: 1.5rem;
		border: 1px dashed var(--text);
		border-radius: 6px;
		background: var(--bg-card);
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
	.empty .muted { color: var(--text-secondary); margin: 0; }
	.empty a { color: var(--text); text-decoration: underline; }

	.drawer {
		display: grid;
		grid-template-rows: auto auto 1fr;
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
		gap: 0.3rem 0.85rem;
		margin: 0;
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
	.kv dd { margin: 0; font-size: 0.83rem; }

	.stage-chip {
		display: inline-block;
		font-family: var(--font-mono);
		font-size: 0.65rem;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		padding: 0.15rem 0.45rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg-input);
		color: var(--text);
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
	.stage-chip[data-stage='retired'] { color: var(--text-muted); }

	.mono { font-family: var(--font-mono); }

	.form { display: grid; gap: 0.65rem; }
	.form h3 {
		margin: 0.4rem 0 0;
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.form label { display: grid; gap: 0.25rem; font-size: 0.84rem; }
	.form label > span {
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 700;
	}
	.form input,
	.form select,
	.form textarea {
		font: inherit;
		font-size: 0.86rem;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-input);
		color: var(--text);
	}
	.form textarea { font-family: var(--font-mono); resize: vertical; }
	.form-actions { display: flex; gap: 0.5rem; margin-top: 0.3rem; }

	button {
		font: inherit;
		font-size: 0.82rem;
		font-weight: 700;
		padding: 0.5rem 0.85rem;
		border-radius: 4px;
		border: 1px solid var(--text);
		background: var(--bg-card);
		color: var(--text);
		cursor: pointer;
	}
	button:hover:not(:disabled) { background: var(--hover-bg); }
	button:disabled { opacity: 0.6; cursor: not-allowed; }
	button.primary { background: var(--text); color: #fff; }
	button.primary:hover:not(:disabled) { background: #303030; }
	button.danger { border-color: var(--red); color: var(--red); background: var(--bg-card); }
	button.danger:hover:not(:disabled) { background: var(--badge-red); }
	button.ghost { border: none; background: none; font-size: 1rem; padding: 0.25rem 0.4rem; }

	@media (max-width: 880px) {
		.flow-shell { grid-template-columns: 1fr; }
		.flow-shell.drawer-open { grid-template-columns: 1fr; }
		.drawer { border-left: none; border-top: 1px solid var(--text); }
	}
</style>
