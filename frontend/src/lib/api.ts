const API_URL = import.meta.env.VITE_API_URL ?? '';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const opts: RequestInit = {
		method,
		headers: { 'Content-Type': 'application/json' },
	};
	if (body) {
		opts.body = JSON.stringify(body);
	}

	const res = await fetch(`${API_URL}/api${path}`, opts);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`API ${method} ${path} failed: ${res.status} ${text}`);
	}
	return res.json();
}

/** Encode underlying for use in URL path.
 *  API Gateway decodes %2F to / before passing to Lambda, so we
 *  double-encode the slash: / → %252F → API GW decodes to %2F → FastAPI decodes to /
 */
function encodeSymbol(underlying: string): string {
	return underlying.startsWith('/')
		? '%2F' + encodeURIComponent(underlying.slice(1))
		: encodeURIComponent(underlying);
}

export const api = {
	// Underlyings
	getUnderlyings() {
		return request<{ data: FetchedUnderlying[] }>('GET', '/underlyings');
	},

	// Exogenous
	getExoSources() {
		return request<{ data: ExoSource[] }>('GET', '/exogenous/sources');
	},

	getExoTastytrade(date?: string) {
		const qs = date ? `?date=${date}` : '';
		return request<{ data: ExoTastytradeRow[] }>('GET', `/exogenous/tastytrade${qs}`);
	},

	syncExoTastytrade() {
		return request<{ synced: number }>('POST', '/exogenous/tastytrade/sync');
	},

	// Fetch
	fetchChain(underlying: string, force = false) {
		const qs = force ? '?force=true' : '';
		return request<{ snapshots: number; alerts_raised: number }>('POST', `/fetch/${encodeSymbol(underlying)}${qs}`);
	},

	// Alerts
	getAlerts(params?: { cursor?: number; limit?: number; signal_type?: string }) {
		const query = new URLSearchParams();
		if (params?.cursor) query.set('cursor', String(params.cursor));
		if (params?.limit) query.set('limit', String(params.limit));
		if (params?.signal_type) query.set('signal_type', params.signal_type);
		const qs = query.toString();
		return request<{ data: Alert[]; next_cursor: number | null }>('GET', `/alerts${qs ? `?${qs}` : ''}`);
	},

	dismissAlert(id: number) {
		return request<{ id: number; dismissed: boolean }>('POST', `/alerts/${id}/dismiss`);
	},

	// Contracts
	getContracts(params?: { underlying?: string; limit?: number }) {
		const query = new URLSearchParams();
		if (params?.underlying) query.set('underlying', params.underlying);
		if (params?.limit) query.set('limit', String(params.limit));
		const qs = query.toString();
		return request<{ data: Contract[]; total: number }>('GET', `/contracts${qs ? `?${qs}` : ''}`);
	},

	// Surface
	getSurface(underlying: string, optionType?: string) {
		const query = new URLSearchParams();
		if (optionType) query.set('option_type', optionType);
		const qs = query.toString();
		return request<SurfaceData>('GET', `/surface/${encodeSymbol(underlying)}${qs ? `?${qs}` : ''}`);
	},

	// Snapshots
	getSnapshots(contractId: number, limit = 50) {
		return request<{ data: SnapshotData[] }>('GET', `/snapshots/${contractId}?limit=${limit}`);
	},

	// IV Analysis
	getIvAnalysis(underlying: string, lookbackDays = 30) {
		return request<IvAnalysisData>('GET', `/iv-analysis/${encodeSymbol(underlying)}?lookback_days=${lookbackDays}`);
	},

	// ML / Numerai
	getMlOverview(tournament?: string) {
		const qs = tournament ? `?tournament=${tournament}` : '';
		return request<MlOverview>('GET', `/ml/overview${qs}`);
	},

	getMlExperiments(params?: { cursor?: number; limit?: number; tournament?: string }) {
		const query = new URLSearchParams();
		if (params?.cursor) query.set('cursor', String(params.cursor));
		if (params?.limit) query.set('limit', String(params.limit));
		if (params?.tournament) query.set('tournament', params.tournament);
		const qs = query.toString();
		return request<{ data: MlExperimentData[]; next_cursor: number | null }>('GET', `/ml/experiments${qs ? `?${qs}` : ''}`);
	},

	getMlRuns(experimentId: number) {
		return request<{ data: MlRunData[] }>('GET', `/ml/experiments/${experimentId}/runs`);
	},

	getMlRunMetrics(runId: number) {
		return request<{ data: MlEpochMetric[] }>('GET', `/ml/runs/${runId}/metrics`);
	},

	getMlModels(tournament?: string) {
		const qs = tournament ? `?tournament=${tournament}` : '';
		return request<{ data: MlModelData[] }>('GET', `/ml/models${qs}`);
	},

	createMlModel(body: { name: string; model_type: string; run_id?: number; correlation?: number; sharpe?: number }) {
		return request<MlModelData>('POST', '/ml/models', body);
	},

	updateMlModel(id: number, body: { stage?: string; numerai_model_id?: string }) {
		return request<MlModelData>('PATCH', `/ml/models/${id}`, body);
	},

	submitModel(id: number) {
		return request<MlSubmitResponse>('POST', `/ml/models/${id}/submit`);
	},

	registerWebhook(id: number) {
		return request<MlWebhookResponse>('POST', `/ml/models/${id}/webhook`);
	},

	deregisterWebhook(id: number) {
		return request<{ model_id: number; webhook_active: boolean }>('DELETE', `/ml/models/${id}/webhook`);
	},

	getMlRounds(limit = 50, tournament?: string) {
		const query = new URLSearchParams({ limit: String(limit) });
		if (tournament) query.set('tournament', tournament);
		return request<{ data: MlRoundData[] }>('GET', `/ml/rounds?${query}`);
	},

	getMlEnsemble() {
		return request<{ data: MlEnsembleData | null }>('GET', '/ml/ensemble');
	},

	getMlLocalRuns(filters?: { sweep?: string; family?: string; target?: string }) {
		const query = new URLSearchParams();
		if (filters?.sweep) query.set('sweep', filters.sweep);
		if (filters?.family) query.set('family', filters.family);
		if (filters?.target) query.set('target', filters.target);
		const qs = query.toString();
		return request<{ data: LocalRunData[] }>('GET', `/ml/local-runs${qs ? `?${qs}` : ''}`);
	},

	triggerTraining(body: TrainRequest) {
		return request<TrainResponse>('POST', '/ml/train', body);
	},

	cancelTraining(runId: number) {
		return request<{ run_id: number; status: string }>('POST', `/ml/runs/${runId}/cancel`);
	},

	// Chart
	getChartOhlc(underlying: string, days = 90) {
		return request<ChartOhlcBar[]>('GET', `/chart/ohlc/${encodeSymbol(underlying)}?days=${days}`);
	},

	getChartChain(underlying: string) {
		return request<ChartChainResponse>('GET', `/chart/chain/${encodeSymbol(underlying)}`);
	},
};

