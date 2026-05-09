# API Endpoints

All ML endpoints are under `/api/ml/` and defined in `backend/app/routers/ml.py`.

## Read Endpoints

### GET /api/ml/overview

Dashboard summary with active run count, best model, and recent runs.

**Response:**
```json
{
  "active_runs": 1,
  "best_model": {
    "id": 3,
    "name": "baseline-v2-target",
    "correlation": 0.0234,
    "sharpe": 1.12
  },
  "latest_round": {
    "round_number": 1222,
    "correlation": 0.0198
  },
  "ensemble_score": 0.0215,
  "recent_runs": [
    {
      "id": 2,
      "model_type": "lgbm",
      "status": "running",
      "correlation": null,
      "sharpe": null,
      "started_at": "2026-03-13T09:31:35Z",
      "finished_at": ""
    }
  ]
}
```

### GET /api/ml/experiments

List all experiments with run counts and best metrics.

**Query params:**
- `limit` (int, default 20)
- `offset` (int, default 0)

**Response:**
```json
{
  "data": [
    {
      "id": 1,
      "name": "numerai-classic-v1",
      "description": "First Numerai classic tournament training run",
      "status": "active",
      "created_at": "2026-03-13T09:30:00Z",
      "run_count": 2,
      "best_corr": 0.0234
    }
  ]
}
```

### GET /api/ml/experiments/{id}/runs

List runs for a specific experiment.

**Response:**
```json
{
  "data": [
    {
      "id": 2,
      "model_type": "lgbm",
      "status": "running",
      "hyperparams_json": "{\"feature_set\": \"small\"}",
      "correlation": null,
      "sharpe": null,
      "feature_exposure": null,
      "max_drawdown": null,
      "progress_pct": 45.0,
      "current_epoch": 800,
      "total_epochs": 10000,
      "started_at": "2026-03-13T09:31:35Z",
      "finished_at": null,
      "sagemaker_job_name": "oo-numerai-small-20260313-093025"
    }
  ]
}
```

### GET /api/ml/runs/{id}/metrics

Epoch-level train/val loss data for loss charts.

**Response:**
```json
{
  "data": [
    {"epoch": 0, "train_loss": 0.04981, "val_loss": 0.04979, "correlation": null, "sharpe": null},
    {"epoch": 100, "train_loss": 0.04974, "val_loss": 0.04978, "correlation": null, "sharpe": null},
    {"epoch": 200, "train_loss": 0.04967, "val_loss": 0.04976, "correlation": null, "sharpe": null}
  ]
}
```

### GET /api/ml/models

List trained models with validation metrics.

### GET /api/ml/rounds

List Numerai round results.

## Write Endpoints

### POST /api/ml/train

Start a new SageMaker training job.

**Request:**
```json
{
  "experiment_name": "baseline-v2",
  "description": "Testing small feature set with lower learning rate",
  "feature_set": "small",
  "model_type": "lgbm",
  "instance_type": "ml.m5.xlarge",
  "hyperparams": {
    "learning_rate": 0.01,
    "num_leaves": 256
  }
}
```

| Field | Required | Default | Values |
|---|---|---|---|
| `experiment_name` | Yes | — | Any string |
| `feature_set` | No | `medium` | `small`, `medium`, `all` |
| `model_type` | No | `lgbm` | `lgbm` |
| `instance_type` | No | `ml.m5.xlarge` | Any SageMaker instance |
| `description` | No | `null` | Any string |
| `hyperparams` | No | `null` | JSON object |

**Response:**
```json
{
  "run_id": 2,
  "experiment_id": 1,
  "sagemaker_job_name": "oo-baseline-v2-2-20260313-093025"
}
```

**Errors:**
- `400` — Invalid feature_set or model_type
- `500` — SageMaker not configured (missing role ARN)

**Logic:**
1. Find or create `ml_experiments` row by name
2. Insert `ml_runs` with status="pending"
3. Call `sagemaker_service.create_training_job()`
4. Update run with `sagemaker_job_name` and `sagemaker_job_arn`
5. Return IDs

### POST /api/ml/experiments

Create a new experiment (without starting a run).

