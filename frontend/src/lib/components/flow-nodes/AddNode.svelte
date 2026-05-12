<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	let { data, selected }: { data: { label: string }; selected?: boolean } = $props();
</script>

<div class="node" class:selected>
	<Handle type="target" position={Position.Left} />
	<div class="glyph">+</div>
	<div class="text">
		<span class="eyebrow">Add</span>
		<strong>{data.label}</strong>
	</div>
</div>

<style>
	.node {
		display: grid;
		grid-template-columns: 40px 1fr;
		align-items: center;
		gap: 0.7rem;
		padding: 0.65rem 0.85rem;
		min-width: 180px;
		background: var(--bg-page);
		border: 1.5px dashed var(--text);
		border-radius: 4px;
		color: var(--text);
		cursor: pointer;
		transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
	}
	.node:hover { background: var(--bg-card); transform: translate(-1px, -1px); box-shadow: 3px 3px 0 var(--text); }
	.node.selected { background: var(--bg-card); box-shadow: 4px 4px 0 var(--text); }

	.glyph {
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border: 1px solid var(--text);
		border-radius: 4px;
		background: var(--bg-card);
		font-family: var(--font-mono);
		font-size: 1.4rem;
		font-weight: 800;
	}
	.text { display: grid; gap: 0.15rem; }
	.eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.text strong { font-size: 0.85rem; font-weight: 720; }
</style>