// Types
export interface FetchedUnderlying {
	symbol: string;
	market: string;
	source: string;
	last_fetched_at: string | null;
	last_spot: number | null;
	last_snapshot_count: number;
	last_alert_count: number;
	iv_index: number | null;
	iv_index_5d_change: number | null;
	iv_rank: number | null;
	iv_percentile: number | null;
	liquidity_rating: number | null;
}

export interface ExoSource {
	id: number;
	key: string;
	name: string;
	source_type: string;
	enabled: boolean;
	row_count: number;
	symbols: number;
	min_date: string | null;
	max_date: string | null;
}

export interface ExoTastytradeRow {
	symbol: string;
	captured_date: string;
	spot_price: number | null;
	iv_rank: number | null;
	iv_percentile: number | null;
	iv_index: number | null;
	iv_5d_change: number | null;
	liquidity: number | null;
}

export interface Alert {
	id: number;
	signal_type: string;
	confidence: string | null;
	dismissed: boolean;
	created_at: string;
	snapshot_id: number;
	bid: number | null;
	ask: number | null;
	mid: number | null;
	market_iv: number | null;
	model_iv: number | null;
	vega: number | null;
	gamma: number | null;
	theta: number | null;
	deviation: number | null;
	net_edge: number | null;
	triggered_by: string | null;
	symbol: string;
	underlying: string;
	strike: number;
	expiry: string;
	option_type: string;
}

export interface Contract {
	id: number;
	symbol: string;
	underlying: string;
	market: string;
	source: string;
	strike: number;
	expiry: string;
	option_type: string;
}

export interface SurfaceData {
	x: number[];
	x_moneyness: number[];
	y: string[];
	z_market: (number | null)[][];
	z_model: (number | null)[][];
	points: SurfacePoint[];
	spot: number | null;
}

