-- SageMaker integration columns for ml_runs
ALTER TABLE ml_runs ADD COLUMN sagemaker_job_name VARCHAR(120);
ALTER TABLE ml_runs ADD COLUMN sagemaker_job_arn VARCHAR(256);
ALTER TABLE ml_runs ADD COLUMN error_message VARCHAR(2000);
ALTER TABLE ml_runs ADD COLUMN instance_type VARCHAR(30);
ALTER TABLE ml_runs ADD COLUMN cost_usd NUMERIC(10, 4);
CREATE INDEX ix_ml_runs_sagemaker_job ON ml_runs(sagemaker_job_name);
