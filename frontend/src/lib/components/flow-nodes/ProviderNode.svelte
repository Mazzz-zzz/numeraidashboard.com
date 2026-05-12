<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	type ProviderType = 'prime_intellect' | 'modal' | 'sagemaker' | 'local' | 'custom';
	let {
		data,
		selected
	}: {
		data: { label: string; providerType: ProviderType | string; sub: string };
		selected?: boolean;
	} = $props();

	const typeLabel: Record<string, string> = {
		prime_intellect: 'Prime Intellect',
		modal: 'Modal',
		sagemaker: 'SageMaker',
		local: 'Local',
		custom: 'Custom'
	};
</script>

<div class="node" class:selected data-type={data.providerType}>
	<Handle type="target" position={Position.Left} />
	<div class="glyph">
		{#if data.providerType === 'prime_intellect'}
			<svg viewBox="0 0 32 32" aria-hidden="true">
				<rect x="6" y="9" width="20" height="2.2" fill="currentColor" />
				<rect x="9" y="11" width="2.2" height="14" fill="currentColor" />
				<rect x="20.8" y="11" width="2.2" height="14" fill="currentColor" />
			</svg>
		{:else if data.providerType === 'modal'}
			<svg viewBox="0 0 32 32" aria-hidden="true">
				<path d="M8 7 L25 16 L8 25 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
			</svg>
		{:else if data.providerType === 'sagemaker'}
			<svg viewBox="0 0 32 32" aria-hidden="true">
				<g transform="translate(16 16)">
					<polygon points="0,-10 9,-5 0,0 -9,-5" fill="none" stroke="currentColor" stroke-width="1.4" />
					<polygon points="0,0 9,-5 9,5 0,10" fill="none" stroke="currentColor" stroke-width="1.4" />
					<polygon points="0,0 -9,-5 -9,5 0,10" fill="none" stroke="currentColor" stroke-width="1.4" />
				</g>
			</svg>
		{:else if data.providerType === 'local'}
			<svg viewBox="0 0 32 32" aria-hidden="true">
				<rect x="6" y="8" width="20" height="13" fill="none" stroke="currentColor" stroke-width="1.6" />
				<rect x="11" y="23" width="10" height="1.6" fill="currentColor" />
			</svg>
		{:else}
			<svg viewBox="0 0 32 32" aria-hidden="true">
				<polygon points="16,6 26,11 26,21 16,26 6,21 6,11" fill="none" stroke="currentColor" stroke-width="1.6" />
			</svg>
		{/if}
	</div>
	<div class="text">
		<span class="eyebrow">{typeLabel[data.providerType] ?? 'Provider'}</span>
		<strong>{data.label}</strong>
		<span class="sub">{data.sub}</span>
	</div>
	<span class="dot on"></span>
</div>

<style>
	.node {
		position: relative;
		display: grid;
		grid-template-columns: 40px 1fr auto;
		align-items: center;
		gap: 0.7rem;
		padding: 0.65rem 0.85rem;
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

	.glyph {
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border: 1px solid var(--text);
		border-radius: 4px;
		background: var(--bg-page);
	}
	.glyph svg { width: 24px; height: 24px; }
	.text { display: grid; gap: 0.15rem; min-width: 0; }
	.eyebrow {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.text strong { font-size: 0.88rem; font-weight: 720; }
	.sub {
		font-size: 0.74rem;
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
