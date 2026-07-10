<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children, tip }: { children: Snippet; tip: string } = $props();
	let show = $state(false);
	let el: HTMLSpanElement;
</script>

<span
	class="tooltip-wrap"
	bind:this={el}
	onmouseenter={() => (show = true)}
	onmouseleave={() => (show = false)}
	onfocusin={() => (show = true)}
	onfocusout={() => (show = false)}
>
	{@render children()}
	{#if show}
		<div class="tooltip-pop" role="tooltip">
			{tip}
		</div>
	{/if}
</span>

<style>
	.tooltip-wrap {
		position: relative;
		cursor: help;
	}

	.tooltip-pop {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		background: var(--bg-card, #fff);
		color: var(--text, #1f2328);
		border: 1px solid var(--border, #d1d9e0);
		border-radius: 8px;
		padding: 0.6rem 0.75rem;
		font-size: 0.75rem;
		line-height: 1.5;
		width: max-content;
		max-width: 300px;
		white-space: normal;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
		z-index: 100;
		pointer-events: none;
		animation: tooltip-in 0.15s ease-out;
	}

	@keyframes tooltip-in {
		from {
			opacity: 0;
			transform: translateX(-50%) translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}
	}
</style>
