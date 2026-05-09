<script lang="ts">
	import { page } from '$app/stores';
	import Toast from '$lib/components/Toast.svelte';

	let { children } = $props();
	let menuOpen = $state(false);

	function closeMenu() {
		menuOpen = false;
	}
</script>

<div class="app">
	<nav>
		<div class="nav-top">
			<a href="/" class="nav-brand" title="Numerai Dashboard" onclick={closeMenu}>Numerai Dashboard</a>

			<div class="nav-top-right">
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
				<a href="/" class:active={$page.url.pathname === '/'} onclick={closeMenu}>Home</a>
				<a href="/ml" class:active={$page.url.pathname === '/ml'} onclick={closeMenu}>ML</a>
				<a href="/chart" class:active={$page.url.pathname === '/chart'} onclick={closeMenu}>Chart</a>
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
		--bg-page: #f6f8fa;
		--bg-card: #ffffff;
		--bg-input: #f6f8fa;
		--bg-nav: #ffffff;
		--border: #d1d9e0;
		--border-light: #e1e4e8;
		--text: #1f2328;
		--text-secondary: #656d76;
		--text-muted: #8b949e;
		--blue: #0969da;
		--green: #1a7f37;
		--red: #cf222e;
		--orange: #bc4c00;
		--purple: #8250df;
		--yellow: #9a6700;
		--hover-bg: #f0f2f5;
		--badge-blue: rgba(9, 105, 218, 0.08);
		--badge-green: rgba(26, 127, 55, 0.08);
		--badge-orange: rgba(188, 76, 0, 0.08);
		--badge-red: rgba(207, 34, 46, 0.08);
		--badge-muted: rgba(101, 109, 118, 0.08);
		--shadow-sm: 0 1px 2px rgba(0,0,0,0.06);
		--shadow-md: 0 4px 12px rgba(0,0,0,0.08);
	}

	:global(body) {
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		background: var(--bg-page);
		color: var(--text);
	}

	.app { min-height: 100vh; }

	nav {
		background: var(--bg-nav);
		border-bottom: 1px solid var(--border);
		box-shadow: var(--shadow-sm);
		position: sticky;
		top: 0;
		z-index: 50;
	}

	.nav-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1.5rem;
	}

	.nav-brand {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--blue);
		text-decoration: none;
	}

	.nav-top-right { display: flex; align-items: center; gap: 0.75rem; }

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
		padding: 0 1.5rem 0.75rem;
	}

	.nav-links { display: flex; gap: 0.25rem; }

	.nav-links a {
		color: var(--text-secondary);
		text-decoration: none;
		padding: 0.35rem 0.6rem;
		border-radius: 6px;
		transition: color 0.15s, background 0.15s;
		font-size: 0.875rem;
		font-weight: 500;
		white-space: nowrap;
	}

	.nav-links a:hover { color: var(--text); background: var(--hover-bg); }
	.nav-links a.active { color: var(--blue); background: var(--badge-blue); }

	.nav-overlay { display: none; }

	main {
		max-width: 1200px;
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
		.nav-brand { font-size: 1.1rem; }
		main { padding: 0.75rem; }
	}
</style>
