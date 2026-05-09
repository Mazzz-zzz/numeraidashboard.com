<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { api, type LocalRunData, type LocalRunVerification } from '$lib/api';
	import { colors, plotlyLayout, plotlyAxis } from '$lib/theme';

	// ── Static narrative data ────────────────────────────────────────────────
	// (sweepSummary, headToHead, harvest bug, liveDiv are metadata, not row data —
	// they don't come from the local_runs table.)

	const sweepSummary = [
		{ name: 'tabm-sweep', total: 11, ok: 0, recovered: 0, failed: 11, note: 'All rc=-9, 9 mid-training OOM + 2 quick config errors (lr-5e3/5e4)' },
		{ name: 'tabm-combo', total: 8, ok: 0, recovered: 8, failed: 0, note: 'All 8 trained + validated successfully — killed in post-validation cleanup before metrics.json was written. Recovered from run.log.' },
		{ name: 'tabicl-sweep', total: 17, ok: 8, recovered: 0, failed: 9, note: 'Mixed — survivors are configs that fit under the 15GB RAM cap' },
	];

	const headToHead = [
		{ metric: 'correlation',     wider: 0.011770, ctx: 0.004536, ctxOnDelta: 0.011098 },
		{ metric: 'sharpe',          wider: 0.6616,   ctx: 0.4014,   ctxOnDelta: 0.6517   },
		{ metric: 'mmc',             wider: 0.004034, ctx: 0.002729, ctxOnDelta: null     },
		{ metric: 'feature_exposure',wider: 0.2895,   ctx: 0.1211,   ctxOnDelta: 0.0      },
		{ metric: 'max_drawdown',    wider: -0.0605,  ctx: -0.0856,  ctxOnDelta: -0.0721  },
	];

	const liveDiv = {
		round: 1237,
		nCommonIds: 7107,
		pearson: 0.1592,
		spearman: 0.1592,
		verdict: 'STRONG GO — predictions are nearly orthogonal; an ensemble almost certainly helps',
	};

	// ── Inline fallback rows ─────────────────────────────────────────────────
	// Used when /ml/local-runs is unavailable (e.g. before the seed script
	// has been run on this environment). Same shape as LocalRunData so the
	// rest of the component can ignore the source.

	const FALLBACK_ROWS: LocalRunData[] = [
		// tabm-combo at 25%/50% (each run's "original" neut, matching recovered run.log)
		{ id: 0, sweep: 'tabm-combo', name: 'wider-2048', family: 'tabm', model_type: 'tabm', status: 'OK', target: 'target_delta_20', elapsed_seconds: 4753, neut_pct: 25, correlation: 0.011770, sharpe: 0.6616, mmc: 0.004034, feature_exposure: 0.2895, max_drawdown: -0.0605, hyperparams: { hidden_dims: '2048', neut_pct: 25, dropout: 0.1, weight_decay: 0.0001, noise_std: 0.05, n_ensemble: 16 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabm-combo', name: 'wider-1536', family: 'tabm', model_type: 'tabm', status: 'OK', target: 'target_delta_20', elapsed_seconds: 4110, neut_pct: 25, correlation: 0.005746, sharpe: 0.3342, mmc: 0.000037, feature_exposure: 0.3202, max_drawdown: -0.0967, hyperparams: { hidden_dims: '1536,512', neut_pct: 25, dropout: 0.1, weight_decay: 0.0001, noise_std: 0.05, n_ensemble: 16 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabm-combo', name: 'wide-base', family: 'tabm', model_type: 'tabm', status: 'OK', target: 'target_delta_20', elapsed_seconds: 2830, neut_pct: 25, correlation: 0.006975, sharpe: 0.3784, mmc: -0.001148, feature_exposure: 0.3131, max_drawdown: -0.1063, hyperparams: { hidden_dims: '1024,512', neut_pct: 25, dropout: 0.1, weight_decay: 0.0001, noise_std: 0.05, n_ensemble: 16 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabm-combo', name: 'wide-tight', family: 'tabm', model_type: 'tabm', status: 'OK', target: 'target_delta_20', elapsed_seconds: 2928, neut_pct: 25, correlation: 0.007769, sharpe: 0.4104, mmc: 0.001256, feature_exposure: 0.2581, max_drawdown: -0.0874, hyperparams: { hidden_dims: '1024,512', neut_pct: 25, dropout: 0.1, weight_decay: 0.0001, noise_std: 0.05, n_ensemble: 16, early_stopping_rounds: 8 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabm-combo', name: 'wide-combo', family: 'tabm', model_type: 'tabm', status: 'OK', target: 'target_delta_20', elapsed_seconds: 2002, neut_pct: 50, correlation: 0.006815, sharpe: 0.4479, mmc: 0.002173, feature_exposure: 0.2095, max_drawdown: -0.1343, hyperparams: { hidden_dims: '1024,512', neut_pct: 50, dropout: 0.1, weight_decay: 0.001, noise_std: 0.1, n_ensemble: 16 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabm-combo', name: 'wide-combo-tight', family: 'tabm', model_type: 'tabm', status: 'OK', target: 'target_delta_20', elapsed_seconds: 3404, neut_pct: 50, correlation: 0.005822, sharpe: 0.3480, mmc: -0.001082, feature_exposure: 0.3144, max_drawdown: -0.0991, hyperparams: { hidden_dims: '1024,512', neut_pct: 50, dropout: 0.1, weight_decay: 0.001, noise_std: 0.1, n_ensemble: 16, early_stopping_rounds: 8 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabm-combo', name: 'wide-drop', family: 'tabm', model_type: 'tabm', status: 'OK', target: 'target_delta_20', elapsed_seconds: 2440, neut_pct: 50, correlation: 0.007561, sharpe: 0.5155, mmc: 0.000852, feature_exposure: 0.2387, max_drawdown: -0.0817, hyperparams: { hidden_dims: '1024,512', neut_pct: 50, dropout: 0.2, weight_decay: 0.001, noise_std: 0.05, n_ensemble: 16 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabm-combo', name: 'base-combo', family: 'tabm', model_type: 'tabm', status: 'OK', target: 'target_delta_20', elapsed_seconds: 2650, neut_pct: 50, correlation: 0.005798, sharpe: 0.3324, mmc: -0.000958, feature_exposure: 0.2291, max_drawdown: -0.0824, hyperparams: { hidden_dims: '512,512,512', neut_pct: 50, dropout: 0.1, weight_decay: 0.001, noise_std: 0.1, n_ensemble: 16 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		// tabicl successes (each at original neut)
		{ id: 0, sweep: 'tabicl-sweep', name: 'ctx-16k',     family: 'tabicl', model_type: 'tabicl', status: 'OK', target: 'target_delta_20', elapsed_seconds: 10438, neut_pct: 50, correlation:  0.004536, sharpe:  0.4014, mmc:  0.002729, feature_exposure: 0.1211, max_drawdown: -0.0856, hyperparams: { neut_pct: 50, n_bags: 4, context_rows: 16000, n_recent_eras: 12, n_estimators_per_bag: 4 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabicl-sweep', name: 'norm-default',family: 'tabicl', model_type: 'tabicl', status: 'OK', target: 'target_delta_20', elapsed_seconds: 23159, neut_pct: 50, correlation:  0.004696, sharpe:  0.4137, mmc:  0.001705, feature_exposure: 0.1194, max_drawdown: -0.0425, hyperparams: { neut_pct: 50, n_bags: 4, context_rows: 8000,  n_recent_eras: 12, n_estimators_per_bag: 4, norm_methods: 'default' }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabicl-sweep', name: 'neut-75',     family: 'tabicl', model_type: 'tabicl', status: 'OK', target: 'target_delta_20', elapsed_seconds: 20327, neut_pct: 75, correlation:  0.004083, sharpe:  0.3306, mmc:  0.001604, feature_exposure: 0.0765, max_drawdown: -0.0975, hyperparams: { neut_pct: 75, n_bags: 4, context_rows: 8000,  n_recent_eras: 12, n_estimators_per_bag: 4 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabicl-sweep', name: 'est-2',       family: 'tabicl', model_type: 'tabicl', status: 'OK', target: 'target_delta_20', elapsed_seconds:  3775, neut_pct: 50, correlation:  0.004574, sharpe:  0.4303, mmc:  0.001480, feature_exposure: 0.1006, max_drawdown: -0.0349, hyperparams: { neut_pct: 50, n_bags: 4, context_rows: 8000,  n_recent_eras: 12, n_estimators_per_bag: 2 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabicl-sweep', name: 'norm-power',  family: 'tabicl', model_type: 'tabicl', status: 'OK', target: 'target_delta_20', elapsed_seconds: 19865, neut_pct: 50, correlation:  0.004492, sharpe:  0.3804, mmc:  0.001469, feature_exposure: 0.1296, max_drawdown: -0.0677, hyperparams: { neut_pct: 50, n_bags: 4, context_rows: 8000,  n_recent_eras: 12, n_estimators_per_bag: 4, norm_methods: 'none,power,quantile' }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabicl-sweep', name: 'eras-6',      family: 'tabicl', model_type: 'tabicl', status: 'OK', target: 'target_delta_20', elapsed_seconds: 27156, neut_pct: 50, correlation:  0.004152, sharpe:  0.3659, mmc:  0.001431, feature_exposure: 0.1026, max_drawdown: -0.0752, hyperparams: { neut_pct: 50, n_bags: 4, context_rows: 8000,  n_recent_eras:  6, n_estimators_per_bag: 4 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabicl-sweep', name: 'neut-0',      family: 'tabicl', model_type: 'tabicl', status: 'OK', target: 'target_delta_20', elapsed_seconds: 20358, neut_pct:  0, correlation:  0.004602, sharpe:  0.3784, mmc:  0.000935, feature_exposure: 0.2271, max_drawdown: -0.0735, hyperparams: { neut_pct:  0, n_bags: 4, context_rows: 8000,  n_recent_eras: 12, n_estimators_per_bag: 4 }, sweep_dir: null, source: 'fallback', inserted_at: null },
		{ id: 0, sweep: 'tabicl-sweep', name: 'eras-24',     family: 'tabicl', model_type: 'tabicl', status: 'OK', target: 'target_delta_20', elapsed_seconds: 20271, neut_pct: 50, correlation: -0.001559, sharpe: -0.1361, mmc: -0.003206, feature_exposure: 0.1014, max_drawdown: -0.2167, hyperparams: { neut_pct: 50, n_bags: 4, context_rows: 8000,  n_recent_eras: 24, n_estimators_per_bag: 4 }, sweep_dir: null, source: 'fallback', inserted_at: null },
	];

	// ── Reactive state ──────────────────────────────────────────────────────

	let runs = $state<LocalRunData[]>(FALLBACK_ROWS);
	let dataSource = $state<'api' | 'fallback'>('fallback');
	let fallbackReason = $state<string>('endpoint not yet deployed');

	// ── Global target filter (slices every view consistently) ──────────────
	let targetFilter = $state<string>('all');
	let availableTargets = $derived(
		Array.from(new Set(runs.map((r) => r.target ?? 'unknown'))).sort(),
	);
	// Apply target filter to the base rows. Every other derive uses this.
	let visibleRuns = $derived(
		targetFilter === 'all' ? runs : runs.filter((r) => r.target === targetFilter),
	);

	// Derived views (now keyed off the filtered base)
	let tabmRows = $derived(visibleRuns.filter((r) => r.family === 'tabm'));
	let tabiclRows = $derived(visibleRuns.filter((r) => r.family === 'tabicl'));

	// All TabM checkpoint names ordered (for grid rendering)
	let tabmNames = $derived(
		Array.from(new Set(tabmRows.map((r) => r.name))).sort((a, b) => {
			// Sort by best 25%/50% sharpe
			const aBest = Math.max(...tabmRows.filter((r) => r.name === a).map((r) => r.sharpe ?? 0));
			const bBest = Math.max(...tabmRows.filter((r) => r.name === b).map((r) => r.sharpe ?? 0));
			return bBest - aBest;
		}),
	);

	// Per-original-neut snapshot for the recovered table
	let tabmOriginalRows = $derived.by(() => {
		const out: LocalRunData[] = [];
		for (const name of tabmNames) {
			const candidates = tabmRows.filter((r) => r.name === name);
			// "original" neut = whatever the run was trained at; matches the
			// recovered metrics
			const orig = candidates.find((r) => r.hyperparams && Number(r.hyperparams.neut_pct) === Number(r.neut_pct))
				?? candidates[0];
			if (orig) out.push(orig);
		}
		out.sort((a, b) => (b.sharpe ?? 0) - (a.sharpe ?? 0));
		return out;
	});

	// Wider-2048 neut sweep — pulled from the API/fallback rows
	let widerNeut = $derived(
		tabmRows
			.filter((r) => r.name === 'wider-2048')
			.slice()
			.sort((a, b) => a.neut_pct - b.neut_pct),
	);

	// ── Verification methods ────────────────────────────────────────────────
	// A flat list of {row, verification} pairs for every verification
	// attached to any currently-visible row. Used to render the
	// "Verification methods" card where retest (headline) sits next to
	// each CV method's fold mean and per-fold breakdown.
	type VerifiedPair = { row: LocalRunData; v: LocalRunVerification };
	let verifiedPairs = $derived.by<VerifiedPair[]>(() => {
		const out: VerifiedPair[] = [];
		for (const r of visibleRuns) {
			const vs = r.hyperparams?.verifications;
			if (!vs || !Array.isArray(vs)) continue;
			for (const v of vs) out.push({ row: r, v });
		}
		// Sort: sweep → name → neut_pct → method (so multi-method rows
		// for the same config appear adjacent).
		out.sort((a, b) => {
			return (
				a.row.sweep.localeCompare(b.row.sweep) ||
				a.row.name.localeCompare(b.row.name) ||
				a.row.neut_pct - b.row.neut_pct ||
				a.v.method.localeCompare(b.v.method)
			);
		});
		return out;
	});
	let verifMethodFilter = $state<string>('all');
	let verifNeutFilter = $state<'all' | number>('all');
	let availableVerifMethods = $derived(
		Array.from(new Set(verifiedPairs.map((p) => p.v.method))).sort(),
	);
	let availableVerifNeuts = $derived(
		Array.from(new Set(verifiedPairs.map((p) => p.row.neut_pct))).sort((a, b) => a - b),
	);
	let visibleVerifiedPairs = $derived(
		verifiedPairs.filter(
			(p) =>
				(verifMethodFilter === 'all' || p.v.method === verifMethodFilter) &&
				(verifNeutFilter === 'all' || p.row.neut_pct === verifNeutFilter),
		),
	);

	function fmtPerFold(xs: number[] | null | undefined, digits = 4): string {
		if (!xs || xs.length === 0) return '—';
		return '[' + xs.map((x) => signed(x, digits)).join(', ') + ']';
	}

	// Has any TabM model the full 4-level neut sweep?
	let hasFullNeutSweep = $derived(
		tabmNames.some((n) => tabmRows.filter((r) => r.name === n).length >= 4),
	);

	const NEUT_LEVELS = [0, 25, 50, 75];
	let gridMetric = $state<'correlation' | 'sharpe' | 'mmc' | 'feature_exposure'>('sharpe');

	function gridValue(name: string, neutPct: number): number | null {
		const row = tabmRows.find((r) => r.name === name && Number(r.neut_pct) === neutPct);
		if (!row) return null;
		return (row as any)[gridMetric];
	}

	// Heatmap normalization across the visible grid
	let gridRange = $derived.by(() => {
		const vals: number[] = [];
		for (const name of tabmNames) {
			for (const np of NEUT_LEVELS) {
				const v = gridValue(name, np);
				if (v !== null && Number.isFinite(v)) vals.push(v as number);
			}
		}
		if (vals.length === 0) return { min: 0, max: 1 };
		return { min: Math.min(...vals), max: Math.max(...vals) };
	});

	function gridCellStyle(v: number | null): string {
		if (v === null || !Number.isFinite(v)) return 'opacity:0.4';
		const { min, max } = gridRange;
		const t = max === min ? 0.5 : (v - min) / (max - min);
		// Map to a green→white gradient (high = green)
		const a = 0.05 + t * 0.45;
		return `background: rgba(26, 127, 55, ${a.toFixed(3)})`;
	}

	// ── Format helpers ───────────────────────────────────────────────────────

	function fmt(v: number | null | undefined, digits = 4): string {
		if (v === null || v === undefined) return '—';
		return v.toFixed(digits);
	}

	function signed(v: number | null | undefined, digits = 4): string {
		if (v === null || v === undefined) return '—';
		return (v >= 0 ? '+' : '') + v.toFixed(digits);
	}

	function metricClass(v: number | null | undefined): string {
		if (v === null || v === undefined) return '';
		if (v > 0) return 'pos';
		if (v < 0) return 'neg';
		return '';
	}

	// ── API fetch ───────────────────────────────────────────────────────────

	onMount(async () => {
		try {
			const resp = await api.getMlLocalRuns();
			if (resp?.data && resp.data.length > 0) {
				runs = resp.data;
				dataSource = 'api';
			} else {
				fallbackReason = 'table empty — run seed_local_runs.py';
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// 404 → endpoint not deployed yet (most common during rolling deploys).
			// Other errors get the verbose message so they're debuggable.
			fallbackReason = /404|Not Found/i.test(msg)
				? 'endpoint not yet deployed (sam deploy backend)'
				: msg;
			// keep fallback rows
		}

		const mod = await import('plotly.js-dist-min');
		Plotly = mod.default || mod;
	});

	// ── Multivariate explorer ───────────────────────────────────────────────

	type Dim = { key: string; label: string; get: (r: LocalRunData) => number };
	const DIMS: Dim[] = [
		{ key: 'corr',     label: 'Correlation',     get: (r) => r.correlation ?? 0 },
		{ key: 'sharpe',   label: 'Sharpe',          get: (r) => r.sharpe ?? 0 },
		{ key: 'mmc',      label: 'MMC',             get: (r) => r.mmc ?? 0 },
		{ key: 'featExp',  label: 'Feature exposure',get: (r) => r.feature_exposure ?? 0 },
		{ key: 'maxDD',    label: 'Max drawdown',    get: (r) => r.max_drawdown ?? 0 },
		{ key: 'elapsed',  label: 'Elapsed (s)',     get: (r) => r.elapsed_seconds ?? 0 },
		{ key: 'neut_pct', label: 'Neut %',          get: (r) => Number(r.neut_pct) },
	];
	function dimByKey(k: string): Dim {
		return DIMS.find((d) => d.key === k) ?? DIMS[0];
	}

	let viewMode = $state<'2d' | '3d' | 'parcoords'>('2d');
	let xKey = $state<string>('featExp');
	let yKey = $state<string>('mmc');
	let zKey = $state<string>('sharpe');
	let colorKey = $state<string>('sharpe');
	let colorMode = $state<'numeric' | 'family' | 'sweep' | 'verified'>('numeric');
	let familyFilter = $state<'all' | 'tabm' | 'tabicl'>('all');
	let neutFilter = $state<'all' | 0 | 25 | 50 | 75>('all');
	// Fold error bars: when on, rows with a `verifications` entry get
	// min→max whiskers on whichever axis is `corr` or `sharpe`. Range is
	// taken from the walk-forward verification if present, otherwise the
	// first verification in the list.
	let foldErrors = $state<boolean>(false);

	function pickVerification(r: LocalRunData): LocalRunVerification | null {
		const vs = r.hyperparams?.verifications;
		if (!Array.isArray(vs) || vs.length === 0) return null;
		return vs.find((v) => v.method.includes('walkforward')) ?? vs[0];
	}

	function foldValuesForDim(r: LocalRunData, dimKey: string): number[] | null {
		const v = pickVerification(r);
		if (!v) return null;
		if (dimKey === 'corr') return v.per_fold_corrs ?? null;
		if (dimKey === 'sharpe') return v.per_fold_sharpes ?? null;
		return null;
	}

	// Categorical-color palette (d3 schemeCategory10). Enough distinct
	// colors for 4 sweeps / 2 families / verified-vs-not.
	const CATEGORY_COLORS = [
		'#4e9cff', '#ff9f40', '#2ecc71', '#e74c3c',
		'#9b59b6', '#8c564b', '#e377c2', '#95a5a6', '#f1c40f', '#17becf',
	];

	function categoryFor(r: LocalRunData): string {
		switch (colorMode) {
			case 'family':
				return r.family;
			case 'sweep':
				return r.sweep;
			case 'verified': {
				const v = r.hyperparams?.verifications;
				return Array.isArray(v) && v.length > 0 ? `verified (×${v.length})` : 'unverified';
			}
			default:
				return '';
		}
	}

	let chartEl: HTMLDivElement | null = $state(null);
	let Plotly: any = $state(null);

	onDestroy(() => {
		if (Plotly && chartEl) Plotly.purge(chartEl);
	});

	function hoverText(r: LocalRunData): string {
		const lines = [
			`<b>${r.name}</b> <i>(${r.sweep}, neut=${r.neut_pct}%)</i>`,
			`<i>target: ${r.target ?? 'unknown'}</i>`,
			`corr=${(r.correlation ?? 0).toFixed(6)}  sharpe=${(r.sharpe ?? 0).toFixed(4)}  mmc=${signed(r.mmc, 6)}`,
			`featExp=${(r.feature_exposure ?? 0).toFixed(4)}  maxDD=${(r.max_drawdown ?? 0).toFixed(4)}  elapsed=${r.elapsed_seconds ?? '—'}s`,
		];
		if (r.hyperparams) {
			const hp = Object.entries(r.hyperparams)
				.filter(([k]) => k !== 'verifications')
				.map(([k, v]) => `${k}=${v}`)
				.join('  ');
			if (hp) lines.push(`<span style="color:#888">${hp}</span>`);
		}
		return lines.join('<br>');
	}

	function renderChart() {
		if (!Plotly || !chartEl) return;
		const xDim = dimByKey(xKey);
		const yDim = dimByKey(yKey);
		const zDim = dimByKey(zKey);
		const cDim = dimByKey(colorKey);

		// `visibleRuns` already has the global target filter applied.
		const filtered = visibleRuns.filter((r) => {
			if (familyFilter !== 'all' && r.family !== familyFilter) return false;
			if (neutFilter !== 'all' && Number(r.neut_pct) !== neutFilter) return false;
			return true;
		});
		if (filtered.length === 0) {
			Plotly.purge(chartEl);
			return;
		}

		// ── Parallel coordinates ──────────────────────────────────────────
		// All DIMS as axes at once; user brushes ranges on any axis to
		// filter interactively. Line colouring follows colorMode.
		if (viewMode === 'parcoords') {
			const dimensions = DIMS.map((d) => ({
				label: d.label,
				values: filtered.map((r) => d.get(r)),
			}));

			let line: any;
			if (colorMode === 'numeric') {
				line = {
					color: filtered.map((r) => cDim.get(r)),
					colorscale: 'Viridis',
					showscale: true,
					colorbar: {
						title: { text: cDim.label, font: { color: colors.textSecondary, size: 11 } },
						tickfont: { color: colors.textSecondary, size: 10 },
						thickness: 12,
						len: 0.85,
					},
				};
			} else {
				// Map categories → integer indices → discrete stepped colorscale.
				const catKeys = Array.from(new Set(filtered.map(categoryFor))).sort();
				const catIdx = new Map(catKeys.map((k, i) => [k, i]));
				const n = Math.max(catKeys.length, 1);
				const colorscale: any[] = [];
				for (let i = 0; i < n; i++) {
					const color = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
					colorscale.push([i / n, color]);
					colorscale.push([(i + 1) / n - 0.0001, color]);
				}
				colorscale.push([1, CATEGORY_COLORS[(n - 1) % CATEGORY_COLORS.length]]);
				line = {
					color: filtered.map((r) => catIdx.get(categoryFor(r)) ?? 0),
					colorscale,
					cmin: 0,
					cmax: Math.max(n - 1, 1),
					showscale: true,
					colorbar: {
						title: { text: colorMode, font: { color: colors.textSecondary, size: 11 } },
						tickmode: 'array',
						tickvals: catKeys.map((_, i) => i + 0.5),
						ticktext: catKeys,
						tickfont: { color: colors.textSecondary, size: 10 },
						thickness: 12,
						len: 0.85,
					},
				};
			}

			const trace = {
				type: 'parcoords',
				dimensions,
				line,
				labelfont: { color: colors.textSecondary, size: 11 },
				tickfont: { color: colors.textSecondary, size: 10 },
				rangefont: { color: colors.textSecondary, size: 10 },
			};
			const layout = plotlyLayout({
				margin: { t: 50, b: 40, l: 60, r: 60 },
				height: 500,
			});
			Plotly.newPlot(chartEl, [trace], layout, { responsive: true, displaylogo: false });
			return;
		}

		// ── Scatter 2D / 3D ───────────────────────────────────────────────
		const is3d = viewMode === '3d';
		const scatterType = is3d ? 'scatter3d' : 'scatter';

		// For 2D with numeric color we keep inline text labels; for
		// categorical we drop them to avoid clutter (the legend carries
		// the semantic).
		function buildMarker(rows: LocalRunData[], categoryColor?: string) {
			if (categoryColor) {
				return {
					size: is3d ? 5 : 10,
					color: categoryColor,
					line: { color: colors.bg, width: is3d ? 0.5 : 1 },
					opacity: 0.9,
				};
			}
			return {
				size: is3d ? 5 : 11,
				color: rows.map((r) => cDim.get(r)),
				colorscale: 'Viridis',
				showscale: true,
				colorbar: {
					title: { text: cDim.label, font: { color: colors.textSecondary, size: 11 } },
					tickfont: { color: colors.textSecondary, size: 10 },
					thickness: 12,
					len: is3d ? 0.7 : 0.85,
				},
				line: { color: colors.bg, width: is3d ? 0.5 : 1 },
				opacity: 0.9,
			};
		}

		// Build asymmetric min→max error bar arrays for one axis. Rows
		// without a verifications entry (or whose axis isn't corr/sharpe)
		// contribute zero-length bars — Plotly draws nothing for those.
		// If the plotted point (retest) happens to fall outside the fold
		// range, the relevant side gets clamped to 0 so the remaining side
		// still shows as a one-sided whisker.
		function errorBarFor(rows: LocalRunData[], dim: Dim): {
			plus: number[];
			minus: number[];
			any: boolean;
		} {
			const plus: number[] = [];
			const minus: number[] = [];
			let any = false;
			for (const r of rows) {
				const vals = foldValuesForDim(r, dim.key);
				if (!vals || vals.length === 0) {
					plus.push(0);
					minus.push(0);
					continue;
				}
				const center = dim.get(r);
				const hi = Math.max(...vals);
				const lo = Math.min(...vals);
				plus.push(Math.max(0, hi - center));
				minus.push(Math.max(0, center - lo));
				any = true;
			}
			return { plus, minus, any };
		}

		function scatterTrace(rows: LocalRunData[], name?: string, categoryColor?: string): any {
			const t: any = {
				type: scatterType,
				mode: !is3d && !categoryColor ? 'markers+text' : 'markers',
				x: rows.map((r) => xDim.get(r)),
				y: rows.map((r) => yDim.get(r)),
				marker: buildMarker(rows, categoryColor),
				hovertext: rows.map(hoverText),
				hovertemplate: '%{hovertext}<extra></extra>',
			};
			if (is3d) t.z = rows.map((r) => zDim.get(r));
			if (!is3d && !categoryColor) {
				t.text = rows.map((r) => `${r.name}@${r.neut_pct}%`);
				t.textposition = 'top center';
				t.textfont = { size: 9, color: colors.textSecondary };
			}
			if (name) t.name = name;

			// Fold error bars (2D + 3D). Only the axes that carry per-fold
			// data contribute visible bars.
			if (foldErrors) {
				const barColor = categoryColor ?? colors.textSecondary;
				const ex = errorBarFor(rows, xDim);
				if (ex.any) {
					t.error_x = {
						type: 'data', symmetric: false,
						array: ex.plus, arrayminus: ex.minus,
						color: barColor, thickness: 1, width: is3d ? 2 : 4,
					};
				}
				const ey = errorBarFor(rows, yDim);
				if (ey.any) {
					t.error_y = {
						type: 'data', symmetric: false,
						array: ey.plus, arrayminus: ey.minus,
						color: barColor, thickness: 1, width: is3d ? 2 : 4,
					};
				}
				if (is3d) {
					const ez = errorBarFor(rows, zDim);
					if (ez.any) {
						t.error_z = {
							type: 'data', symmetric: false,
							array: ez.plus, arrayminus: ez.minus,
							color: barColor, thickness: 1, width: 2,
						};
					}
				}
			}
			return t;
		}

		let traces: any[];
		if (colorMode === 'numeric') {
			traces = [scatterTrace(filtered)];
		} else {
			// One trace per category so the Plotly legend shows labels.
			const byCategory = new Map<string, LocalRunData[]>();
			for (const r of filtered) {
				const k = categoryFor(r);
				if (!byCategory.has(k)) byCategory.set(k, []);
				byCategory.get(k)!.push(r);
			}
			const ordered = Array.from(byCategory.keys()).sort();
			traces = ordered.map((cat, i) =>
				scatterTrace(byCategory.get(cat)!, cat, CATEGORY_COLORS[i % CATEGORY_COLORS.length]),
			);
		}

		const layout = is3d
			? plotlyLayout({
					scene: {
						xaxis: { title: xDim.label, color: colors.textSecondary, gridcolor: colors.borderLight },
						yaxis: { title: yDim.label, color: colors.textSecondary, gridcolor: colors.borderLight },
						zaxis: { title: zDim.label, color: colors.textSecondary, gridcolor: colors.borderLight },
						camera: { eye: { x: 1.7, y: -1.5, z: 0.9 } },
						bgcolor: colors.bg,
					},
					margin: { t: 20, b: 0, l: 0, r: 0 },
					height: 540,
					showlegend: colorMode !== 'numeric',
				})
			: plotlyLayout({
					xaxis: plotlyAxis(xDim.label, { zerolinecolor: colors.border }),
					yaxis: plotlyAxis(yDim.label, { zerolinecolor: colors.border }),
					margin: { t: 20, b: 50, l: 60, r: 20 },
					height: 500,
					hovermode: 'closest',
					showlegend: colorMode !== 'numeric',
				});

		Plotly.newPlot(chartEl, traces, layout, { responsive: true, displaylogo: false });
	}

	$effect(() => {
		void [Plotly, chartEl, viewMode, xKey, yKey, zKey, colorKey, colorMode, familyFilter, neutFilter, foldErrors, visibleRuns];
		if (!Plotly || !chartEl) return;
		requestAnimationFrame(renderChart);
	});
</script>

<div class="page">
	<header class="hero">
		<h1>Local Sweep Analysis</h1>
		<p class="lede">
			Investigation of three Numerai hyperparameter sweeps run locally on this box,
			recovery of metrics that the orchestrator marked as failed, fresh inference
			across all 8 TabM checkpoints at four neutralization levels, and a feasibility
			check for combining the best TabM model with the best TabICL model.
		</p>
		<div class="meta">
			<span>tabm-sweep · tabm-combo · tabicl-sweep · tabm-wider-scaling</span>
			<span>·</span>
			<span>15&nbsp;GB RAM cap, sequential, single GPU</span>
			<span>·</span>
			<span class="src">data: {dataSource === 'api' ? 'live (local_runs table)' : `static fallback — ${fallbackReason}`}</span>
		</div>

		<!-- Global target filter — slices every view consistently -->
		<div class="filter-bar">
			<span class="filter-label">target:</span>
			<div class="seg">
				<button
					class:active={targetFilter === 'all'}
					onclick={() => (targetFilter = 'all')}
					type="button"
				>All</button>
				{#each availableTargets as t (t)}
					<button
						class:active={targetFilter === t}
						onclick={() => (targetFilter = t)}
						type="button"
					>{t}</button>
				{/each}
			</div>
			<span class="filter-count">
				{visibleRuns.length} / {runs.length} rows
				{#if targetFilter !== 'all'} · filtered to {targetFilter}{/if}
			</span>
		</div>
	</header>

	<!-- ── Sweep summary ── -->
	<section class="card">
		<h2>Sweep status</h2>
		<table>
			<thead>
				<tr>
					<th>Sweep</th>
					<th class="num">Total</th>
					<th class="num">OK</th>
					<th class="num">Recovered</th>
					<th class="num">Failed</th>
					<th>Notes</th>
				</tr>
			</thead>
			<tbody>
				{#each sweepSummary as s (s.name)}
					<tr>
						<td class="mono">{s.name}</td>
						<td class="num">{s.total}</td>
						<td class="num pos">{s.ok}</td>
						<td class="num warn">{s.recovered}</td>
						<td class="num neg">{s.failed}</td>
						<td class="muted">{s.note}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<!-- ── The harvest bug ── -->
	<section class="card">
		<h2>The harvest bug</h2>
		<p>
			All 8 <span class="mono">tabm-combo</span> runs and several <span class="mono">tabicl-sweep</span>
			runs were marked <code>FAILED rc=-9</code> by the orchestrator. Inspecting their
			<code>run.log</code> files showed every <span class="mono">tabm-combo</span> run actually
			<strong>completed full training and validation</strong> — the final ensemble metrics
			(correlation, sharpe, mmc, feature exposure, drawdown, vs. benchmarks, vs. example
			predictions) were printed in full, then the process was OOM-killed
			<em>after</em> the print but <em>before</em> <code>metrics.json</code> got written.
		</p>
		<p>
			Tracing it: <code>trainer.py</code> prints the metrics block at line 588, then
			loops over per-target metrics (lines 591–598), then writes <code>metrics.json</code>
			at line 609. The loop holds the full <code>val_df</code> resident while
			<code>compute_all_metrics</code> builds another large frame — that's the
			memory peak that pushes the process past the 15&nbsp;GB cap. The work was
			done; only the harvest step died.
		</p>
		<p class="muted">
			Recovery: parse the <code>Ensemble metrics: { '{...}' }</code> JSON block from each
			<code>run.log</code>. The fresh inference values shown below reproduce the
			recovered metrics bit-for-bit at each run's original neutralization level.
		</p>
	</section>

	<!-- ── tabm-combo at original neut ── -->
	<section class="card">
		<h2>tabm-combo (recovered + verified)</h2>
		<p class="muted">
			Each row shows the run's metrics at its <strong>original</strong> neutralization
			level. Sorted by Sharpe.
		</p>
		<table>
			<thead>
				<tr>
					<th>Name</th>
					<th>Target</th>
					<th class="num">Neut</th>
					<th class="num">Corr</th>
					<th class="num">Sharpe</th>
					<th class="num">MMC</th>
					<th class="num">FeatExp</th>
					<th class="num">MaxDD</th>
				</tr>
			</thead>
			<tbody>
				{#each tabmOriginalRows as r, i (r.name)}
					<tr class:winner={i === 0}>
						<td class="mono">
							{r.name}
							{#if i === 0}<span class="badge">best</span>{/if}
						</td>
						<td class="mono muted">{r.target ?? '—'}</td>
						<td class="num muted">{r.neut_pct}%</td>
						<td class="num">{fmt(r.correlation, 6)}</td>
						<td class="num">{fmt(r.sharpe)}</td>
						<td class="num {metricClass(r.mmc)}">{signed(r.mmc, 6)}</td>
						<td class="num">{fmt(r.feature_exposure)}</td>
						<td class="num neg">{fmt(r.max_drawdown)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<!-- ── Verification methods (CV methods alongside single-point retest) ── -->
	{#if verifiedPairs.length > 0}
	<section class="card">
		<h2>Verification methods</h2>
		<p class="muted">
			Each row is the headline <code>retest</code> value (fresh r1241 inference at the
			trained neut level) paired with one CV verification method. Methods so far:
			<code>cv_eval_block_r1240</code> (K=10 block CV, no retraining, cheap) and
			<code>cv_sweep_walkforward_r1240</code> (K=3 purged walk-forward, honest
			train→stop→test, expensive). Per-fold sharpes make the within-method
			variance visible — the thing you'd otherwise have to trust blindly
			from a single-point Sharpe.
		</p>
		<div class="control-group" style="margin-bottom:0.6rem; gap:0.8rem; flex-wrap:wrap">
			<div>
				<span class="control-label">Method</span>
				<div class="seg">
					<button class:active={verifMethodFilter === 'all'} onclick={() => (verifMethodFilter = 'all')} type="button">All</button>
					{#each availableVerifMethods as m (m)}
						<button class:active={verifMethodFilter === m} onclick={() => (verifMethodFilter = m)} type="button">{m.replace('_r1240', '').replace('cv_', '')}</button>
					{/each}
				</div>
			</div>
			<div>
				<span class="control-label">Neut</span>
				<div class="seg">
					<button class:active={verifNeutFilter === 'all'} onclick={() => (verifNeutFilter = 'all')} type="button">All</button>
					{#each availableVerifNeuts as np (np)}
						<button class:active={verifNeutFilter === np} onclick={() => (verifNeutFilter = np)} type="button">{np}%</button>
					{/each}
				</div>
			</div>
			<span class="muted" style="margin-left:auto; font-size:0.85em">
				{visibleVerifiedPairs.length} / {verifiedPairs.length} rows
			</span>
		</div>
		<table>
			<thead>
				<tr>
					<th>Sweep</th>
					<th>Config</th>
					<th class="num">Neut</th>
					<th>Method</th>
					<th class="num">n</th>
					<th class="num">Retest Corr</th>
					<th class="num">Method Corr (mean ± SE)</th>
					<th class="num">Retest Sharpe</th>
					<th>Per-fold Corrs</th>
					<th>Per-fold Sharpes</th>
				</tr>
			</thead>
			<tbody>
				{#each visibleVerifiedPairs as p (`${p.row.sweep}:${p.row.name}:${p.row.neut_pct}:${p.v.method}`)}
					<tr>
						<td class="mono muted">{p.row.sweep}</td>
						<td class="mono">{p.row.name}</td>
						<td class="num muted">{p.row.neut_pct}%</td>
						<td class="mono muted">{p.v.method.replace('_r1240', '').replace('cv_', '')}</td>
						<td class="num muted">{p.v.n_folds}</td>
						<td class="num {metricClass(p.row.correlation)}">{signed(p.row.correlation, 6)}</td>
						<td class="num {metricClass(p.v.corr_mean)}">
							{signed(p.v.corr_mean, 6)}
							{#if p.v.corr_std_err != null}<span class="muted"> ± {fmt(p.v.corr_std_err, 4)}</span>{/if}
						</td>
						<td class="num {metricClass(p.row.sharpe)}">{signed(p.row.sharpe)}</td>
						<td class="mono muted" style="font-size:0.8em">{fmtPerFold(p.v.per_fold_corrs, 4)}</td>
						<td class="mono muted" style="font-size:0.8em">{fmtPerFold(p.v.per_fold_sharpes, 3)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
	{/if}

	<!-- ── TabM × Neut grid ── -->
	{#if hasFullNeutSweep}
	<section class="card">
		<h2>TabM × Neut grid</h2>
		<p class="muted">
			Fresh inference across all 8 TabM checkpoints at 0/25/50/75% neutralization
			(32 metric snapshots). Cell shading is normalized over the visible metric.
		</p>
		<div class="control-group" style="margin-bottom:0.6rem">
			<span class="control-label">Metric</span>
			<div class="seg">
				<button class:active={gridMetric === 'correlation'}     onclick={() => (gridMetric = 'correlation')}     type="button">Corr</button>
				<button class:active={gridMetric === 'sharpe'}          onclick={() => (gridMetric = 'sharpe')}          type="button">Sharpe</button>
				<button class:active={gridMetric === 'mmc'}             onclick={() => (gridMetric = 'mmc')}             type="button">MMC</button>
				<button class:active={gridMetric === 'feature_exposure'} onclick={() => (gridMetric = 'feature_exposure')} type="button">FeatExp</button>
			</div>
		</div>
		<table class="grid">
			<thead>
				<tr>
					<th>Model</th>
					{#each NEUT_LEVELS as np (np)}
						<th class="num">{np}%</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each tabmNames as name (name)}
					<tr>
						<td class="mono">{name}</td>
						{#each NEUT_LEVELS as np (np)}
							{@const v = gridValue(name, np)}
							<td class="num cell" style={gridCellStyle(v)}>
								{v === null ? '—' : (gridMetric === 'correlation' || gridMetric === 'mmc') ? fmt(v, 6) : fmt(v, 4)}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</section>
	{/if}

	<!-- ── tabicl successes ── -->
	<section class="card">
		<h2>tabicl-sweep (8 successes)</h2>
		<p class="muted">
			<code>ctx-16k</code> is the strongest by MMC. <code>eras-24</code> went negative
			across the board — clear miss.
		</p>
		<table>
			<thead>
				<tr>
					<th>Name</th>
					<th>Target</th>
					<th class="num">Neut</th>
					<th class="num">Corr</th>
					<th class="num">Sharpe</th>
					<th class="num">MMC</th>
					<th class="num">FeatExp</th>
					<th class="num">MaxDD</th>
				</tr>
			</thead>
			<tbody>
				{#each tabiclRows as r (`${r.sweep}:${r.name}:${r.neut_pct}`)}
					<tr>
						<td class="mono">{r.name}</td>
						<td class="mono muted">{r.target ?? '—'}</td>
						<td class="num muted">{r.neut_pct}%</td>
						<td class="num {metricClass(r.correlation)}">{signed(r.correlation, 6)}</td>
						<td class="num {metricClass(r.sharpe)}">{signed(r.sharpe)}</td>
						<td class="num {metricClass(r.mmc)}">{signed(r.mmc, 6)}</td>
						<td class="num">{fmt(r.feature_exposure)}</td>
						<td class="num neg">{fmt(r.max_drawdown)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<!-- ── Head to head ── -->
	<section class="card">
		<h2>Head to head — wider-2048 vs ctx-16k</h2>
		<p class="muted">
			TabICL <code>ctx-16k</code> is an 8-target ensemble; its overall corr is dragged down
			by weaker targets. Its <code>target_delta_20</code> sub-model alone is essentially
			tied with TabM <code>wider-2048</code>.
		</p>
		<table>
			<thead>
				<tr>
					<th>Metric</th>
					<th class="num">TabM wider-2048</th>
					<th class="num">TabICL ctx-16k (full)</th>
					<th class="num">ctx-16k · target_delta_20</th>
				</tr>
			</thead>
			<tbody>
				{#each headToHead as h (h.metric)}
					<tr>
						<td class="mono">{h.metric}</td>
						<td class="num">{signed(h.wider, 6)}</td>
						<td class="num">{signed(h.ctx, 6)}</td>
						<td class="num">{h.ctxOnDelta === null ? '—' : signed(h.ctxOnDelta, 6)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<p class="callout">
			Two very different model families converging on essentially the same target_delta_20
			performance — exactly the diversification profile you want for an ensemble.
		</p>
	</section>

	<!-- ── Multivariate explorer ── -->
	<section class="card">
		<h2>Multivariate explorer</h2>
		<p class="muted">
			{runs.length} run snapshots ({tabmRows.length} TabM × neut + {tabiclRows.length} TabICL)
			plotted across selectable axes. Switch between 2D, 3D, and
			<strong>parallel coordinates</strong> — parcoords puts every metric on its
			own axis at once, and you can drag a range on any axis to brush-filter the
			rest. Color by a numeric metric (colorbar) or by family / sweep / verified
			(legend). Hover any point for its full hyperparameters.
		</p>

		<div class="explorer-controls">
			<div class="control-group">
				<span class="control-label">View</span>
				<div class="seg">
					<button class:active={viewMode === '2d'} onclick={() => (viewMode = '2d')} type="button">2D</button>
					<button class:active={viewMode === '3d'} onclick={() => (viewMode = '3d')} type="button">3D</button>
					<button class:active={viewMode === 'parcoords'} onclick={() => (viewMode = 'parcoords')} type="button">Parcoords</button>
				</div>
			</div>

			<div class="control-group">
				<span class="control-label">Color by</span>
				<div class="seg">
					<button class:active={colorMode === 'numeric'}  onclick={() => (colorMode = 'numeric')}  type="button">Metric</button>
					<button class:active={colorMode === 'family'}   onclick={() => (colorMode = 'family')}   type="button">Family</button>
					<button class:active={colorMode === 'sweep'}    onclick={() => (colorMode = 'sweep')}    type="button">Sweep</button>
					<button class:active={colorMode === 'verified'} onclick={() => (colorMode = 'verified')} type="button">Verified</button>
				</div>
			</div>

			<div class="control-group">
				<span class="control-label">Family</span>
				<div class="seg">
					<button class:active={familyFilter === 'all'}    onclick={() => (familyFilter = 'all')}    type="button">All</button>
					<button class:active={familyFilter === 'tabm'}   onclick={() => (familyFilter = 'tabm')}   type="button">TabM</button>
					<button class:active={familyFilter === 'tabicl'} onclick={() => (familyFilter = 'tabicl')} type="button">TabICL</button>
				</div>
			</div>

			<div class="control-group">
				<span class="control-label">Neut %</span>
				<div class="seg">
					<button class:active={neutFilter === 'all'} onclick={() => (neutFilter = 'all')} type="button">All</button>
					<button class:active={neutFilter === 0}     onclick={() => (neutFilter = 0)}     type="button">0%</button>
					<button class:active={neutFilter === 25}    onclick={() => (neutFilter = 25)}    type="button">25%</button>
					<button class:active={neutFilter === 50}    onclick={() => (neutFilter = 50)}    type="button">50%</button>
					<button class:active={neutFilter === 75}    onclick={() => (neutFilter = 75)}    type="button">75%</button>
				</div>
			</div>

			{#if viewMode !== 'parcoords'}
				<label class="control-group">
					<span class="control-label">X axis</span>
					<select bind:value={xKey}>
						{#each DIMS as d (d.key)}<option value={d.key}>{d.label}</option>{/each}
					</select>
				</label>

				<label class="control-group">
					<span class="control-label">Y axis</span>
					<select bind:value={yKey}>
						{#each DIMS as d (d.key)}<option value={d.key}>{d.label}</option>{/each}
					</select>
				</label>

				{#if viewMode === '3d'}
					<label class="control-group">
						<span class="control-label">Z axis</span>
						<select bind:value={zKey}>
							{#each DIMS as d (d.key)}<option value={d.key}>{d.label}</option>{/each}
						</select>
					</label>
				{/if}
			{/if}

			{#if colorMode === 'numeric'}
				<label class="control-group">
					<span class="control-label">Color metric</span>
					<select bind:value={colorKey}>
						{#each DIMS as d (d.key)}<option value={d.key}>{d.label}</option>{/each}
					</select>
				</label>
			{/if}

			{#if viewMode !== 'parcoords'}
				<div class="control-group">
					<span class="control-label">Fold errors</span>
					<div class="seg">
						<button class:active={!foldErrors} onclick={() => (foldErrors = false)} type="button">Off</button>
						<button class:active={foldErrors}  onclick={() => (foldErrors = true)}  type="button">Min→Max</button>
					</div>
				</div>
			{/if}
		</div>

		<div class="chart-container" bind:this={chartEl}></div>

		<p class="muted small">
			Tip: try X=<code>featExp</code>, Y=<code>mmc</code>, Color=<code>sharpe</code>
			(2D) to see the exposure ↔ MMC Pareto front, or X=<code>corr</code>,
			Y=<code>sharpe</code>, Z=<code>mmc</code>, Color=<code>featExp</code> (3D) for
			the full trade-off cube. With the full neut sweep, each TabM model now traces
			a curve through neut-space that you can see directly in the 3D view. In
			<strong>Parcoords</strong>, drag a vertical range on any axis to brush-filter
			— combine with Color by <code>sweep</code> to see which sweep owns which
			corner of the tradeoff space. Switch <strong>Fold errors</strong> to
			<code>Min→Max</code> with an axis set to <code>corr</code> or
			<code>sharpe</code> — rows with CV verifications sprout whiskers spanning
			their worst-fold to best-fold value, so configs with tight folds (consistent)
			immediately look different from configs with wide folds (one lucky era).
			The walk-forward verification is preferred; falls back to block CV.
		</p>
	</section>

	<!-- ── Wider-2048 neutralization sweep ── -->
	<section class="card">
		<h2>wider-2048 — neutralization sweep</h2>
		<p>
			Headline result: a fresh inference run on the saved <code>wider-2048</code>
			checkpoint at four neutralization levels. The 25% row reproduces the recovered
			<code>run.log</code> values bit-for-bit.
		</p>
		<table>
			<thead>
				<tr>
					<th class="num">Neut %</th>
					<th class="num">Corr</th>
					<th class="num">Sharpe</th>
					<th class="num">MMC</th>
					<th class="num">FeatExp</th>
				</tr>
			</thead>
			<tbody>
				{#each widerNeut as r (r.neut_pct)}
					<tr class:original={Number(r.neut_pct) === 25}>
						<td class="num">{r.neut_pct}%{#if Number(r.neut_pct) === 25}&nbsp;<span class="badge">original</span>{/if}</td>
						<td class="num">{signed(r.correlation, 6)}</td>
						<td class="num">{signed(r.sharpe)}</td>
						<td class="num">{signed(r.mmc, 6)}</td>
						<td class="num">{fmt(r.feature_exposure)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<p class="callout">
			Sharpe peaks at 75%, MMC at 0%, but <strong>50%</strong> looks like the best
			balance — Sharpe up 8% over the original (0.713 vs 0.662), MMC only 9% lower,
			feature exposure cut by a quarter (0.218 vs 0.290). Worth considering as a new
			default for TabM runs in this region.
		</p>
	</section>

	<!-- ── Live diversification check ── -->
	<section class="card">
		<h2>Live diversification check</h2>
		<p>
			Generated a <code>wider-2048</code> live submission for round&nbsp;{liveDiv.round}
			(matching the round of the existing <code>ctx-16k/submission_r1237.csv</code>),
			then computed the rank correlation between the two prediction vectors over the
			{liveDiv.nCommonIds.toLocaleString()} common ids.
		</p>
		<div class="metric-grid">
			<div class="metric-tile">
				<div class="metric-label">Spearman</div>
				<div class="metric-value">{liveDiv.spearman.toFixed(4)}</div>
			</div>
			<div class="metric-tile">
				<div class="metric-label">Pearson</div>
				<div class="metric-value">{liveDiv.pearson.toFixed(4)}</div>
			</div>
			<div class="metric-tile">
				<div class="metric-label">Common ids</div>
				<div class="metric-value">{liveDiv.nCommonIds.toLocaleString()}</div>
			</div>
		</div>
		<p class="verdict">
			<strong>Verdict:</strong> {liveDiv.verdict}
		</p>
	</section>

	<!-- ── Next ── -->
	<section class="card">
		<h2>Next</h2>
		<ol>
			<li>Run TabICL inference for <code>ctx-16k</code>'s <code>target_delta_20</code> head on the val set (~10–15&nbsp;min on this GPU).</li>
			<li>Rank-average it with the saved <code>val_preds_wider2048.parquet</code>.</li>
			<li>Score the combined predictions at 0/25/50/75% neut and pick the winner.</li>
			<li>Patch <code>trainer.py</code> so the post-validation OOM no longer destroys metrics.json.</li>
		</ol>
	</section>
</div>

<style>
	.page { display: flex; flex-direction: column; gap: 1.5rem; }
	.hero { padding: 0.5rem 0; }
	.hero h1 { margin: 0 0 0.4rem; font-size: 1.4rem; color: var(--text); font-weight: 700; }
	.lede { margin: 0; max-width: 70ch; font-size: 0.95rem; color: var(--text-secondary); line-height: 1.5; }
	.meta { margin-top: 0.6rem; display: flex; flex-wrap: wrap; gap: 0.5rem; font-size: 0.75rem; color: var(--text-muted); }
	.meta .src { font-style: italic; }

	.filter-bar {
		margin-top: 0.9rem;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		padding: 0.55rem 0.8rem;
		background: var(--bg-input);
		border: 1px solid var(--border-light);
		border-radius: 6px;
	}
	.filter-label {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-secondary);
		font-weight: 600;
	}
	.filter-count {
		margin-left: auto;
		font-size: 0.74rem;
		color: var(--text-muted);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace;
	}

	.card {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: var(--shadow-sm);
		padding: 1.25rem 1.5rem;
	}
	.card h2 { margin: 0 0 0.6rem; font-size: 1.05rem; color: var(--text); font-weight: 600; }
	.card p { margin: 0.4rem 0; line-height: 1.55; color: var(--text); font-size: 0.9rem; }
	.card p.muted { color: var(--text-secondary); font-size: 0.83rem; }
	.card ol { margin: 0.4rem 0 0; padding-left: 1.4rem; color: var(--text); font-size: 0.9rem; line-height: 1.6; }

	.callout { margin-top: 0.8rem !important; padding: 0.7rem 0.9rem; background: var(--badge-blue); border-left: 3px solid var(--blue); border-radius: 4px; font-size: 0.86rem !important; }
	.verdict { margin-top: 0.8rem !important; padding: 0.7rem 0.9rem; background: var(--badge-green); border-left: 3px solid var(--green); border-radius: 4px; font-size: 0.9rem !important; }

	table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.84rem; }
	th, td { padding: 0.42rem 0.6rem; text-align: left; border-bottom: 1px solid var(--border-light); }
	th { font-weight: 600; color: var(--text-secondary); font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.03em; background: var(--bg-input); }
	td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
	td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace; font-size: 0.82rem; }
	td.muted { color: var(--text-secondary); font-size: 0.78rem; }

	tr.winner { background: var(--badge-green); }
	tr.original { background: var(--badge-blue); }

	.pos { color: var(--green); }
	.neg { color: var(--red); }
	.warn { color: var(--orange); }

	.badge {
		display: inline-block; font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.04em;
		background: var(--badge-green); color: var(--green); padding: 0.1rem 0.4rem; border-radius: 4px;
		margin-left: 0.4rem; vertical-align: middle;
	}
	tr.original .badge { background: var(--badge-blue); color: var(--blue); }

	code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace;
		font-size: 0.85em; background: var(--bg-input); padding: 0.05rem 0.35rem; border-radius: 3px;
		color: var(--text);
	}

	.metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin: 0.8rem 0 0.4rem; }
	.metric-tile { padding: 0.8rem 1rem; background: var(--bg-input); border: 1px solid var(--border-light); border-radius: 6px; }
	.metric-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); margin-bottom: 0.2rem; }
	.metric-value { font-size: 1.35rem; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--text); }

	/* Multivariate explorer controls */
	.explorer-controls {
		display: flex; flex-wrap: wrap; gap: 0.85rem 1.25rem;
		margin: 0.9rem 0 0.6rem; padding: 0.75rem 0.9rem;
		background: var(--bg-input); border: 1px solid var(--border-light); border-radius: 6px;
	}
	.control-group { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
	.control-label { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); font-weight: 600; }
	.control-group select {
		background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px;
		padding: 0.32rem 0.5rem; font-size: 0.83rem; color: var(--text); font-family: inherit;
		cursor: pointer; min-width: 8rem;
	}
	.control-group select:hover { border-color: var(--blue); }

	.seg { display: inline-flex; background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
	.seg button {
		background: transparent; border: none; padding: 0.32rem 0.7rem;
		font-size: 0.8rem; color: var(--text-secondary); cursor: pointer;
		font-family: inherit; transition: background 0.15s, color 0.15s;
	}
	.seg button:not(:last-child) { border-right: 1px solid var(--border); }
	.seg button:hover { background: var(--hover-bg); }
	.seg button.active { background: var(--badge-blue); color: var(--blue); font-weight: 600; }

	.chart-container { width: 100%; min-height: 480px; margin-top: 0.4rem; }

	/* TabM x Neut grid */
	table.grid td.cell {
		font-variant-numeric: tabular-nums;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace;
		font-size: 0.78rem;
	}

	p.small { font-size: 0.76rem !important; }

	@media (max-width: 640px) {
		.card { padding: 1rem; }
		table { font-size: 0.76rem; }
		th, td { padding: 0.35rem 0.4rem; }
		.explorer-controls { flex-direction: column; align-items: stretch; gap: 0.6rem; }
		.control-group select { width: 100%; }
	}
</style>
