<script lang="ts">
	let { label, value, sub = '', color = '' }: {
		label: string;
		value: string;
		sub?: string;
		color?: string;
	} = $props();
</script>

<div class="card">
	<div class="card-label">{label}</div>
	<div class="card-value" style={color ? `color: ${color}` : ''}>{value}</div>
	{#if sub}
		<div class="card-sub">{sub}</div>
	{/if}
</div>

<style>
	.card {
		background: var(--bg-card);
		border: 1px solid var(--border-light);
		border-radius: 8px;
		padding: 0.75rem;
		box-shadow: var(--shadow-sm);
	}

	.card-label {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-secondary);
		margin-bottom: 0.25rem;
	}

	.card-value {
		font-size: 1.35rem;
		font-weight: 700;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.card-sub {
		font-size: 0.65rem;
		color: var(--text-muted);
		margin-top: 0.2rem;
	}
</style>
