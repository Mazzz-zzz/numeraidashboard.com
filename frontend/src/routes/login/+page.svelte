<script lang="ts">
	import { goto } from '$app/navigation';
	import { signIn, signUp, confirmSignUp, resendCode } from '$lib/auth';

	type Mode = 'signin' | 'signup' | 'confirm';

	let mode = $state<Mode>('signin');
	let email = $state('');
	let password = $state('');
	let code = $state('');
	let loading = $state(false);
	let error = $state<string | null>(null);
	let info = $state<string | null>(null);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = null;
		info = null;
		loading = true;
		try {
			if (mode === 'signin') {
				await signIn(email, password);
				goto('/');
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
		margin: 0 0 1.25rem;
		font-size: 1.25rem;
		font-weight: 600;
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
