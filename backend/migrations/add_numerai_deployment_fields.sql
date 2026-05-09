-- Add Numerai production deployment fields to ml_models
-- Run against the openoptions database on RDS

ALTER TABLE ml_models ADD COLUMN IF NOT EXISTS numerai_model_id VARCHAR(60);
ALTER TABLE ml_models ADD COLUMN IF NOT EXISTS s3_artifact_path VARCHAR(500);
ALTER TABLE ml_models ADD COLUMN IF NOT EXISTS webhook_active BOOLEAN DEFAULT FALSE;
ALTER TABLE ml_models ADD COLUMN IF NOT EXISTS last_submission_round INTEGER;
ALTER TABLE ml_models ADD COLUMN IF NOT EXISTS last_submission_at TIMESTAMPTZ;

-- Add inference job tracking to ml_rounds
ALTER TABLE ml_rounds ADD COLUMN IF NOT EXISTS sagemaker_job_name VARCHAR(120);