export interface SurfacePoint {
	symbol: string;
	strike: number;
	moneyness: number | null;
	expiry: string;
	option_type: string;
	bid: number | null;
	ask: number | null;
	mid: number | null;
	market_iv: number | null;
	model_iv: number | null;
	delta_market: number | null;
	delta_model: number | null;
	vega: number | null;
	gamma: number | null;
	theta: number | null;
	deviation: number | null;
	net_edge: number | null;
}

export interface SnapshotData {
	id: number;
	ts: string | null;
	bid: number | null;
	ask: number | null;
	mid: number | null;
	market_iv: number | null;
	model_iv: number | null;
	delta_market: number | null;
	delta_model: number | null;
	vega: number | null;
	gamma: number | null;
	theta: number | null;
	deviation: number | null;
	net_edge: number | null;
	triggered_by: string | null;
}

export interface IvAnalysisData {
	spot: number | null;
	term_structure: TermStructurePoint[];
	ts_slope: number | null;
	skew_by_expiry: SkewByExpiry[];
	smile: SmilePoint[];
	straddles: StraddleData[];
	forwards: ForwardData[];
	opportunities: OpportunityData[];
	put_call_summary: PutCallSummary | null;
	iv_rank: IvRankData | null;
	historical_iv: { ts: string; iv: number }[];
	market_metrics: MarketMetrics | null;
	earnings: EarningEvent[];
	dividends: DividendEvent[];
}

export interface ForwardData {
	expiry: string;
	dte: number;
	forward_price: number;
	implied_yield: number | null;
	basis: number;
	basis_pct: number | null;
	pairs: ForwardPair[];
}

export interface ForwardPair {
	strike: number;
	call_mid: number;
	put_mid: number;
	synthetic_forward: number;
	violation_pct: number;
}

export interface OpportunityData {
	symbol: string;
	underlying: string;
	strike: number;
	expiry: string;
	dte: number;
	option_type: string;
	market_iv: number | null;
	model_iv: number | null;
	deviation: number;
	net_edge: number;
	vega: number | null;
	delta: number | null;
	bid: number | null;
	ask: number | null;
}

export interface MarketMetrics {
	iv_index: number | null;
	iv_index_5d_change: number | null;
	iv_rank: number | null;
	iv_percentile: number | null;
	liquidity: number | null;
	liquidity_rank: number | null;
	liquidity_rating: number | null;
}

export interface EarningEvent {
	date: string;
	eps: number | null;
}

export interface DividendEvent {
	date: string;
	amount: number | null;
}

export interface TermStructurePoint {
	expiry: string;
	dte: number;
	atm_iv: number;
	atm_model_iv: number | null;
	atm_strike: number;
}

export interface SkewByExpiry {
	expiry: string;
	dte: number;
	atm_iv: number;
	put_25d_iv: number | null;
	call_25d_iv: number | null;
	put_10d_iv: number | null;
	call_10d_iv: number | null;
	risk_reversal: number | null;
	butterfly: number | null;
	avg_deviation: number | null;
	max_deviation: number | null;
	contracts_with_edge: number;
	total_contracts: number;
	total_vega: number;
}

export interface SmilePoint {
	expiry: string;
	dte: number;
	strike: number;
	moneyness: number;
	delta: number;
	option_type: string;
	market_iv: number;
	model_iv: number | null;
	deviation: number | null;
	net_edge: number | null;
	vega: number | null;
}

export interface StraddleData {
	expiry: string;
	dte: number;
	atm_strike: number;
	atm_iv: number;
	atm_model_iv: number | null;
	vol_premium: number | null;
	call_mid: number;
	put_mid: number;
	straddle_price: number;
	straddle_pct: number;
	breakeven_up: number;
	breakeven_down: number;
	total_spread: number;
	total_theta: number | null;
	total_vega: number | null;
	total_gamma: number | null;
	theta_vega_ratio: number | null;
	risk_reversal: number | null;
}

export interface PutCallSummary {
	avg_put_iv: number | null;
	avg_call_iv: number | null;
	put_call_iv_spread: number | null;
	total_put_vega: number;
	total_call_vega: number;
	put_count: number;
	call_count: number;
}

export interface IvRankData {
	current_iv: number | null;
	rank: number | null;
	percentile: number | null;
	high: number | null;
	low: number | null;
	lookback_days: number;
	data_points: number;
}

// ── ML / Numerai types ──────────────────────────────────────────────

export interface MlOverview {
	active_runs: number;
	best_model: {
		name: string;
		correlation: number | null;
		sharpe: number | null;
		feature_exposure: number | null;
		max_drawdown: number | null;
		mmc: number | null;
	} | null;
	latest_round: { round_number: number; status: string; live_corr: number | null } | null;
	ensemble_score: number | null;
	total_cost_usd: number;
	recent_runs: MlRecentRun[];
}

