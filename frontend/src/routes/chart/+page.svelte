<script lang="ts">
	import { onMount } from 'svelte';
	import { selectedUnderlying, addToast } from '$lib/stores';
	import { api, type ChartChainResponse, type ChartOhlcBar, type ChartChainExpiration } from '$lib/api';

	let chartContainer = $state<HTMLDivElement | null>(null);
	let chart: any = null;
	let candleSeries: any = null;

	let chain = $state<ChartChainResponse | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let activeExpiry = $state<string | null>(null);
	let lookbackDays = $state(90);

	// Initialize lightweight-charts on mount, lazy-imported so SSR is fine
	onMount(() => {
		let cleanup = () => {};
		(async () => {
			const lwc = await import('lightweight-charts');
			if (!chartContainer) return;
			chart = lwc.createChart(chartContainer, {
				layout: {
					background: { color: '#0d1117' },
					textColor: '#e6edf3',
				},
				grid: {
					vertLines: { color: '#21262d' },
					horzLines: { color: '#21262d' },
				},
				rightPriceScale: { borderColor: '#30363d' },
				timeScale: { borderColor: '#30363d', timeVisible: true, secondsVisible: false },
				crosshair: { mode: 1 },
				autoSize: true,
			});
			candleSeries = chart.addCandlestickSeries({
				upColor: '#26a69a',
				downColor: '#ef5350',
				borderUpColor: '#26a69a',
				borderDownColor: '#ef5350',
				wickUpColor: '#26a69a',
				wickDownColor: '#ef5350',
			});
			// If a symbol was already selected, paint immediately
			if ($selectedUnderlying) loadAll($selectedUnderlying);
			cleanup = () => chart?.remove();
		})();
		return () => cleanup();
	});

	$effect(() => {
		const sym = $selectedUnderlying;
		if (sym && candleSeries) loadAll(sym);
	});

	async function loadAll(symbol: string) {
		loading = true;
		error = null;
		try {
			const [bars, ch] = await Promise.all([
				api.getChartOhlc(symbol, lookbackDays),
				api.getChartChain(symbol),
			]);
			renderBars(bars);
			chain = ch;
			activeExpiry = ch.expirations[0]?.expiry ?? null;
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Failed to load chart';
			error = msg;
			addToast(msg, 'error');
		} finally {
			loading = false;
		}
	}

	function renderBars(bars: ChartOhlcBar[]) {
		if (!candleSeries) return;
		candleSeries.setData(bars.map(b => ({
			time: b.time,
			open: b.open,
			high: b.high,
			low: b.low,
			close: b.close,
		})));
		chart?.timeScale().fitContent();
	}

	function fmt(v: number | null | undefined, d = 2): string {
		if (v === null || v === undefined || Number.isNaN(v)) return '-';
		return v.toFixed(d);
	}

	function fmtPct(v: number | null | undefined): string {
		if (v === null || v === undefined || Number.isNaN(v)) return '-';
		return (v * 100).toFixed(1) + '%';
	}

	function activeExp(): ChartChainExpiration | null {
		if (!chain || !activeExpiry) return null;
		return chain.expirations.find(e => e.expiry === activeExpiry) ?? null;
	}

	// Tastytrade-style colour: ITM rows get a tinted background.
	// For calls, ITM = strike < spot; for puts, ITM = strike > spot.
	function callItm(strike: number): boolean {
		const spot = chain?.spot ?? null;
		return spot !== null && strike < spot;
	}
	function putItm(strike: number): boolean {
		const spot = chain?.spot ?? null;
		return spot !== null && strike > spot;
	}

	// Find the row closest to ATM for highlighting
	function isAtm(strike: number): boolean {
		const spot = chain?.spot ?? null;
		if (spot === null) return false;
		const exp = activeExp();
		if (!exp) return false;
		const closest = exp.rows.reduce((p, c) =>
			Math.abs(c.strike - spot) < Math.abs(p.strike - spot) ? c : p
		, exp.rows[0]);
		return closest && closest.strike === strike;
	}
</script>