**Request:**
```json
{
  "name": "feature-test-v3",
  "description": "Testing all features with GARCH enabled"
}
```

**Response:** `ExperimentOut` object.

**Errors:**
- `409` — Experiment with that name already exists

### POST /api/ml/runs/{run_id}/cancel

Cancel a running training job.

**Response:**
```json
{
  "run_id": 2,
  "status": "failed"
}
```

Sets status to `failed` with `error_message: "Cancelled by user"`. If the run has a `sagemaker_job_name`, calls `sagemaker.stop_training_job()`.

## Numerai Submission Endpoints

### POST /api/ml/models/{id}/submit

Manually trigger a Numerai submission. Starts a SageMaker inference job that downloads the model artifact, predicts on live data, and uploads to Numerai.

**Prerequisites:** Model must have `s3_artifact_path` and `numerai_model_id` set.

**Response:**
```json
{
  "job_name": "oo-infer-3-20260318-123456",
  "job_arn": "arn:aws:sagemaker:...",
  "model_id": 3,
  "round_id": 7,
  "status": "submitting"
}
```

**Errors:**
- `400` — Model has no S3 artifact path or no Numerai model ID
- `503` — SageMaker or Numerai credentials not configured

### POST /api/ml/models/{id}/webhook

Register a webhook URL with Numerai for automated weekly submissions.

**Response:**
```json
{
  "model_id": 3,
  "webhook_url": "https://API_URL/api/ml/webhook/numerai?model_id=3",
  "webhook_active": true
}
```

### DELETE /api/ml/models/{id}/webhook

Deregister the webhook. Stops automatic submissions.

**Response:**
```json
{
  "model_id": 3,
  "webhook_active": false
}
```

### POST /api/ml/webhook/numerai

Webhook callback endpoint called by Numerai when a new round opens. **Exempt from IP whitelist.**

**Query params:**
- `model_id` (int, optional) — if omitted, uses the first active prod model with `webhook_active=true`

**Response:**
```json
{
  "status": "triggered",
  "job_name": "oo-infer-3-20260318-180030",
  "model_id": 3
}
```

### PATCH /api/ml/models/{id}

Update model stage and/or Numerai configuration.

**Request:**
```json
{
  "stage": "prod",
  "numerai_model_id": "0b343eac-7410-4251-aea2-298e23ea4050"
}
```

Both fields are optional.

## Internal Endpoints (Poller)

These endpoints are called by the Poller Lambda and require the `X-Poller-Key` header matching the `ML_POLLER_API_KEY` environment variable.

### PATCH /api/ml/runs/{run_id}

Update run progress, status, and metrics.

**Headers:**
- `X-Poller-Key: {ML_POLLER_API_KEY}`

**Request:**
```json
{
  "status": "running",
  "progress_pct": 45.0,
  "current_epoch": 800,
  "total_epochs": 10000,
  "correlation": null,
  "sharpe": null,
  "started_at": "2026-03-13T09:31:35Z"
}
```

All fields are optional — only provided fields are updated.

### POST /api/ml/runs/{run_id}/metrics

Batch-insert epoch metrics.

**Headers:**
- `X-Poller-Key: {ML_POLLER_API_KEY}`

**Request:**
```json
{
  "metrics": [
    {"epoch": 100, "train_loss": 0.04974, "val_loss": 0.04978},
    {"epoch": 200, "train_loss": 0.04967, "val_loss": 0.04976},
    {"epoch": 300, "train_loss": 0.04961, "val_loss": 0.04975}
  ]
}
```

**Response:**
```json
{
  "inserted": 3
}
```

Duplicate epochs (same run_id + epoch) are silently skipped.

## Authentication

- **Read endpoints**: No authentication (public, served behind IP whitelist)
- **Write endpoints** (`POST /ml/train`, `POST /ml/runs/{id}/cancel`): No additional auth beyond IP whitelist
- **Internal endpoints** (`PATCH /ml/runs/{id}`, `POST /ml/runs/{id}/metrics`): Require `X-Poller-Key` header

The IP whitelist (`ALLOWED_IPS_CSV`) is enforced at the FastAPI middleware level for all endpoints.
