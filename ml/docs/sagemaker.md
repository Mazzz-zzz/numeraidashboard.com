# SageMaker Integration

## How It Works

SageMaker training uses the **sklearn framework image** in Script Mode. This avoids maintaining a custom Docker image — the framework provides Python, pandas, numpy, scikit-learn, and a training harness. Our `bootstrap.py` entry point installs the few extra packages we need (lightgbm, numerapi) and then calls the same `run_training()` function used locally.

### Container Lifecycle

```
1. SageMaker provisions ml.m5.xlarge instance
2. Pulls sklearn framework image from ECR
3. Downloads source tarball from S3
4. Extracts to /opt/ml/code/
5. Auto-discovers requirements.txt → pip install
6. Runs: python bootstrap.py --feature_set small --job_name ... --s3_bucket ...
7. bootstrap.py:
   a. pip install lightgbm numerapi pyarrow pyyaml pydantic pydantic-settings
   b. Parses hyperparameters from /opt/ml/input/config/hyperparameters.json
   c. Calls run_training() with progress + epoch callbacks
   d. Callbacks write JSON to S3
   e. Final metrics written to S3
8. SageMaker archives /opt/ml/model/ to S3 output path
9. Instance terminated
```

### Key Paths Inside Container

| Path | Purpose |
|---|---|
| `/opt/ml/code/` | Extracted source code (our ml/ directory contents) |
| `/opt/ml/input/config/hyperparameters.json` | Training config from SageMaker |
| `/opt/ml/model/` | Write model artifacts here (archived to S3) |
| `/opt/ml/output/` | Write failure details here |

### Image Details

```
Image: 783357654285.dkr.ecr.ap-southeast-2.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3
Python: 3.9 (miniconda)
Pre-installed: numpy 1.24, pandas 1.1, scikit-learn 1.2, scipy 1.8
Our additions: lightgbm, numerapi, pyarrow, pyyaml, pydantic, pydantic-settings
```

Note: Our bootstrap upgrades numpy and pandas to recent versions, which generates pip dependency warnings from `sagemaker-sklearn-container`. These are harmless — the sklearn container library is only used for the training harness, not for our model code.

## Launching Jobs

### From CLI

```bash
cd ml/

# Small feature set (42 features, ~1.5h)
python3 sagemaker/launch_job.py --feature-set small

# Medium feature set (705 features, ~3h)
python3 sagemaker/launch_job.py --feature-set medium --instance ml.m5.2xlarge

# With Numerai upload
python3 sagemaker/launch_job.py --feature-set small --upload
```

The launcher (`sagemaker/launch_job.py`):
1. Packages `ml/` into `ml-source.tar.gz` (excludes `data_cache/`, `output/`, `__pycache__/`, `.env`)
2. Uploads tarball to `s3://openoptions-ml/code/ml-source.tar.gz`
3. Creates SageMaker training job via boto3
4. Prints monitoring commands

### From Dashboard

POST to `https://API_URL/api/ml/train`:
```json
{
  "experiment_name": "baseline-v2",
  "feature_set": "small",
  "model_type": "lgbm",
  "instance_type": "ml.m5.xlarge",
  "description": "Testing small feature set",
  "hyperparams": {"num_leaves": 256}
}
```

The API creates `ml_experiments` + `ml_runs` rows, then launches the SageMaker job.

## Monitoring

### CloudWatch Logs

```bash
# Tail live logs
aws logs tail /aws/sagemaker/TrainingJobs \
  --log-stream-name-prefix JOB_NAME \
  --region ap-southeast-2 --profile cybergarden-dev --follow

# Search for errors
aws logs tail /aws/sagemaker/TrainingJobs \
  --log-stream-name-prefix JOB_NAME \
  --region ap-southeast-2 --profile cybergarden-dev \
  --filter-pattern "ERROR"
```

### SageMaker API

```bash
# Job status
aws sagemaker describe-training-job \
  --training-job-name JOB_NAME \
  --region ap-southeast-2 --profile cybergarden-dev \
  --query '{Status: TrainingJobStatus, SecondaryStatus: SecondaryStatus, FailureReason: FailureReason}'
```

### S3 Progress Files

```bash
# Current step and progress
aws s3 cp s3://openoptions-ml/jobs/JOB_NAME/progress.json - --region ap-southeast-2

# Latest epoch metrics
aws s3 ls s3://openoptions-ml/jobs/JOB_NAME/epochs/ --region ap-southeast-2

# Read a specific epoch
aws s3 cp s3://openoptions-ml/jobs/JOB_NAME/epochs/500.json - --region ap-southeast-2

# Final metrics (after completion)
aws s3 cp s3://openoptions-ml/jobs/JOB_NAME/metrics.json - --region ap-southeast-2
```

### Dashboard

The ML tab at `/ml` shows:
- Active runs with pulse animation
- Progress percentage and current step
- Loss charts (train/val L2 loss over epochs)
- Final metrics when complete

The dashboard polls `GET /api/ml/overview` every 5 seconds when there are active runs.

## Progress Reporting

### S3 Files Written by Container

