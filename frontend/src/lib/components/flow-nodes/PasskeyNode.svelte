<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	let {
		data,
		selected
	}: {
		data: { count: number; eyebrow?: string; label?: string; countLabel?: string };
		selected?: boolean;
	} = $props();
</script>

<div class="node" class:selected>
	<Handle type="target" position={Position.Top} id="top" />
	<div class="glyph">
		<svg viewBox="0 0 32 32" aria-hidden="true">
			<circle cx="13" cy="13" r="6" fill="none" stroke="currentColor" stroke-width="1.6" />
			<path d="M17 17 L26 26 M22 22 L24 20 M24 24 L26 22" fill="none" stroke="currentColor" stroke-width="1.6" />
		</svg>
	</div>
	<div class="text">
		<span class="eyebrow">{data.eyebrow ?? 'Sign-in'}</span>
		<strong>{data.label ?? 'Passkeys'}</strong>
		<span class="sub">{data.count} {data.countLabel ?? 'registered'}</span>
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

	.glyph {
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border: 1px solid var(--text);
		border-radius: 4px;
		background: var(--bg-page);
	}
	.glyph svg { width: 22px; height: 22px; }
	.text { display: grid; gap: 0.15rem; }
	.eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.text strong { font-size: 0.88rem; font-weight: 720; }
	.sub { font-size: 0.75rem; color: var(--text-secondary); }
</style>