<div class="chart-page">
	<header>
		<h1>Chart</h1>
		<div class="controls">
			{#if $selectedUnderlying}
				<span class="symbol">{$selectedUnderlying}</span>
				{#if chain?.spot != null}
					<span class="spot">${fmt(chain.spot, 2)}</span>
				{/if}
			{:else}
				<span class="hint">Select a symbol from the navbar</span>
			{/if}
			<select bind:value={lookbackDays} onchange={() => $selectedUnderlying && loadAll($selectedUnderlying)}>
				<option value={30}>1M</option>
				<option value={90}>3M</option>
				<option value={180}>6M</option>
				<option value={365}>1Y</option>
			</select>
			{#if loading}<span class="loading">Loading…</span>{/if}
		</div>
	</header>

	{#if error}
		<div class="error">{error}</div>
	{/if}

	<section class="price">
		<div class="chart-wrap" bind:this={chartContainer}></div>
	</section>

	{#if chain && chain.expirations.length > 0}
		<section class="chain">
			<div class="exp-tabs">
				{#each chain.expirations as exp}
					<button
						class:active={activeExpiry === exp.expiry}
						onclick={() => activeExpiry = exp.expiry}
					>
						{exp.expiry}
						<span class="row-count">({exp.rows.length})</span>
					</button>
				{/each}
			</div>

			{#if activeExp()}
				<div class="chain-table">
					<div class="chain-head">
						<div class="side calls">CALLS</div>
						<div class="strike-head">Strike</div>
						<div class="side puts">PUTS</div>
					</div>
					<div class="chain-subhead">
						<div class="cells">
							<div>Bid</div><div>Ask</div><div>Mid</div><div>IV</div><div>Δ</div><div>Γ</div><div>Θ</div><div>V</div>
						</div>
						<div class="strike-sub">$</div>
						<div class="cells">
							<div>Bid</div><div>Ask</div><div>Mid</div><div>IV</div><div>Δ</div><div>Γ</div><div>Θ</div><div>V</div>
						</div>
					</div>
					{#each activeExp()!.rows as row (row.strike)}
						<div class="chain-row" class:atm={isAtm(row.strike)}>
							<div class="cells call" class:itm={callItm(row.strike)}>
								<div>{fmt(row.call?.bid)}</div>
								<div>{fmt(row.call?.ask)}</div>
								<div>{fmt(row.call?.mid)}</div>
								<div>{fmtPct(row.call?.iv)}</div>
								<div>{fmt(row.call?.delta, 3)}</div>
								<div>{fmt(row.call?.gamma, 4)}</div>
								<div>{fmt(row.call?.theta, 3)}</div>
								<div>{fmt(row.call?.vega, 3)}</div>
							</div>
							<div class="strike">{fmt(row.strike, 2)}</div>
							<div class="cells put" class:itm={putItm(row.strike)}>
								<div>{fmt(row.put?.bid)}</div>
								<div>{fmt(row.put?.ask)}</div>
								<div>{fmt(row.put?.mid)}</div>
								<div>{fmtPct(row.put?.iv)}</div>
								<div>{fmt(row.put?.delta, 3)}</div>
								<div>{fmt(row.put?.gamma, 4)}</div>
								<div>{fmt(row.put?.theta, 3)}</div>
								<div>{fmt(row.put?.vega, 3)}</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{:else if $selectedUnderlying && !loading}
		<div class="empty">No chain data for {$selectedUnderlying}</div>
	{/if}
</div>

<style>
	.chart-page {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	h1 { margin: 0; font-size: 1.5rem; }
	.controls { display: flex; gap: 0.75rem; align-items: center; }
	.symbol { font-weight: 600; color: #58a6ff; }
	.spot { font-family: monospace; color: #f0f6fc; padding: 0.15rem 0.4rem; background: #21262d; border-radius: 4px; }
	.hint { color: #8b949e; }
	.loading { color: #8b949e; font-size: 0.9rem; }
	.error { padding: 0.5rem 1rem; background: #3c1818; color: #ff7b72; border-radius: 4px; }

	.price { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 0.5rem; }
	.chart-wrap { width: 100%; height: 380px; }

	.chain { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; }
	.exp-tabs {
		display: flex;
		gap: 0.25rem;
		padding: 0.5rem;
		border-bottom: 1px solid #30363d;
		overflow-x: auto;
	}
	.exp-tabs button {
		padding: 0.35rem 0.75rem;
		background: #161b22;
		color: #c9d1d9;
		border: 1px solid #30363d;
		border-radius: 4px;
		cursor: pointer;
		font-family: monospace;
		font-size: 0.85rem;
		white-space: nowrap;
	}
	.exp-tabs button.active { background: #1f6feb; color: white; border-color: #1f6feb; }
	.row-count { color: #8b949e; font-size: 0.75rem; margin-left: 0.25rem; }

	.chain-table { font-family: monospace; font-size: 0.78rem; }
	.chain-head, .chain-subhead, .chain-row {
		display: grid;
		grid-template-columns: 1fr 90px 1fr;
		align-items: center;
	}
	.chain-head .side {
		padding: 0.4rem;
		text-align: center;
		font-weight: 700;
		letter-spacing: 0.1em;
	}
	.chain-head .calls { color: #26a69a; background: rgba(38, 166, 154, 0.08); }
	.chain-head .puts  { color: #ef5350; background: rgba(239, 83, 80, 0.08); }
	.chain-head .strike-head { text-align: center; color: #8b949e; padding: 0.4rem; }

	.chain-subhead {
		background: #161b22;
		color: #8b949e;
		font-size: 0.7rem;
		border-bottom: 1px solid #30363d;
	}
	.chain-subhead .cells, .chain-row .cells {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		gap: 0;
	}
	.chain-subhead .cells > div, .chain-row .cells > div {
		padding: 0.3rem 0.2rem;
		text-align: right;
	}
	.chain-subhead .strike-sub { text-align: center; padding: 0.3rem; }

	.chain-row { border-bottom: 1px solid #161b22; }
	.chain-row:hover { background: #161b22; }
	.chain-row .strike {
		text-align: center;
		font-weight: 600;
		color: #f0f6fc;
		background: #161b22;
		padding: 0.3rem;
	}
	.chain-row.atm .strike { background: #1f6feb; color: white; }
	.chain-row .cells.itm { background: rgba(56, 139, 253, 0.06); }
	.chain-row .cells.call.itm { background: rgba(38, 166, 154, 0.06); }
	.chain-row .cells.put.itm  { background: rgba(239, 83, 80, 0.06); }

	.empty { padding: 2rem; text-align: center; color: #8b949e; }
</style>
