<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	let { data, selected }: { data: { label: string; sub: string; linked: boolean }; selected?: boolean } = $props();
</script>

<div class="node" class:linked={data.linked} class:selected>
	<svg class="mark" viewBox="0 0 40 40" aria-hidden="true">
		<g transform="translate(20 20) rotate(45)">
			<rect x="-12" y="-12" width="24" height="24" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
			<line x1="-12" y1="0" x2="12" y2="0" stroke="currentColor" stroke-width="1" />
			<line x1="0" y1="-12" x2="0" y2="12" stroke="currentColor" stroke-width="1" />
		</g>
	</svg>
	<div class="text">
		<span class="eyebrow">Source · Numerai</span>
		<strong>{data.label}</strong>
		<span class="sub">{data.sub}</span>
	</div>
	<span class="dot" class:on={data.linked}></span>
	<Handle type="source" position={Position.Right} />
</div>

<style>
	.node {
		position: relative;
		display: grid;
		grid-template-columns: 44px 1fr auto;
		align-items: center;
		gap: 0.7rem;
		padding: 0.7rem 0.85rem;
		min-width: 200px;
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

	.mark {
		width: 38px;
		height: 38px;
		border: 1px solid var(--text);
		border-radius: 4px;
		padding: 3px;
		background: var(--bg-page);
	}
	.text { display: grid; gap: 0.15rem; min-width: 0; }
	.eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.text strong { font-size: 0.9rem; font-weight: 720; }
	.sub {
		font-size: 0.75rem;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-muted);
	}
	.dot.on { background: var(--green); box-shadow: 0 0 0 2px rgba(26, 127, 55, 0.18); }
</style>
