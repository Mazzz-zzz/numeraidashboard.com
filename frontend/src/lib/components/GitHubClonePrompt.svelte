<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, Copy, ExternalLink, GitFork, X } from '@lucide/svelte';
	import { addToast } from '$lib/stores';

	const repositoryUrl = 'https://github.com/Mazzz-zzz/numeraidashboard.com';
	const cloneCommand = `git clone ${repositoryUrl}.git`;
	const storageKey = 'numeraidashboard.clone-popup.dismissed.v1';

	let open = $state(false);
	let copied = $state(false);
	let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		let popupTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (localStorage.getItem(storageKey) !== 'true') {
				popupTimer = setTimeout(() => (open = true), 700);
			}
		} catch {
			popupTimer = setTimeout(() => (open = true), 700);
		}

		return () => {
			if (popupTimer) clearTimeout(popupTimer);
			if (copyResetTimer) clearTimeout(copyResetTimer);
		};
	});

	function dismiss() {
		open = false;
		copied = false;
		try {
			localStorage.setItem(storageKey, 'true');
		} catch {
			// The dismissal still applies for the current page when storage is unavailable.
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && open) dismiss();
	}

	async function copyCommand() {
		try {
			await navigator.clipboard.writeText(cloneCommand);
			copied = true;
			if (copyResetTimer) clearTimeout(copyResetTimer);
			copyResetTimer = setTimeout(() => (copied = false), 1800);
		} catch {
			addToast('Could not copy the clone command.', 'error');
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<aside class="clone-popup" aria-labelledby="clone-popup-title">
		<header class="popup-header">
			<div class="popup-title">
				<GitFork size={22} strokeWidth={2} aria-hidden="true" />
				<div>
					<span>Open source</span>
					<h2 id="clone-popup-title">Clone on GitHub</h2>
				</div>
			</div>
			<button
				type="button"
				class="close-button"
				onclick={dismiss}
				aria-label="Dismiss clone prompt"
				title="Dismiss"
			>
				<X size={18} strokeWidth={2} aria-hidden="true" />
			</button>
		</header>

		<p class="repository">Mazzz-zzz / numeraidashboard.com</p>
		<div class="command">
			<code>{cloneCommand}</code>
			<button
				type="button"
				class:copied
				onclick={copyCommand}
				aria-label={copied ? 'Clone command copied' : 'Copy clone command'}
				title={copied ? 'Copied' : 'Copy clone command'}
			>
				{#if copied}
					<Check size={17} strokeWidth={2.25} aria-hidden="true" />
				{:else}
					<Copy size={17} strokeWidth={2} aria-hidden="true" />
				{/if}
			</button>
		</div>

		<a class="github-link" href={repositoryUrl} target="_blank" rel="noreferrer">
			Open GitHub
			<ExternalLink size={16} strokeWidth={2} aria-hidden="true" />
		</a>
		<span class="visually-hidden" aria-live="polite">{copied ? 'Clone command copied.' : ''}</span>
	</aside>
{/if}

<style>
	.clone-popup {
		position: fixed;
		right: max(1rem, calc((100vw - 1280px) / 2 + 1.5rem));
		bottom: max(1.25rem, env(safe-area-inset-bottom));
		z-index: 70;
		box-sizing: border-box;
		width: min(27rem, calc(100vw - 2rem));
		padding: 1rem;
		border: 1px solid var(--text);
		border-radius: 8px;
		background: #fff;
		box-shadow: 6px 6px 0 var(--text);
		animation: popup-in 0.18s ease-out;
	}

	.popup-header,
	.popup-title,
	.github-link {
		display: flex;
		align-items: center;
	}

	.popup-header {
		justify-content: space-between;
		gap: 1rem;
	}

	.popup-title {
		min-width: 0;
		gap: 0.7rem;
	}

	.popup-title span {
		display: block;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	h2 {
		margin: 0.18rem 0 0;
		font-size: 1.18rem;
		font-weight: 760;
		line-height: 1.1;
	}

	.close-button,
	.command button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: #fff;
		color: var(--text);
		cursor: pointer;
	}

	.close-button {
		width: 2rem;
		height: 2rem;
	}

	.close-button:hover,
	.command button:hover {
		border-color: var(--text);
		background: var(--hover-bg);
	}

	.repository {
		margin: 0.9rem 0 0.55rem;
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 0.76rem;
		font-weight: 700;
	}

	.command {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.55rem 0.55rem 0.55rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
	}

	.command code {
		min-width: 0;
		color: var(--text);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.command button {
		width: 2.15rem;
		height: 2.15rem;
	}

	.command button.copied {
		border-color: rgba(26, 127, 55, 0.35);
		background: var(--badge-green);
		color: var(--green);
	}

	.github-link {
		width: fit-content;
		gap: 0.45rem;
		margin-top: 0.8rem;
		color: var(--text);
		font-size: 0.82rem;
		font-weight: 760;
		text-decoration: none;
	}

	.github-link:hover {
		text-decoration: underline;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@keyframes popup-in {
		from {
			opacity: 0;
			transform: translateY(0.5rem);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (max-width: 640px) {
		.clone-popup {
			left: 1rem;
			right: 1rem;
			bottom: max(1rem, env(safe-area-inset-bottom));
			width: auto;
			box-shadow: 4px 4px 0 var(--text);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.clone-popup {
			animation: none;
		}
	}
</style>
