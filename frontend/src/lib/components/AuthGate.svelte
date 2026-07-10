<script lang="ts">
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { authState, refreshAuth } from '$lib/auth';

	let { children }: { children: Snippet } = $props();

	onMount(() => {
		refreshAuth();
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		if (!$authState.loading && !$authState.user) {
			const next = `${window.location.pathname}${window.location.search}`;
			goto(`/login?next=${encodeURIComponent(next)}`);
		}
	});
</script>

{#if $authState.loading}
	<div class="auth-state">
		<span>Checking session</span>
		<strong>Loading workspace…</strong>
	</div>
{:else if $authState.user}
	{@render children()}
{:else}
	<div class="auth-state">
		<span>Private workspace</span>
		<strong>Sign in to continue.</strong>
		<a href="/login">Open sign in</a>
	</div>
{/if}

<style>
	.auth-state {
		display: grid;
		gap: 0.6rem;
		max-width: 34rem;
		margin: 5rem auto;
		padding: 1.25rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		box-shadow: var(--shadow-md);
	}

	.auth-state span {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.auth-state strong {
		font-size: 1.35rem;
	}

	.auth-state a {
		justify-self: start;
		border: 1px solid var(--text);
		border-radius: 6px;
		background: var(--text);
		color: #fff;
		padding: 0.55rem 0.85rem;
		font-size: 0.88rem;
		font-weight: 720;
		text-decoration: none;
	}
</style>
