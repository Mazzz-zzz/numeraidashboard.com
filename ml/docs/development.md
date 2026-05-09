# Development Guide

## Local Setup

### Prerequisites

- Python 3.9+
- ~16GB RAM for training with `small` feature set (use SageMaker for larger sets or limited-RAM machines)
- AWS CLI configured with `cybergarden-dev` profile (for SageMaker)

### Installation

```bash
cd ml/
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Environment

Create `ml/.env`:
```bash
# Only needed for uploading submissions to Numerai
ML_NUMERAI_PUBLIC_ID=your_public_id
ML_NUMERAI_SECRET_KEY=your_secret_key

# Optional overrides
ML_FEATURE_SET=small
ML_MAX_TRAIN_ERAS=100  # Use fewer eras for faster iteration
```

### Running Locally

```bash
# Full training (small set, ~1.5h locally if enough RAM)
python3 -m training.trainer --feature-set small --output ./output

# Skip download (use cached data)
python3 -m training.trainer --feature-set small --output ./output --skip-download

# Train and upload to Numerai
python3 -m training.trainer --feature-set small --output ./output --upload
```

### Running on SageMaker

```bash
# Launch job
python3 sagemaker/launch_job.py --feature-set small

# Monitor
aws logs tail /aws/sagemaker/TrainingJobs --log-stream-name-prefix JOB_NAME \
  --region ap-southeast-2 --profile cybergarden-dev --follow
```

## Testing

```bash
cd ml/
python3 -m pytest tests/ -v
```

### Test Structure

| File | Tests | Coverage |
|---|---|---|
| `test_features.py` | 10 | Era stats, group aggregates, rolling features, neutralization |
| `test_lgbm.py` | 12 | LightGBM fit/predict, validation metrics (correlation, Sharpe, drawdown, exposure) |
| `test_submission.py` | 5 | Submission CSV generation and validation |

### Test Fixtures (`conftest.py`)

All tests use synthetic data — no Numerai download needed:

```python
@pytest.fixture
def synthetic_data():
    # 50 eras x 100 rows each = 5000 rows
    # 10 features (feature_0 ... feature_9), values 0-4
    # Targets: target, target_cyrusd_20, target_alpha_20
    # Index: "id_0001" ... "id_5000"
```

### Running Specific Tests

```bash
# Just feature engineering tests
python3 -m pytest tests/test_features.py -v

# Just LightGBM tests
python3 -m pytest tests/test_lgbm.py -v

# Single test
python3 -m pytest tests/test_lgbm.py::TestLightGBMModel::test_fit_and_predict -v
```

## Backend Tests (ML Endpoints)

```bash
cd backend/
python3 -m pytest tests/test_ml.py -v   # 19 tests
```

These test the API endpoints (experiments, models, rounds, overview) using SQLite in-memory and mock data.

## Project Conventions

### Code Style

- `from __future__ import annotations` in all files (Python 3.9 compat)
- Type hints on all function signatures
- Docstrings on public functions
- No bare `except` — always catch specific exceptions

### Module Imports

```python
# Standard library
import json
import sys
from pathlib import Path

# Third party
import numpy as np
import pandas as pd

# Local
from config.settings import get_ml_settings
from data.features import add_era_stats
```

### Error Handling

- Training failures should produce clear error messages
- Progress callbacks should never crash the training pipeline — wrap in try/except
- Missing optional dependencies (arch, numerapi for upload) should degrade gracefully

### Data Management

- Downloaded data is cached in `data_cache/` by round number
- Output artifacts go to `output/` (or custom `--output` path)
- Both directories are gitignored
- Never commit `.env` files (contains credentials)

## Deployment

### Deploying Backend Changes

If you modify `backend/app/routers/ml.py`, `backend/app/services/sagemaker_service.py`, or `backend/sagemaker_poller/handler.py`:

```bash
cd backend/
sam build --build-in-source
sam deploy --stack-name openoptions --resolve-s3 \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --no-confirm-changeset --region ap-southeast-2 --profile cybergarden-dev \
  --parameter-overrides \
    DBHost=openoptions-db.cl6a6mm8a6wq.ap-southeast-2.rds.amazonaws.com \
    DBPassword=... \
    SageMakerRoleArn=arn:aws:iam::017915195458:role/openoptions-sagemaker-execution \
    MlS3Bucket=openoptions-ml \
    MlPollerApiKey=...
    # ... (see MEMORY.md for full parameter list)
```

### Deploying ML Code Changes

ML code runs inside the SageMaker container — it's packaged and uploaded at job launch time. No separate deployment step is needed. Just modify the code and launch a new job:

```bash
cd ml/
python3 sagemaker/launch_job.py --feature-set small
```

The launcher tarballs the current `ml/` directory and uploads to S3 every time.

### Database Migrations

SQL migration files are in `backend/migrations/`. Run against RDS:

```bash
psql "host=openoptions-db.cl6a6mm8a6wq.ap-southeast-2.rds.amazonaws.com \
  dbname=openoptions user=postgres password=..." < backend/migrations/004_sagemaker_columns.sql
```

### Frontend Changes

The frontend auto-deploys from GitHub on push to `main` via Amplify.

## Debugging

### Inspecting SageMaker Container

The container environment:
- Python: `/miniconda3/bin/python` (Python 3.9)
- Source code: `/opt/ml/code/`
- Hyperparameters: `/opt/ml/input/config/hyperparameters.json`
- Model output: `/opt/ml/model/`

### Common Issues

**Import errors in SageMaker**: Usually a numpy/pandas version mismatch. The bootstrap.py upgrades both before importing training code.

**Column mismatch**: If era stats features differ between train and validation, ensure `era_stat_features` is passed from training to validation.

**OOM on local machine**: Use `ML_MAX_TRAIN_ERAS=200` to subsample, or use SageMaker.

**Poller not updating**: Check that the `ml_runs` row has `status IN ('pending', 'running')` and a non-null `sagemaker_job_name`.

### Useful Commands

```bash
# Check SageMaker job status
aws sagemaker describe-training-job --training-job-name JOB_NAME \
  --region ap-southeast-2 --profile cybergarden-dev \
  --query '{Status: TrainingJobStatus, FailureReason: FailureReason}'

# Read S3 progress
aws s3 cp s3://openoptions-ml/jobs/JOB_NAME/progress.json - --region ap-southeast-2

# Check poller logs
aws logs tail /aws/lambda/openoptions-PollerFunction-XXX \
  --region ap-southeast-2 --profile cybergarden-dev --since 5m

# Query RDS for run status
psql "host=openoptions-db... dbname=openoptions user=postgres password=..." \
  -c "SELECT id, status, progress_pct, current_epoch, sagemaker_job_name FROM ml_runs"

# Check epoch metrics in DB
psql "..." -c "SELECT epoch, train_loss, val_loss FROM ml_epoch_metrics WHERE run_id=2 ORDER BY epoch"
```
