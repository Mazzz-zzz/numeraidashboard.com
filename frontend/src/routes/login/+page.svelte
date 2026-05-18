<script lang="ts">
	import { goto } from '$app/navigation';
	import { signIn, signInWithPasskey, signUp, confirmSignUp, resendCode } from '$lib/auth';

	type Mode = 'signin' | 'signup' | 'confirm';

	let mode = $state<Mode>('signin');
	let email = $state('');
	let password = $state('');
	let code = $state('');
	let loading = $state(false);
	let error = $state<string | null>(null);
	let info = $state<string | null>(null);

	function nextPath(): string {
		if (typeof window === 'undefined') return '/';
		const next = new URLSearchParams(window.location.search).get('next');
		return next && next.startsWith('/') ? next : '/';
	}

	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = null;
		info = null;
		loading = true;
		try {
			if (mode === 'signin') {
				await signIn(email, password);
				goto(nextPath());
			} else if (mode === 'signup') {
				await signUp(email, password);
				info = 'Check your email for a verification code.';
				mode = 'confirm';
			} else {
				await confirmSignUp(email, code);
				info = 'Account confirmed. You can sign in now.';
				mode = 'signin';
				code = '';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Something went wrong';
		} finally {
			loading = false;
		}
	}

	async function handlePasskey() {
		error = null;
		info = null;
		if (!email) {
			error = 'Enter your email first.';
			return;
		}
		loading = true;
		try {
			await signInWithPasskey(email);
			goto(nextPath());
		} catch (e) {
			error = e instanceof Error ? e.message : 'Passkey sign-in failed';
		} finally {
			loading = false;
		}
	}

	async function resend() {
		error = null;
		info = null;
		try {
			await resendCode(email);
			info = 'Verification code resent.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not resend code';
		}
	}
</script>

<div class="auth-wrap">
	<div class="auth-card">
		<h1>
			{#if mode === 'signin'}Sign in
			{:else if mode === 'signup'}Create account
			{:else}Confirm email
			{/if}
		</h1>

		<aside class="preview-note" aria-label="Research preview notice">
			<header class="preview-head">
				<span class="preview-eyebrow">
					<span class="preview-dot" aria-hidden="true"></span>
					Research preview
				</span>
				<span class="preview-build">v0 · live</span>
			</header>
			<p class="preview-body">
				Built in the open and shipped constantly. Schema changes, half-wired routes, and rough edges are expected.
			</p>
		</aside>

		<form onsubmit={handleSubmit}>
			<label>
				<span>Email</span>
				<input type="email" bind:value={email} required autocomplete="email" disabled={loading} />
			</label>

			{#if mode !== 'confirm'}
				<label>
					<span>Password</span>
					<input
						type="password"
						bind:value={password}
						required
						minlength="8"
						autocomplete={mode === 'signin' ? 'current-password' : 'new-password'}
						disabled={loading}
					/>
				</label>
			{/if}

			{#if mode === 'confirm'}
				<label>
					<span>Verification code</span>
					<input type="text" bind:value={code} required inputmode="numeric" disabled={loading} />
				</label>
			{/if}

			{#if error}<p class="error">{error}</p>{/if}
			{#if info}<p class="info">{info}</p>{/if}

			<button type="submit" class="primary" disabled={loading}>
				{#if loading}Working…
				{:else if mode === 'signin'}Sign in
				{:else if mode === 'signup'}Create account
				{:else}Confirm
				{/if}
			</button>

			{#if mode === 'signin'}
				<div class="divider"><span>or</span></div>
				<button
					type="button"
					class="passkey"
					onclick={handlePasskey}
					disabled={loading}
					title="Sign in with TouchID, FaceID, or a hardware key"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
					</svg>
					Sign in with passkey
				</button>
			{/if}
		</form>

		<div class="switch">
			{#if mode === 'signin'}
				<button type="button" class="link" onclick={() => { mode = 'signup'; error = null; info = null; }}>
					Need an account? Create one
				</button>
			{:else if mode === 'signup'}
				<button type="button" class="link" onclick={() => { mode = 'signin'; error = null; info = null; }}>
					Already have an account? Sign in
				</button>
			{:else}
				<button type="button" class="link" onclick={resend}>Resend code</button>
				<button type="button" class="link" onclick={() => { mode = 'signin'; error = null; info = null; }}>
					Back to sign in
				</button>
			{/if}
		</div>
	</div>
</div>

<style>
	.auth-wrap {
		display: flex;
		justify-content: center;
		padding: 3rem 1rem;
	}

	.auth-card {
		width: 100%;
		max-width: 360px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1.75rem;
		box-shadow: var(--shadow-sm);
	}

	h1 {
		margin: 0 0 0.6rem;
		font-size: 1.25rem;
		font-weight: 600;
	}

	.preview-note {
		display: grid;
		gap: 0.45rem;
		margin: 0 0 1.25rem;
		padding: 0.7rem 0.8rem 0.75rem;
		background: var(--bg-page);
		border: 1.5px solid var(--text);
		border-radius: 4px;
		box-shadow: 3px 3px 0 var(--text);
	}
	.preview-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
	}
	.preview-eyebrow {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text);
	}
	.preview-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--green, #1a7f37);
		box-shadow: 0 0 0 2px rgba(26, 127, 55, 0.18);
		animation: preview-pulse 1.8s ease-in-out infinite;
	}
	.preview-build {
		font-family: var(--font-mono);
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.preview-body {
		margin: 0;
		font-size: 0.78rem;
		line-height: 1.45;
		color: var(--text-secondary);
	}
	@keyframes preview-pulse {
		0%, 100% { box-shadow: 0 0 0 2px rgba(26, 127, 55, 0.18); }
		50%      { box-shadow: 0 0 0 5px rgba(26, 127, 55, 0.05); }
	}
	@media (prefers-reduced-motion: reduce) {
		.preview-dot { animation: none; }
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	input {
		padding: 0.55rem 0.7rem;
		font-size: 0.95rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text);
	}

	input:focus {
		outline: none;
		border-color: var(--blue);
		box-shadow: 0 0 0 3px var(--badge-blue);
	}

	.primary {
		margin-top: 0.5rem;
		background: var(--blue);
		color: white;
		border: none;
		padding: 0.6rem 1rem;
		border-radius: 6px;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
	}

	.primary:disabled { opacity: 0.6; cursor: not-allowed; }
	.primary:hover:not(:disabled) { background: #0860c7; }

	.divider {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-muted);
		font-size: 0.75rem;
		margin: 0.25rem 0;
	}
	.divider::before, .divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border-light);
	}

	.passkey {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		background: var(--bg-input);
		color: var(--text);
		border: 1px solid var(--border);
		padding: 0.55rem 1rem;
		border-radius: 6px;
		font-size: 0.9rem;
		font-weight: 500;
		cursor: pointer;
	}
	.passkey:disabled { opacity: 0.6; cursor: not-allowed; }
	.passkey:hover:not(:disabled) { background: var(--hover-bg); border-color: var(--blue); }

	.error {
		color: var(--red);
		font-size: 0.85rem;
		margin: 0;
	}

	.info {
		color: var(--green);
		font-size: 0.85rem;
		margin: 0;
	}

	.switch {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border-light);
	}

	.link {
		background: none;
		border: none;
		padding: 0;
		color: var(--blue);
		font-size: 0.85rem;
		cursor: pointer;
		text-align: left;
	}

	.link:hover { text-decoration: underline; }
</style>
