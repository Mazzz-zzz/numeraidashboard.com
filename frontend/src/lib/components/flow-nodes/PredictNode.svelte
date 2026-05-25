<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	type NodeStatus = 'ready' | 'blocked' | 'idle' | 'running';
	type NodeIcon = 'model' | 'artifact' | 'provider' | 'inference' | 'check' | 'upload' | 'record';

	let {
		data,
		selected
	}: {
		data: {
			label: string;
			eyebrow: string;
			sub: string;
			status: NodeStatus;
			statusLabel: string;
			icon: NodeIcon;
		};
		selected?: boolean;
	} = $props();
</script>

<div class="node" class:selected data-status={data.status}>
	<Handle type="target" position={Position.Left} />
	<div class="glyph" aria-hidden="true">
		{#if data.icon === 'model'}
			<svg viewBox="0 0 32 32">
				<rect x="7" y="7" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.6" />
				<path d="M11 13h10M11 17h10M11 21h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
			</svg>
		{:else if data.icon === 'artifact'}
			<svg viewBox="0 0 32 32">
				<path d="M9 7h10l4 4v14H9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
				<path d="M19 7v5h5M12 18h8M12 22h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
			</svg>
		{:else if data.icon === 'provider'}
			<svg viewBox="0 0 32 32">
				<polygon points="16,6 25,11 25,21 16,26 7,21 7,11" fill="none" stroke="currentColor" stroke-width="1.6" />
				<circle cx="16" cy="16" r="3" fill="currentColor" />
			</svg>
		{:else if data.icon === 'inference'}
			<svg viewBox="0 0 32 32">
				<path d="M7 16h15M17 10l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
				<path d="M9 8h4M9 24h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
			</svg>
		{:else if data.icon === 'check'}
			<svg viewBox="0 0 32 32">
				<circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" stroke-width="1.6" />
				<path d="M11 16.5l3.2 3.2L21.5 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		{:else if data.icon === 'upload'}
			<svg viewBox="0 0 32 32">
				<path d="M16 23V9M11 14l5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
				<path d="M8 23v3h16v-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		{:else}
			<svg viewBox="0 0 32 32">
				<path d="M9 8h14v18H9z" fill="none" stroke="currentColor" stroke-width="1.6" />
				<path d="M12 13h8M12 17h8M12 21h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
			</svg>
		{/if}
	</div>
	<div class="text">
		<span class="eyebrow">{data.eyebrow}</span>
		<strong>{data.label}</strong>
		<span class="sub">{data.sub}</span>
	</div>
	<span class="status">{data.statusLabel}</span>
	<Handle type="source" position={Position.Right} />
</div>

<style>
	.node {
		position: relative;
		display: grid;
		grid-template-columns: 42px minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.7rem;
		min-width: 250px;
		max-width: 290px;
		padding: 0.72rem 0.82rem;
		background: var(--bg-card);
		border: 1.5px solid var(--text);
		border-radius: 4px;
		color: var(--text);
		cursor: pointer;
		box-shadow: 3px 3px 0 var(--text);
		transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
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
	.glyph svg { width: 25px; height: 25px; }

	.text {
		display: grid;
		gap: 0.15rem;
		min-width: 0;
	}
	.eyebrow {
		font-family: var(--font-mono);
		font-size: 0.58rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.text strong {
		font-size: 0.88rem;
		font-weight: 720;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		font-size: 0.73rem;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.status {
		align-self: start;
		font-family: var(--font-mono);
		font-size: 0.58rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		padding: 0.14rem 0.36rem;
		border: 1px solid currentColor;
		border-radius: 3px;
		color: var(--text-muted);
		background: var(--bg-page);
		white-space: nowrap;
	}
	.node[data-status='ready'] .status { color: var(--green); background: var(--badge-green); }
	.node[data-status='blocked'] .status { color: var(--red); background: var(--badge-red); }
	.node[data-status='running'] .status { color: var(--orange); background: var(--badge-orange); }
</style>
