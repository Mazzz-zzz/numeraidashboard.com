-- Local sweep results — investigations run on the local box, not via SageMaker.
-- One row per (sweep × run × neut_pct) snapshot. Each TabM checkpoint contributes
-- 4 rows (one per neutralization level from a fresh inference pass), each TabICL
-- run contributes 1 row from sweep_results.json.
--
-- Run against the openoptions database on RDS:
--   psql $DATABASE_URL -f migrations/005_local_runs.sql
-- Then seed with:
--   python -m scripts.seed_local_runs path/to/local_runs.json

CREATE TABLE IF NOT EXISTS local_runs (
    id SERIAL PRIMARY KEY,
    sweep VARCHAR(60) NOT NULL,                  -- 'tabm-combo', 'tabicl-sweep', ...
    name VARCHAR(120) NOT NULL,                  -- 'wider-2048', 'ctx-16k', ...
    family VARCHAR(30) NOT NULL,                 -- 'tabm', 'tabicl'
    model_type VARCHAR(30) NOT NULL,             -- mirrors family for now
    status VARCHAR(20) NOT NULL,                 -- 'OK', 'RECOVERED', 'FAILED'
    target VARCHAR(60),                          -- 'target_delta_20'
    elapsed_seconds NUMERIC(12, 2),

    neut_pct NUMERIC(5, 2) NOT NULL,             -- 0/25/50/75 (snapshot key)
    correlation NUMERIC(12, 8),
    sharpe NUMERIC(12, 6),
    mmc NUMERIC(12, 8),
    feature_exposure NUMERIC(12, 6),
    max_drawdown NUMERIC(12, 6),

    hyperparams_json VARCHAR(2000),              -- JSON-encoded hyperparams
    sweep_dir VARCHAR(500),                      -- absolute path on the box that produced it
    source VARCHAR(60),                          -- 'fresh_inference', 'sweep_results_json', 'recovered_from_log'

    inserted_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_local_runs_unique
    ON local_runs(sweep, name, neut_pct);
CREATE INDEX IF NOT EXISTS ix_local_runs_family ON local_runs(family);
CREATE INDEX IF NOT EXISTS ix_local_runs_sweep ON local_runs(sweep);
