-- ML / Numerai tables

CREATE TABLE ml_experiments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) UNIQUE NOT NULL,
    description VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ml_runs (
    id SERIAL PRIMARY KEY,
    experiment_id INTEGER NOT NULL REFERENCES ml_experiments(id) ON DELETE CASCADE,
    model_type VARCHAR(30) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    hyperparams_json VARCHAR(4000),
    correlation NUMERIC(10,6),
    sharpe NUMERIC(10,6),
    feature_exposure NUMERIC(10,6),
    max_drawdown NUMERIC(10,6),
    progress_pct NUMERIC(5,2) DEFAULT 0,
    current_epoch INTEGER DEFAULT 0,
    total_epochs INTEGER DEFAULT 0,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ix_ml_runs_experiment_status ON ml_runs(experiment_id, status);

CREATE TABLE ml_epoch_metrics (
    id SERIAL PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES ml_runs(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    train_loss NUMERIC(10,6),
    val_loss NUMERIC(10,6),
    correlation NUMERIC(10,6),
    sharpe NUMERIC(10,6)
);
CREATE UNIQUE INDEX ix_ml_epoch_metrics_run_epoch ON ml_epoch_metrics(run_id, epoch);

CREATE TABLE ml_models (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) UNIQUE NOT NULL,
    model_type VARCHAR(30) NOT NULL,
    stage VARCHAR(20) NOT NULL DEFAULT 'dev',
    version INTEGER NOT NULL DEFAULT 1,
    run_id INTEGER REFERENCES ml_runs(id) ON DELETE SET NULL,
    correlation NUMERIC(10,6),
    sharpe NUMERIC(10,6),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ix_ml_models_stage ON ml_models(stage);

CREATE TABLE ml_rounds (
    id SERIAL PRIMARY KEY,
    round_number INTEGER NOT NULL,
    model_name VARCHAR(120) NOT NULL,
    live_corr NUMERIC(10,6),
    resolved_corr NUMERIC(10,6),
    payout_nmr NUMERIC(10,6),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX ix_ml_rounds_round_model ON ml_rounds(round_number, model_name);

CREATE TABLE ml_ensembles (
    id SERIAL PRIMARY KEY,
    method VARCHAR(30) NOT NULL,
    config_json VARCHAR(4000),
    correlation NUMERIC(10,6),
    sharpe NUMERIC(10,6),
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ix_ml_ensembles_active ON ml_ensembles(is_active);
