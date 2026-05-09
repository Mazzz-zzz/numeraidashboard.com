# Numerai ML Training Pipeline

Multi-target LightGBM training framework for the [Numerai Classic](https://numer.ai/) tournament. Downloads tournament data, engineers era-level features, trains an ensemble of 6 target models, neutralizes predictions, and generates submission CSVs. Runs locally or on AWS SageMaker with live progress tracking via the OpenOptions dashboard.

## Quick Start

```bash
cd ml/

# Install dependencies
pip install -r requirements.txt

# Set credentials (only needed for upload, not training)
cp .env.example .env  # edit with your Numerai keys

# Run training locally
python3 -m training.trainer --feature-set small --output ./output

# Or launch on SageMaker (needs AWS credentials)
python3 sagemaker/launch_job.py --feature-set small
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Local CLI or SageMaker Container                           │
│                                                             │
│  1. Download ──► numerapi (anonymous, ~6GB parquet files)   │
│  2. Features ──► era stats, group aggregates                │
│  3. Train    ──► 6x LightGBM models (multi-target)         │
│  4. Ensemble ──► rank-average across target models          │
│  5. Neutralize ► reduce feature exposure (50% proportion)   │
│  6. Validate ──► per-era correlation, Sharpe, drawdown      │
│  7. Submit   ──► CSV with rank-normalized predictions       │
└─────────────────────────────────────────────────────────────┘
```

### SageMaker Integration

```
Dashboard ──POST /api/ml/train──► API Lambda ──boto3──► SageMaker Job
    ▲                                                       │
    │ polls every 5s                           writes to S3  │
    │                                          (progress +   │
API Lambda ◄── RDS ◄── Poller Lambda ◄── S3    epoch metrics)│
                        (every 60s)            ◄─────────────┘
```

The SageMaker job uses the `sagemaker-scikit-learn:1.2-1` framework image (Script Mode). The `bootstrap.py` entry point installs extra dependencies (lightgbm, numerapi) and delegates to `training.trainer.run_training()`.

Progress is reported via S3 JSON files (avoids putting SageMaker in VPC):
- `s3://openoptions-ml/jobs/{job_name}/progress.json` — current step + percent
- `s3://openoptions-ml/jobs/{job_name}/epochs/{N}.json` — per-epoch train/val loss
- `s3://openoptions-ml/jobs/{job_name}/metrics.json` — final validation metrics

A Poller Lambda (EventBridge, 1/min) reads these files and updates the `ml_runs` and `ml_epoch_metrics` tables in RDS, which the dashboard frontend polls via the API.

## Project Structure

```
ml/
├── bootstrap.py                 # SageMaker entry point (training + inference modes)
├── requirements.txt
├── config/
│   ├── settings.py              # MlSettings (Pydantic, env prefix ML_)
│   └── feature_groups.yaml      # Reference: Numerai v5 feature groups
├── data/
│   ├── download.py              # Classic v5.2 data download + caching (all 10 files)
│   ├── signals_download.py      # Signals v2.1 data download (all 9 files)
│   ├── features.py              # Feature engineering (era stats, groups, neutralization)
│   └── garch.py                 # Optional GARCH(1,1) volatility features
├── models/
│   ├── base.py                  # Abstract NumeraiModel (with sample_weight support)
│   ├── lgbm_model.py            # LightGBM with era-aware CV + sample weights
│   └── catboost_model.py        # CatBoost with era-aware CV + sample weights
├── training/
│   ├── trainer.py               # Classic pipeline (download → train → submit)
│   ├── signals_trainer.py       # Signals pipeline (neutralizer + sample weights)
│   ├── inference.py             # Inference-only: load model → predict → upload
│   ├── submission.py            # CSV generation, validation, Numerai upload
│   └── validate.py              # Metrics: correlation, Sharpe, Alpha, exposure, MMC
├── sagemaker/
│   └── launch_job.py            # Package code + launch SageMaker training job
└── tests/
    ├── conftest.py              # Fixtures: synthetic data, feature metadata
    ├── test_features.py         # Feature engineering tests
    ├── test_lgbm.py             # LightGBM + validation metric tests
    ├── test_signals.py          # Sample weights, Alpha metric, example benchmarks
    └── test_submission.py       # Submission generation/validation tests
```

## Configuration

All settings use the `ML_` env prefix via Pydantic. Key parameters:

| Setting | Default | Description |
|---|---|---|
| `ML_FEATURE_SET` | `medium` | Feature set: `small` (42), `medium` (705), `all` (2376) |
| `ML_DEFAULT_NUM_ROUNDS` | `10000` | LightGBM boosting rounds |
| `ML_DEFAULT_LEARNING_RATE` | `0.005` | Learning rate |
| `ML_DEFAULT_NUM_LEAVES` | `512` | Max leaves per tree |
| `ML_DEFAULT_MAX_DEPTH` | `8` | Max tree depth |
| `ML_DEFAULT_FEATURE_FRACTION` | `0.1` | Column subsampling ratio |
| `ML_DEFAULT_BAGGING_FRACTION` | `0.5` | Row subsampling ratio |
| `ML_EARLY_STOPPING_ROUNDS` | `200` | Early stopping patience |
| `ML_MULTI_TARGET_ENABLED` | `true` | Train on 6 target variants |
| `ML_NEUTRALIZATION_PROPORTION` | `0.5` | Feature neutralization strength |
| `ML_ERA_STATS_TOP_N` | `30` | Top N features by variance for era stats |
| `ML_MAX_TRAIN_ERAS` | `0` | Subsample eras (0 = all, needs ~16GB RAM) |
| `ML_NUMERAI_PUBLIC_ID` | | Numerai API key (for upload only) |
| `ML_NUMERAI_SECRET_KEY` | | Numerai API secret (for upload only) |

## Training Pipeline

### 1. Data Download

Uses `numerapi` (anonymous, no credentials needed) to download all v5.2 files:
- `train.parquet` (~2.3GB, ~2.7M rows)
- `validation.parquet` (~3.5GB, ~3.9M rows)
- `live.parquet` (current round)
- `features.json` (feature metadata + groups)
- `meta_model.parquet` (meta model predictions, era 1133+)
- `train/validation/live_benchmark_models.parquet` (Numerai's benchmark models)
- `validation/live_example_preds.parquet` (Numerai's baseline predictions)

Files are cached in `data_cache/` by round number.

### 2. Feature Engineering

- **Era statistics**: Per-era demeaning and z-score normalization on top 30 features by variance
- **Group aggregates**: Cross-feature mean/std/skew within Numerai feature groups (intelligence, charisma, strength, etc.)
- **Rolling features** (optional): Rolling mean/std over 5/10/20 era windows
- **GARCH** (optional): GARCH(1,1) conditional volatility on era-level return proxies

A `small` feature set (42 raw) becomes ~102 features after engineering.

### 3. Multi-Target Training

Trains separate LightGBM models on 6 targets:
- `target` (primary)
- `target_cyrusd_20`, `target_alpha_20`, `target_bravo_20`, `target_caroline_20`, `target_delta_20`

Each model uses era-based train/validation splits with early stopping (200-round patience). Training typically produces 1000-4000 boosting rounds per target.

### 4. Ensemble & Neutralization

- **Ensemble**: Rank-average across all 6 target models
- **Neutralization**: OLS residualization against top 50 features (50% proportion) to reduce feature exposure

### 5. Validation Metrics

- **Per-era correlation**: Spearman rank correlation between predictions and target per era
- **Mean correlation**: Average across eras (the primary Numerai metric)
- **Sharpe ratio**: Annualized (assumes ~52 eras/year)
- **Max drawdown**: Maximum cumulative correlation drawdown
- **Feature exposure**: Max per-era feature-prediction correlation (lower = better)

### 6. Submission

Generates `submission.csv` with rank-normalized predictions in [0, 1]. Can upload directly to Numerai via `--upload` flag (requires credentials).

## SageMaker Usage

### Launch from CLI

```bash
cd ml/
python3 sagemaker/launch_job.py --feature-set small
python3 sagemaker/launch_job.py --feature-set medium --instance ml.m5.2xlarge
```

This:
1. Packages `ml/` code into a tarball (excluding `data_cache/`, `output/`, `.env`)
2. Uploads to `s3://openoptions-ml/code/ml-source.tar.gz`
3. Creates a SageMaker training job using the sklearn framework image
4. Passes Numerai credentials from `.env` as container environment variables

### Launch from Dashboard

The ML dashboard (`/ml` tab) has a "Start Training" button that calls `POST /api/ml/train` with experiment name, feature set, model type, and instance type. This creates an `ml_experiments` + `ml_runs` row and launches the SageMaker job.

### Monitor

```bash
# SageMaker job status
aws sagemaker describe-training-job --training-job-name JOB_NAME \
  --region ap-southeast-2 --profile cybergarden-dev

# Live logs
aws logs tail /aws/sagemaker/TrainingJobs --log-stream-name-prefix JOB_NAME \
  --region ap-southeast-2 --profile cybergarden-dev --follow

# S3 progress
aws s3 cp s3://openoptions-ml/jobs/JOB_NAME/progress.json - --region ap-southeast-2
```

Or view the ML dashboard — it auto-polls and displays active runs with progress and loss charts.

### Instance Types

| Instance | vCPU | RAM | Cost/hr | Use Case |
|---|---|---|---|---|
| `ml.m5.xlarge` | 4 | 16 GB | ~$0.27 | Small/medium feature sets |
| `ml.m5.2xlarge` | 8 | 32 GB | ~$0.54 | All features or faster training |

### Cost

A typical training run (small feature set, ml.m5.xlarge) takes ~1.5-2 hours and costs ~$0.40-0.55.

## Dashboard Integration

The ML dashboard at `/ml` has 4 tabs:

| Tab | Description |
|---|---|
| **Overview** | Active runs with progress, Start Training button, recent run history |
| **Experiments** | Experiment list with run counts, best correlation/Sharpe per experiment |
| **Models** | Trained model browser with metrics comparison |
| **Rounds** | Numerai round results tracking |

### Database Tables

| Table | Purpose |
|---|---|
| `ml_experiments` | Named experiment groups (e.g., "baseline-v2") |
| `ml_runs` | Individual training runs with status, metrics, SageMaker job tracking |
| `ml_epoch_metrics` | Per-epoch train/val loss for loss charts |
| `ml_models` | Saved model artifacts with validation metrics |
| `ml_rounds` | Numerai round submission results |
| `ml_ensembles` | Ensemble configurations |

### API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/ml/overview` | Dashboard summary (active runs, best model, recent runs) |
| GET | `/api/ml/experiments` | List experiments with run counts |
| GET | `/api/ml/runs/{id}/metrics` | Epoch-level train/val loss data |
| POST | `/api/ml/train` | Start a SageMaker training job |
| POST | `/api/ml/runs/{id}/cancel` | Cancel a running job |
| POST | `/api/ml/models/{id}/submit` | Trigger manual Numerai submission |
| POST | `/api/ml/models/{id}/webhook` | Register webhook for auto-submission |
| DELETE | `/api/ml/models/{id}/webhook` | Deregister webhook |
| POST | `/api/ml/webhook/numerai` | Webhook callback from Numerai |

## Tests

```bash
cd ml/
python3 -m pytest tests/ -v
```

43 tests covering:
- Feature engineering (era stats, group aggregates, rolling, neutralization)
- LightGBM training and prediction (with and without sample weights)
- Validation metrics (correlation, Sharpe, drawdown, feature exposure)
- Signals-specific: sample weights, Signals Alpha metric, example benchmarks
- Submission generation and validation

## Environment Variables

Create a `.env` file in `ml/` (gitignored):

```bash
ML_NUMERAI_PUBLIC_ID=your_public_id
ML_NUMERAI_SECRET_KEY=your_secret_key
# Optional:
ML_NUMERAI_MODEL_ID=your_model_id
ML_FEATURE_SET=medium
ML_MAX_TRAIN_ERAS=0
```

## Documentation

Detailed documentation is in [`docs/`](docs/):

| Document | Description |
|---|---|
| [Architecture Overview](docs/overview.md) | System architecture, component responsibilities, design decisions |
| [Training Pipeline](docs/training-pipeline.md) | Step-by-step walkthrough of the full training pipeline |
| [Numerai Submission](docs/numerai-submission.md) | **How to submit to Numerai: manual, automated, webhook setup** |
| [Feature Engineering](docs/feature-engineering.md) | Era stats, group aggregates, rolling features, GARCH, neutralization |
| [Models](docs/models.md) | LightGBM configuration, era-based CV, multi-target strategy, ensemble |
| [SageMaker](docs/sagemaker.md) | Container lifecycle, launching, monitoring, IAM, troubleshooting |
| [Configuration](docs/configuration.md) | All settings with defaults, .env setup, hyperparameter overrides |
| [API Endpoints](docs/api-endpoints.md) | REST endpoints for training, experiments, runs, submissions |
| [Dashboard](docs/dashboard.md) | Frontend tabs, training modal, progress tracking, Svelte 5 architecture |
| [Development](docs/development.md) | Local setup, testing, debugging, deployment commands |

## Requirements

- Python 3.9+
- ~16GB RAM for local training with `small` feature set (use SageMaker for larger sets)
- AWS credentials for SageMaker (profile: `cybergarden-dev`, region: `ap-southeast-2`)
