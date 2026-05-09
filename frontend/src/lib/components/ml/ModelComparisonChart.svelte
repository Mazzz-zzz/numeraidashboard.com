<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { MlRunData } from '$lib/api';
	import { colors, plotlyLayout, plotlyAxis, plotlyLegend } from '$lib/theme';

	let { runs }: { runs: MlRunData[] } = $props();
	let Plotly: any = $state(null);
	let chartEl: HTMLDivElement;

	onMount(async () => {
		const mod = await import('plotly.js-dist-min');
		Plotly = mod.default || mod;
	});

	onDestroy(() => {
		if (Plotly && chartEl) Plotly.purge(chartEl);
	});

	$effect(() => {
		if (!Plotly || !chartEl || runs.length === 0) return;

		const completed = runs.filter((r) => r.status === 'completed');
		if (completed.length === 0) return;

		const labels = completed.map((r) => `Run #${r.id}`);

		const traces: any[] = [
			{
				type: 'bar',
				x: labels,
				y: completed.map((r) => r.correlation ?? 0),
				name: 'Correlation',
				marker: { color: colors.blue }
			},
			{
				type: 'bar',
				x: labels,
				y: completed.map((r) => (r.sharpe ?? 0) / 10),
				name: 'Sharpe / 10',
				marker: { color: colors.green }
			},
			{
				type: 'bar',
				x: labels,
				y: completed.map((r) => r.feature_exposure ?? 0),
				name: 'Feature Exp',
				marker: { color: colors.orange }
			}
		];

		Plotly.newPlot(
			chartEl,
			traces,
			plotlyLayout({
				title: { text: 'Model Comparison', font: { color: colors.text, size: 14 } },
				xaxis: plotlyAxis(undefined),
				yaxis: plotlyAxis('Score'),
				legend: { ...plotlyLegend, orientation: 'h', y: -0.15 },
				barmode: 'group',
				margin: { t: 50, b: 50, l: 60, r: 20 }
			}),
			{ responsive: true }
		);
	});
</script>

<div class="chart-container">
	{#if runs.filter((r) => r.status === 'completed').length === 0}
		<p class="empty">No completed runs to compare</p>
	{:else}
		<div bind:this={chartEl} class="chart" style="height: 300px;"></div>
	{/if}
</div>

<style>
	.chart-container {
		background: var(--bg-card);
		border: 1px solid var(--border-light);
		border-radius: 8px;
		padding: 0.5rem;
		box-shadow: var(--shadow-sm);
	}

	.chart {
		width: 100%;
	}

	.empty {
		color: var(--text-muted);
		text-align: center;
		padding: 2rem;
		font-size: 0.8rem;
	}
</style>
