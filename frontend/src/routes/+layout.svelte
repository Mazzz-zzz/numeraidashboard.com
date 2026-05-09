<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import Toast from '$lib/components/Toast.svelte';
	import { authState, refreshAuth, registerPasskey, signOut } from '$lib/auth';

	let { children } = $props();
	let menuOpen = $state(false);
	let userMenuOpen = $state(false);
	let passkeyStatus = $state<string | null>(null);

	onMount(() => {
		refreshAuth();
	});

	function closeMenu() {
		menuOpen = false;
		userMenuOpen = false;
	}

	async function handleSignOut() {
		await signOut();
		closeMenu();
		goto('/');
	}

	async function handleRegisterPasskey() {
		passkeyStatus = 'Registering…';
		try {
			await registerPasskey();
			passkeyStatus = 'Passkey added';
			setTimeout(() => (passkeyStatus = null), 3000);
		} catch (e) {
			passkeyStatus = e instanceof Error ? e.message : 'Failed to add passkey';
			setTimeout(() => (passkeyStatus = null), 5000);
		}
	}
</script>

<div class="app">
	<nav>
		<div class="nav-top">
			<a href="/" class="nav-brand" title="Numerai Dashboard" onclick={closeMenu}>
				<span class="brand-mark">N</span>
				<span>Numerai Dashboard</span>
			</a>

			<div class="nav-top-right">
				{#if $authState.user}
					<div class="user-menu">
						<button
							type="button"
							class="user-btn"
							onclick={() => (userMenuOpen = !userMenuOpen)}
							aria-haspopup="menu"
							aria-expanded={userMenuOpen}
						>
							<span class="avatar">{($authState.email ?? '?')[0].toUpperCase()}</span>
							<span class="user-email">{$authState.email}</span>
						</button>
						{#if userMenuOpen}
							<div class="user-dropdown" role="menu">
								<button type="button" role="menuitem" onclick={handleRegisterPasskey}>Add passkey</button>
								{#if passkeyStatus}<div class="passkey-status">{passkeyStatus}</div>{/if}
								<button type="button" role="menuitem" onclick={handleSignOut}>Sign out</button>
							</div>
						{/if}
					</div>
				{:else}
					<a href="/login" class="login-btn" onclick={closeMenu}>Sign in</a>
				{/if}
				<button
					class="hamburger"
					class:open={menuOpen}
					onclick={() => menuOpen = !menuOpen}
					aria-label={menuOpen ? 'Close menu' : 'Open menu'}
					aria-expanded={menuOpen}
				>
					<span class="hamburger-line"></span>
					<span class="hamburger-line"></span>
					<span class="hamburger-line"></span>
				</button>
			</div>
		</div>

		<div class="nav-body" class:open={menuOpen}>
			<div class="nav-links">
				<a href="/" class:active={$page.url.pathname === '/'} onclick={closeMenu}>Overview</a>
				{#if $authState.user}
					<a href="/builder" class:active={$page.url.pathname === '/builder'} onclick={closeMenu}>Builder</a>
					<a href="/models" class:active={$page.url.pathname === '/models'} onclick={closeMenu}>Models</a>
					<a href="/compute" class:active={$page.url.pathname === '/compute'} onclick={closeMenu}>Compute</a>
				{/if}
			</div>
		</div>
	</nav>

	{#if menuOpen}
		<button class="nav-overlay" onclick={closeMenu} aria-label="Close menu" tabindex="-1"></button>
	{/if}

	<main>
		{@render children()}
	</main>
</div>

<Toast />

<style>
	:global(:root) {
		--bg-page: #fbfaf7;
		--bg-card: #ffffff;
		--bg-input: #f7f6f2;
		--bg-nav: #ffffff;
		--border: #d9d4ca;
		--border-light: #ece7dd;
		--border-strong: #171717;
		--text: #171717;
		--text-secondary: #5d5a52;
		--text-muted: #8b8579;
		--blue: #171717;
		--green: #1a7f37;
		--red: #cf222e;
		--orange: #b45309;
		--purple: #6d28d9;
		--yellow: #946200;
		--hover-bg: #f5f2eb;
		--badge-blue: rgba(23, 23, 23, 0.06);
		--badge-green: rgba(26, 127, 55, 0.1);
		--badge-orange: rgba(180, 83, 9, 0.1);
		--badge-red: rgba(207, 34, 46, 0.09);
		--badge-muted: rgba(101, 109, 118, 0.08);
		--shadow-sm: 0 1px 0 rgba(23, 23, 23, 0.04);
		--shadow-md: 0 12px 32px rgba(23, 23, 23, 0.08);
		--shadow-lg: 0 24px 70px rgba(23, 23, 23, 0.12);
		--font-mono: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
	}

	:global(body) {
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		background:
			linear-gradient(rgba(23, 23, 23, 0.035) 1px, transparent 1px),
			linear-gradient(90deg, rgba(23, 23, 23, 0.035) 1px, transparent 1px),
			var(--bg-page);
		background-size: 44px 44px;
		color: var(--text);
		text-rendering: optimizeLegibility;
	}

	.app { min-height: 100vh; }

	nav {
		background: rgba(255, 255, 255, 0.92);
		background: color-mix(in srgb, var(--bg-nav) 92%, transparent);
		border-bottom: 1px solid var(--border);
		position: sticky;
		top: 0;
		z-index: 50;
		backdrop-filter: blur(18px);
	}

	.nav-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		max-width: 1280px;
		margin: 0 auto;
		padding: 0.75rem 1.5rem 0.45rem;
	}

	.nav-brand {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.95rem;
		font-weight: 760;
		color: var(--text);
		text-decoration: none;
		letter-spacing: 0;
	}

	.brand-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.85rem;
		height: 1.85rem;
		border: 1px solid var(--text);
		border-radius: 6px;
		background: var(--text);
		color: #fff;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		font-weight: 800;
	}

	.nav-top-right { display: flex; align-items: center; gap: 0.75rem; }

	.login-btn {
		background: var(--text);
		color: white;
		text-decoration: none;
		padding: 0.45rem 0.85rem;
		border-radius: 6px;
		border: 1px solid var(--text);
		font-size: 0.8rem;
		font-weight: 700;
		transition: background 0.15s;
	}
	.login-btn:hover { background: #303030; }

	.user-menu { position: relative; }

	.user-btn {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.25rem 0.55rem 0.25rem 0.3rem;
		cursor: pointer;
		font-size: 0.85rem;
		color: var(--text);
		transition: background 0.15s;
	}
	.user-btn:hover { background: var(--hover-bg); }

	.avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		border-radius: 50%;
		background: var(--text);
		color: white;
		font-weight: 600;
		font-size: 0.8rem;
	}

	.user-email {
		max-width: 14rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.user-dropdown {
		position: absolute;
		right: 0;
		top: calc(100% + 0.4rem);
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: var(--shadow-md);
		min-width: 9rem;
		padding: 0.25rem;
		z-index: 60;
	}

	.user-dropdown button {
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		padding: 0.5rem 0.6rem;
		font-size: 0.85rem;
		color: var(--text);
		cursor: pointer;
		border-radius: 4px;
	}
	.user-dropdown button:hover { background: var(--hover-bg); }

	.passkey-status {
		font-size: 0.75rem;
		color: var(--text-secondary);
		padding: 0.3rem 0.6rem;
		border-bottom: 1px solid var(--border-light);
	}

	@media (max-width: 480px) {
		.user-email { max-width: 6rem; }
	}

	.hamburger {
		display: none;
		flex-direction: column;
		justify-content: center;
		gap: 4px;
		width: 2.5rem;
		height: 2.5rem;
		padding: 0;
		background: none;
		border: none;
		cursor: pointer;
		border-radius: 6px;
		align-items: center;
		transition: background 0.15s;
	}

	.hamburger:hover { background: var(--hover-bg); }

	.hamburger-line {
		display: block;
		width: 18px;
		height: 2px;
		background: var(--text);
		border-radius: 1px;
		transition: transform 0.25s, opacity 0.2s;
	}

	.hamburger.open .hamburger-line:nth-child(1) { transform: translateY(6px) rotate(45deg); }
	.hamburger.open .hamburger-line:nth-child(2) { opacity: 0; }
	.hamburger.open .hamburger-line:nth-child(3) { transform: translateY(-6px) rotate(-45deg); }

	.nav-body {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		max-width: 1280px;
		margin: 0 auto;
		padding: 0 1.5rem 0.75rem;
	}

	.nav-links { display: flex; gap: 0.25rem; }

	.nav-links a {
		color: var(--text-secondary);
		text-decoration: none;
		padding: 0.38rem 0.58rem;
		border-radius: 6px;
		transition: color 0.15s, background 0.15s;
		font-size: 0.78rem;
		font-weight: 720;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.nav-links a:hover { color: var(--text); background: var(--hover-bg); }
	.nav-links a.active { color: var(--text); background: var(--badge-blue); }

	.nav-overlay { display: none; }

	main {
		max-width: 1280px;
		margin: 0 auto;
		padding: 1.5rem;
	}

	@media (max-width: 768px) {
		.nav-top { padding: 0.6rem 1rem; }
		.hamburger { display: flex; }
		.nav-body {
			display: none;
			flex-direction: column;
			align-items: stretch;
			gap: 0;
			padding: 0;
			border-top: 1px solid var(--border-light);
		}
		.nav-body.open { display: flex; }
		.nav-links { flex-direction: column; gap: 0; padding: 0.5rem 0; }
		.nav-links a { padding: 0.75rem 1.25rem; border-radius: 0; font-size: 0.9rem; }
		.nav-links a.active { border-radius: 0; }
		.nav-overlay {
			display: block;
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.25);
			z-index: 40;
			border: none;
			cursor: default;
		}
		main { padding: 1rem; }
	}

	@media (max-width: 480px) {
		.nav-brand {
			max-width: 10rem;
			font-size: 0.9rem;
		}
		.nav-brand span:last-child {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		main { padding: 0.75rem; }
	}
</style>
