<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { MlEpochMetric } from '$lib/api';
	import { colors, plotlyLayout, plotlyAxis, plotlyLegend } from '$lib/theme';

	let { metrics }: { metrics: MlEpochMetric[] } = $props();
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
		if (!Plotly || !chartEl || metrics.length === 0) return;
		const traces: any[] = [];

		const trainPts = metrics.filter((m) => m.train_loss !== null);
		if (trainPts.length > 0) {
			traces.push({
				type: 'scatter',
				mode: trainPts.length === 1 ? 'lines+markers' : 'lines',
				x: trainPts.map((m) => m.epoch),
				y: trainPts.map((m) => m.train_loss),
				name: 'Train Loss',
				line: { color: colors.blue, width: 2 },
				marker: { size: 6 }
			});
		}

		const valPts = metrics.filter((m) => m.val_loss !== null);
		if (valPts.length > 0) {
			traces.push({
				type: 'scatter',
				mode: valPts.length === 1 ? 'lines+markers' : 'lines',
				x: valPts.map((m) => m.epoch),
				y: valPts.map((m) => m.val_loss),
				name: 'Val Loss',
				line: { color: colors.red, width: 2 },
				marker: { size: 6 }
			});
		}

		// Per-era correlation (plotted on secondary y-axis)
		const corrPts = metrics.filter((m) => m.correlation !== null);
		if (corrPts.length > 0) {
			traces.push({
				type: 'scatter',
				mode: 'lines+markers',
				x: corrPts.map((m) => m.epoch),
				y: corrPts.map((m) => m.correlation),
				name: 'Val Corr',
				line: { color: colors.green, width: 2, dash: 'dot' },
				marker: { size: 6 },
				yaxis: 'y2'
			});
		}

		const sharpePts = metrics.filter((m) => m.sharpe !== null);
		if (sharpePts.length > 0) {
			traces.push({
				type: 'scatter',
				mode: 'lines+markers',
				x: sharpePts.map((m) => m.epoch),
				y: sharpePts.map((m) => m.sharpe),
				name: 'Val Sharpe',
				line: { color: colors.orange, width: 2, dash: 'dash' },
				marker: { size: 6 },
				yaxis: 'y2'
			});
		}

		const hasSecondary = corrPts.length > 0 || sharpePts.length > 0;

		Plotly.newPlot(
			chartEl,
			traces,
			plotlyLayout({
				title: { text: 'Training Metrics', font: { color: colors.text, size: 14 } },
				xaxis: plotlyAxis('Epoch'),
				yaxis: plotlyAxis('Loss'),
				...(hasSecondary ? {
					yaxis2: {
						...plotlyAxis('Corr / Sharpe'),
						overlaying: 'y',
						side: 'right',
					}
				} : {}),
				legend: { ...plotlyLegend, orientation: 'h', y: -0.15 },
				margin: { t: 50, b: 50, l: 60, r: hasSecondary ? 60 : 20 }
			}),
			{ responsive: true }
		);
	});
</script>

<div class="chart-container">
	{#if metrics.length === 0}
		<p class="empty">No epoch metrics recorded for this run. Training may still be in progress or the job produced no metrics.</p>
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