export interface MlRecentRun {
	id: number;
	model_type: string;
	status: string;
	correlation: number | null;
	sharpe: number | null;
	feature_exposure: number | null;
	max_drawdown: number | null;
	mmc: number | null;
	progress_pct: number | null;
	instance_type: string | null;
	cost_usd: number | null;
	started_at: string;
	finished_at: string;
}

export interface MlExperimentData {
	id: number;
	name: string;
	description: string | null;
	status: string;
	created_at: string;
	run_count: number;
	best_corr: number | null;
}

export interface MlRunData {
	id: number;
	experiment_id: number;
	model_type: string;
	status: string;
	hyperparams_json: string | null;
	correlation: number | null;
	sharpe: number | null;
	feature_exposure: number | null;
	max_drawdown: number | null;
	mmc: number | null;
	progress_pct: number | null;
	current_epoch: number | null;
	total_epochs: number | null;
	instance_type: string | null;
	cost_usd: number | null;
	started_at: string | null;
	finished_at: string | null;
	created_at: string;
}

export interface MlEpochMetric {
	epoch: number;
	train_loss: number | null;
	val_loss: number | null;
	correlation: number | null;
	sharpe: number | null;
}

export interface MlModelData {
	id: number;
	name: string;
	model_type: string;
	stage: string;
	version: number;
	run_id: number | null;
	correlation: number | null;
	sharpe: number | null;
	feature_exposure: number | null;
	max_drawdown: number | null;
	mmc: number | null;
	numerai_model_id: string | null;
	s3_artifact_path: string | null;
	webhook_active: boolean;
	last_submission_round: number | null;
	last_submission_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface MlSubmitResponse {
	job_name: string;
	job_arn: string;
	model_id: number;
	round_id: number;
	status: string;
}

export interface MlWebhookResponse {
	model_id: number;
	webhook_url: string;
	webhook_active: boolean;
}

export interface MlRoundData {
	id: number;
	round_number: number;
	model_name: string;
	live_corr: number | null;
	resolved_corr: number | null;
	payout_nmr: number | null;
	status: string;
	submitted_at: string | null;
	created_at: string;
}

export interface MlEnsembleData {
	id: number;
	method: string;
	config_json: string | null;
	correlation: number | null;
	sharpe: number | null;
	is_active: boolean;
	created_at: string;
}

export interface LocalRunVerification {
	method: string;
	description?: string;
	val_round: number;
	n_folds: number;
	corr_mean: number | null;
	corr_std?: number | null;
	corr_std_err: number | null;
	per_fold_corrs?: number[] | null;
	per_fold_sharpes?: number[] | null;
	source_config?: string;
}

export interface LocalRunHyperparams {
	verifications?: LocalRunVerification[];
	[key: string]: unknown;
}

export interface LocalRunData {
	id: number;
	sweep: string;
	name: string;
	family: string;
	model_type: string;
	status: string;
	target: string | null;
	elapsed_seconds: number | null;
	neut_pct: number;
	correlation: number | null;
	sharpe: number | null;
	mmc: number | null;
	feature_exposure: number | null;
	max_drawdown: number | null;
	hyperparams: LocalRunHyperparams | null;
	sweep_dir: string | null;
	source: string | null;
	inserted_at: string | null;
}

export interface TrainRequest {
	experiment_name: string;
	description?: string;
	feature_set: string;
	model_type: string;
	instance_type: string;
	hyperparams?: Record<string, unknown>;
	upload?: boolean;
	// NEW: Model configuration options
	neutralization_pct?: number;  // 0-100, default 50
}

export interface TrainResponse {
	run_id: number;
	experiment_id: number;
	sagemaker_job_name: string;
}

// Chart types
export interface ChartOhlcBar {
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
}

export interface ChartLeg {
	bid: number | null;
	ask: number | null;
	mid: number | null;
	iv: number | null;
	delta: number | null;
	gamma: number | null;
	vega: number | null;
	theta: number | null;
	deviation: number | null;
	ts: string | null;
}

export interface ChartChainStrikeRow {
	strike: number;
	call: ChartLeg | null;
	put: ChartLeg | null;
}

export interface ChartChainExpiration {
	expiry: string;
	rows: ChartChainStrikeRow[];
}

export interface ChartChainResponse {
	underlying: string;
	spot: number | null;
	expirations: ChartChainExpiration[];
}
