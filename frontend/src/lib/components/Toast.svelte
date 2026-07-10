<script lang="ts">
	import { toasts } from '$lib/stores';
</script>

{#if $toasts.length > 0}
	<div class="toast-container" role="status" aria-live="polite">
		{#each $toasts as toast (toast.id)}
			<div class="toast toast-{toast.type}">
				{toast.message}
			</div>
		{/each}
	</div>
{/if}

<style>
	.toast-container {
		position: fixed;
		top: 1rem;
		right: 1rem;
		z-index: 1000;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.toast {
		padding: 0.75rem 1rem;
		border-radius: 8px;
		font-size: 0.85rem;
		box-shadow: 0 4px 12px rgba(0,0,0,0.1);
		animation: slideIn 0.2s ease-out;
		max-width: 360px;
	}

	.toast-success {
		background: #dafbe1;
		color: var(--green, #1a7f37);
		border: 1px solid #aceebb;
	}

	.toast-error {
		background: #ffebe9;
		color: var(--red, #cf222e);
		border: 1px solid #ffcecb;
	}

	.toast-info {
		background: #ddf4ff;
		color: var(--blue, #0969da);
		border: 1px solid #b6e3ff;
	}

	@keyframes slideIn {
		from { opacity: 0; transform: translateX(1rem); }
		to { opacity: 1; transform: translateX(0); }
	}
</style>
