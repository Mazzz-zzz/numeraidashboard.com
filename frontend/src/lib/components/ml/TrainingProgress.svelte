<script lang="ts">
	import type { MlRecentRun } from '$lib/api';

	interface Props {
		runs: MlRecentRun[];
		oncancel: (runId: number) => void;
	}

	let { runs, oncancel }: Props = $props();

	let activeRuns = $derived(runs.filter((r) => r.status === 'pending' || r.status === 'running'));

	function elapsed(startedAt: string): string {
		if (!startedAt) return '';
		const start = new Date(startedAt).getTime();
		const now = Date.now();
		const secs = Math.floor((now - start) / 1000);
		if (secs < 60) return `${secs}s`;
		const mins = Math.floor(secs / 60);
		const remSecs = secs % 60;
		if (mins < 60) return `${mins}m ${remSecs}s`;
		const hrs = Math.floor(mins / 60);
		const remMins = mins % 60;
		return `${hrs}h ${remMins}m`;
	}
</script>

{#if activeRuns.length > 0}
	<div class="training-progress">
		{#each activeRuns as run}
			<div class="progress-card">
				<div class="progress-header">
					<span class="run-label">
						<span class="pulse"></span>
						Run #{run.id} &mdash; {run.model_type}
					</span>
					<button class="cancel-btn" onclick={() => oncancel(run.id)}>Cancel</button>
				</div>

				<div class="progress-bar-wrapper">
					<div class="progress-bar">
						<div
							class="progress-fill"
							class:determinate={run.progress_pct != null && run.progress_pct > 0}
							style="width: {run.progress_pct != null && run.progress_pct > 0 ? Math.max(2, run.progress_pct) : 0}%"
						></div>
					</div>
					<span class="progress-label">
						{#if run.status === 'pending'}
							Starting...
						{:else if run.progress_pct != null && run.progress_pct > 0}
							{Math.round(run.progress_pct)}%
						{:else}
							Training
						{/if}
					</span>
				</div>

				<div class="progress-details">
					{#if run.started_at}
						<span class="detail">Elapsed: {elapsed(run.started_at)}</span>
					{/if}
					<span class="detail status-{run.status}">{run.status}</span>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	.training-progress {
		margin-bottom: 1rem;
	}

	.progress-card {
		background: var(--bg-card);
		border: 1px solid var(--blue);
		border-radius: 8px;
		padding: 0.75rem 1rem;
		margin-bottom: 0.5rem;
	}

	.progress-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.5rem;
	}

	.run-label {
		font-size: 0.85rem;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.pulse {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--blue);
		animation: pulse 1.5s ease-in-out infinite;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.3;
		}
	}

	.cancel-btn {
		background: none;
		border: 1px solid var(--red);
		color: var(--red);
		padding: 0.2rem 0.6rem;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.7rem;
		font-weight: 600;
	}

	.cancel-btn:hover {
		background: var(--red);
		color: white;
	}

	.progress-bar-wrapper {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
	}

	.progress-bar {
		flex: 1;
		height: 6px;
		background: var(--border-light);
		border-radius: 3px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--blue);
		border-radius: 3px;
		transition: width 0.5s ease;
		animation: indeterminate 2s ease-in-out infinite;
	}

	.progress-fill.determinate {
		animation: none;
		margin-left: 0;
	}

	@keyframes indeterminate {
		0% {
			width: 5%;
			margin-left: 0;
		}
		50% {
			width: 40%;
			margin-left: 30%;
		}
		100% {
			width: 5%;
			margin-left: 95%;
		}
	}

	.progress-label {
		font-size: 0.73rem;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.progress-details {
		display: flex;
		gap: 1rem;
		font-size: 0.73rem;
	}

	.detail {
		color: var(--text-muted);
	}

	.status-pending {
		color: var(--text-secondary);
	}
	.status-running {
		color: var(--blue);
	}
</style>