| File | Written When | Contents |
|---|---|---|
| `progress.json` | Each pipeline step | `{"step": "training", "progress_pct": 45, "target": "target_alpha_20"}` |
| `epochs/{N}.json` | Every 100 LightGBM rounds | `{"epoch": 100, "train_loss": 0.0497, "val_loss": 0.0498}` |
| `metrics.json` | Training completion | Full validation metrics (ensemble + per-target) |

### Poller Lambda

The `PollerFunction` Lambda runs every 60 seconds via EventBridge:

1. Queries RDS for `ml_runs` where `status IN ('pending', 'running') AND sagemaker_job_name IS NOT NULL`
2. For each active run:
   - Calls `sagemaker.describe_training_job()` for status
   - Reads `progress.json` from S3 for step/progress_pct
   - Lists new epoch files in `epochs/` directory
   - Inserts new epochs into `ml_epoch_metrics` table
   - Updates `ml_runs` with status, progress, epoch count
3. On completion: reads `metrics.json` and updates correlation, sharpe, feature_exposure, max_drawdown
4. On failure: records error message from SageMaker's FailureReason

### Status Mapping

| SageMaker Status | ml_runs Status |
|---|---|
| `InProgress` | `running` |
| `Completed` | `completed` |
| `Failed` | `failed` |
| `Stopped` | `failed` |

## IAM & Security

### SageMaker Execution Role

**Role**: `openoptions-sagemaker-execution`
**Trust**: `sagemaker.amazonaws.com`

Permissions:
- S3: Read/write to `openoptions-ml` bucket
- CloudWatch Logs: Create/write to `/aws/sagemaker/*`
- ECR: Pull container images

### API Lambda

Additional permissions for SageMaker:
- `sagemaker:CreateTrainingJob` — scoped to `arn:aws:sagemaker:ap-southeast-2:ACCOUNT:training-job/oo-*`
- `sagemaker:DescribeTrainingJob` — same scope
- `sagemaker:StopTrainingJob` — same scope
- `iam:PassRole` — pass the SageMaker execution role (condition: `sagemaker.amazonaws.com`)
- `s3:GetObject`, `s3:PutObject` — on `openoptions-ml/*`

### Poller Lambda

- `sagemaker:DescribeTrainingJob` — scoped to `oo-*` jobs
- `s3:GetObject`, `s3:ListBucket` — on `openoptions-ml`
- RDS access via DB credentials in environment variables

### Numerai Credentials

Passed as environment variables on the SageMaker container:
- `ML_NUMERAI_PUBLIC_ID`
- `ML_NUMERAI_SECRET_KEY`

These are loaded from `ml/.env` by `launch_job.py` and set via the `Environment` parameter on `create_training_job()`. They are NOT stored in S3 or the source tarball.

## Instance Types

| Instance | vCPU | RAM | Cost/hr | Recommended For |
|---|---|---|---|---|
| `ml.m5.xlarge` | 4 | 16 GB | ~$0.27 | `small` feature set |
| `ml.m5.2xlarge` | 8 | 32 GB | ~$0.54 | `medium` feature set |
| `ml.m5.4xlarge` | 16 | 64 GB | ~$1.08 | `all` features |
| `ml.c5.2xlarge` | 8 | 16 GB | ~$0.48 | CPU-optimized training |

### Cost Estimates

| Feature Set | Instance | Duration | Cost |
|---|---|---|---|
| small (42 features) | ml.m5.xlarge | ~1.5-2h | ~$0.40-0.55 |
| medium (705 features) | ml.m5.2xlarge | ~3-4h | ~$1.60-2.15 |
| all (2376 features) | ml.m5.4xlarge | ~6-8h | ~$6.50-8.60 |

## Troubleshooting

### Job Fails Immediately

**Symptom**: Status goes to `Failed` within 2 minutes.

**Common causes**:
- `bootstrap.py` not found → check that it's in the root of `ml/` (not in `sagemaker/`)
- Import error → pip install failed, check CloudWatch logs for errors
- numpy/pandas ABI mismatch → bootstrap.py should upgrade both together before importing

### Job Fails During Training

**Symptom**: Training starts but fails mid-way.

**Common causes**:
- Out of memory → use a larger instance type
- Feature column mismatch between train and validation → ensure `era_stat_features` from training is passed to validation
- NaN in targets → the pipeline skips targets with >50% NaN, but unexpected NaN patterns can cause issues

### Poller Not Updating

**Symptom**: Dashboard shows stale progress.

**Check**:
1. Poller Lambda logs: `aws logs tail /aws/lambda/openoptions-PollerFunction-XXX --region ap-southeast-2 --profile cybergarden-dev --since 5m`
2. Verify the `ml_runs` row exists with a `sagemaker_job_name`
3. Check that the run status is `pending` or `running` (poller ignores completed/failed)
4. Verify S3 progress files exist: `aws s3 ls s3://openoptions-ml/jobs/JOB_NAME/`

### Job Succeeds But No Metrics in Dashboard

**Symptom**: SageMaker shows `Completed` but dashboard has null metrics.

**Check**:
1. Verify `metrics.json` exists in S3: `aws s3 cp s3://openoptions-ml/jobs/JOB_NAME/metrics.json -`
2. Check poller processed the completion (look for "Completed" status in poller logs)
3. The poller extracts `ensemble.mean_corr`, `ensemble.sharpe`, etc. — verify the JSON structure matches
