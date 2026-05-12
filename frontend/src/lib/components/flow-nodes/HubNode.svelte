<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	let { data, selected }: { data: { label: string; sub: string }; selected?: boolean } = $props();
</script>

<div class="node" class:selected>
	<Handle type="target" position={Position.Left} />
	<svg class="mark" viewBox="0 0 60 60" aria-hidden="true">
		<g transform="translate(30 30)">
			<polygon points="0,-22 22,0 0,22 -22,0" fill="none" stroke="currentColor" stroke-width="1.6" />
			<polygon points="0,-12 12,0 0,12 -12,0" fill="currentColor" />
		</g>
	</svg>
	<div class="text">
		<span class="eyebrow">Workspace</span>
		<strong>{data.label}</strong>
		<span class="sub">{data.sub}</span>
	</div>
	<Handle type="source" position={Position.Right} />
	<Handle type="source" position={Position.Bottom} id="bottom" />
</div>

<style>
	.node {
		display: grid;
		justify-items: center;
		text-align: center;
		gap: 0.45rem;
		padding: 1rem 1rem 0.95rem;
		min-width: 200px;
		background: var(--bg-page);
		border: 2px solid var(--text);
		border-radius: 6px;
		color: var(--text);
		box-shadow: 4px 4px 0 var(--text);
	}
	.node.selected { box-shadow: 5px 5px 0 var(--text); }
	.mark { width: 60px; height: 60px; }
	.text { display: grid; gap: 0.18rem; }
	.eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.text strong { font-size: 0.95rem; font-weight: 720; }
	.sub {
		font-size: 0.74rem;
		color: var(--text-secondary);
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
