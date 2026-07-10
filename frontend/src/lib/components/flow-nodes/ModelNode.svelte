<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import { modelStageLabels, type ModelStage } from '$lib/services/registry-service';

	let {
		data,
		selected
	}: {
		data: {
			label: string;
			stage: ModelStage;
			numeraiModelId?: string | null;
			corr?: number | null;
			mmc?: number | null;
		};
		selected?: boolean;
	} = $props();

	function fmt(n: number | null | undefined) {
		return n == null ? '—' : n.toFixed(4);
	}
</script>

<div class="node" class:selected data-stage={data.stage}>
	<Handle type="target" position={Position.Top} />
	<span class="chip">{modelStageLabels[data.stage]}</span>
	<strong class="title">{data.label}</strong>
	{#if data.numeraiModelId}
		<span class="sub mono">{data.numeraiModelId.slice(0, 8)}…</span>
	{/if}
	<div class="metrics">
		<div><span class="mlabel">CORR</span><span class="mval mono">{fmt(data.corr)}</span></div>
		<div><span class="mlabel">MMC</span><span class="mval mono">{fmt(data.mmc)}</span></div>
	</div>
	<Handle type="source" position={Position.Bottom} />
</div>

<style>
	.node {
		min-width: 180px;
		display: grid;
		gap: 0.3rem;
		padding: 0.7rem 0.85rem;
		background: var(--bg-card);
		border: 1.5px solid var(--text);
		border-radius: 4px;
		color: var(--text);
		cursor: pointer;
		box-shadow: 3px 3px 0 var(--text);
		transition: transform 0.12s ease, box-shadow 0.12s ease;
	}
	.node:hover { transform: translate(-1px, -1px); box-shadow: 4px 4px 0 var(--text); }
	.node.selected { background: var(--bg-page); box-shadow: 5px 5px 0 var(--text); }

	.node[data-stage='retired'] { opacity: 0.6; }

	.chip {
		display: inline-block;
		font-family: var(--font-mono);
		font-size: 0.6rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		padding: 0.1rem 0.4rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--bg-input);
		justify-self: start;
	}
	.node[data-stage='live'] .chip {
		border-color: var(--green);
		background: var(--badge-green);
		color: var(--green);
	}
	.node[data-stage='success'] .chip {
		border-color: var(--green);
		background: var(--badge-green);
		color: var(--green);
	}
	.node[data-stage='testing'] .chip {
		border-color: var(--orange);
		background: var(--badge-orange);
		color: var(--orange);
	}
	.node[data-stage='training'] .chip {
		border-color: var(--orange);
		background: var(--badge-orange);
		color: var(--orange);
	}
	.node[data-stage='failed'] .chip {
		border-color: var(--red);
		background: var(--badge-red);
		color: var(--red);
	}

	.title {
		font-size: 0.92rem;
		font-weight: 720;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		font-size: 0.72rem;
		color: var(--text-secondary);
	}
	.mono { font-family: var(--font-mono); }

	.metrics {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.3rem;
		padding-top: 0.4rem;
		border-top: 1px solid var(--border-light);
		font-size: 0.72rem;
	}
	.metrics > div { display: flex; flex-direction: column; gap: 0.1rem; }
	.mlabel {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.mval { font-variant-numeric: tabular-nums; }
</style>
