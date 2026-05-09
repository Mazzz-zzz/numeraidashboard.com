-- Expand local_runs to support multi-target verification.
--
-- 1. Widen hyperparams_json from VARCHAR(2000) → TEXT. The verifications
--    list grows linearly as more CV methods get attached to each row,
--    and K=10 block CV + K=3 walk-forward already sits around 1200
--    characters; adding a third method or another target would blow
--    the old cap.
--
-- 2. Include `target` in the unique key so the same (sweep, name,
--    neut_pct) row can coexist across different training targets —
--    each TabM/TabICL config can be verified against every Numerai
--    target independently.
--
-- 3. Make `target` NOT NULL (we've never inserted a NULL target, and
--    the new unique index treats NULLs as distinct which would let
--    accidental NULLs sneak past the uniqueness check).
--
-- Run against the openoptions database on RDS:
--   psql $DATABASE_URL -f migrations/006_local_runs_multitarget.sql

BEGIN;

ALTER TABLE local_runs
    ALTER COLUMN hyperparams_json TYPE TEXT;

-- Any historical row without a target must have been target_delta_20 —
-- that's the only target we've ever scored. Fill it in before tightening
-- the NOT NULL.
UPDATE local_runs SET target = 'target_delta_20' WHERE target IS NULL;

ALTER TABLE local_runs
    ALTER COLUMN target SET NOT NULL;

DROP INDEX IF EXISTS ix_local_runs_unique;
CREATE UNIQUE INDEX ix_local_runs_unique
    ON local_runs(sweep, name, neut_pct, target);

CREATE INDEX IF NOT EXISTS ix_local_runs_target ON local_runs(target);

COMMIT;
