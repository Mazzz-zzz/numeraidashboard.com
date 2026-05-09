# Numerai Submission & Production Deployment

How to submit predictions to Numerai tournaments, from manual one-off submissions to fully automated weekly delivery.

## Prerequisites

1. **Numerai account** at [numer.ai](https://numer.ai)
2. **API keys** — go to Account > Settings > API Keys. You need:
   - `NUMERAI_PUBLIC_ID`
   - `NUMERAI_SECRET_KEY`
3. **Model slot** — create a model on the Numerai dashboard. Copy the model UUID (e.g. `0b343eac-7410-4251-aea2-298e23ea4050`)
4. **A trained model** with `inference_config.json` in its artifact (any model trained after 2026-03-18)

## Architecture

```
                                    ┌─────────────────────┐
  Numerai round opens ──webhook──>  │ API Lambda           │
       (weekly)                     │ POST /ml/webhook/    │
                                    │       numerai        │
           OR                       └────────┬────────────┘
                                             │
  Manual click ──────────────────>  POST /ml/models/{id}/submit
       "Submit Now"                          │
                                    ┌────────▼────────────┐
                                    │ SageMaker Inference  │
                                    │ Job (ml.m5.large)    │
                                    │                      │
                                    │  1. Download model   │
                                    │     from S3          │
                                    │  2. Download live.pq │
                                    │     from Numerai     │
                                    │  3. Feature eng      │
                                    │  4. Multi-target     │
                                    │     ensemble predict │
                                    │  5. Neutralize       │
                                    │  6. Upload to        │
                                    │     Numerai via API  │
                                    └────────┬────────────┘
                                             │
                                    Poller updates:
                                    - ml_rounds table
                                    - ml_models.last_submission_*
```

## Step-by-Step: First Submission

### 1. Train a model

From the **Signals** page > **Deploy** tab, configure and start a training run. Or use the CLI:

```bash
cd ml/
python3 -m training.trainer --feature-set small --output ./output
```

For SageMaker:
```bash
python3 sagemaker/launch_job.py --feature-set small
```

Wait for training to complete. The poller auto-registers the model in the **Models** tab with its S3 artifact path.

### 2. Promote to production

In the **Models** tab:

1. Click **Staging** to promote from dev
2. Click **Prod** to promote from staging to production

### 3. Configure Numerai model ID

Still in the **Models** tab:

1. Click **Set ID** next to the prod model
2. Paste your Numerai model UUID: `0b343eac-7410-4251-aea2-298e23ea4050`
3. Press Enter or click **Save**

### 4. Test with manual submission

Click **Submit Now**. This starts a lightweight SageMaker inference job (~5 min) that:

1. Downloads your trained model artifact from S3
2. Downloads the current round's live data from Numerai
3. Applies the same feature engineering as training
4. Predicts with all target models and ensembles
5. Neutralizes predictions
6. Uploads to Numerai via `numerapi`

You'll see the submission appear in the **Rounds** tab.

### 5. Enable automatic weekly submissions

Click **Auto OFF** to toggle it to **Auto ON**. This registers a webhook URL with Numerai:

```
https://7ia5onp99c.execute-api.ap-southeast-2.amazonaws.com/prod/api/ml/webhook/numerai?model_id={id}
```

Every time a new Numerai round opens (weekly on Saturday), Numerai POSTs to this URL, which triggers the same inference pipeline automatically.

To disable, click **Auto ON** to toggle back. This deregisters the webhook.

## How Inference Works

The inference pipeline (`ml/training/inference.py`) replays the same feature engineering as training:

1. **Load `inference_config.json`** from the model artifact — this stores the feature set, neutralization settings, target list, and feature engineering config used during training
2. **Download live data** via `numerapi` (anonymous, no credentials needed)
3. **Feature engineering** — era stats, group aggregates (same columns as training)
4. **Load each target model** from `model_{target}/model.txt`
5. **Predict** with each model
6. **Rank-average ensemble** across targets
7. **Neutralize** against top features
8. **Upload** via `numerapi` with credentials

The `inference_config.json` file ensures exact reproducibility — whatever features and settings were used in training are replayed for inference.

## Classic vs Signals

Both tournaments use the same inference pipeline. The difference is in the data:

| Aspect | Classic (v5.2) | Signals (v2.1) |
|--------|----------------|----------------|
| Data download | `NumerAPI()` | `SignalsAPI()` |
| Features | From `features.json` sets | Discovered from parquet columns |
| Neutralizer | Feature-based (top N) | Official neutralizer matrix |
| Sample weights | Not applicable | `train_sample_weights.parquet` |
| Upload API | `NumerAPI.upload_predictions()` | `SignalsAPI.upload_predictions()` |

## Data Files Used

### Classic v5.2

| File | Purpose | Used In |
|------|---------|---------|
| `train.parquet` | Training data (~2.7M rows) | Training |
| `validation.parquet` | Validation data (~3.9M rows) | Training |
| `validation_example_preds.parquet` | Numerai's baseline predictions | Benchmarking (vs Example metric) |
| `live.parquet` | Current round predictions | Inference |
| `live_example_preds.parquet` | Baseline live predictions | Downloaded for reference |
| `features.json` | Feature sets + metadata | Feature selection |
| `train_benchmark_models.parquet` | Benchmark model train preds | Downloaded for diagnostics |
| `validation_benchmark_models.parquet` | Benchmark model val preds | Benchmark comparison metric |
| `live_benchmark_models.parquet` | Benchmark model live preds | Downloaded for reference |
| `meta_model.parquet` | Meta model predictions (era 1133+) | MMC (Meta-Model Contribution) |

### Signals v2.1

| File | Purpose | Used In |
|------|---------|---------|
| `train.parquet` | Training data | Training |
| `train_neutralizer.parquet` | Neutralization matrix | Neutralization-aware training |
| `train_sample_weights.parquet` | Per-row weights | **Passed to LightGBM as sample weights** |
| `validation.parquet` | Validation data | Training |
| `validation_neutralizer.parquet` | Val neutralization matrix | Signals Alpha metric |
| `validation_sample_weights.parquet` | Val weights | Signals Alpha metric |
| `validation_example_preds.parquet` | Baseline predictions | Benchmarking (vs Example metric) |
| `live.parquet` | Current round data | Inference |
| `live_example_preds.parquet` | Baseline live predictions | Downloaded for reference |

## Validation Metrics

### Standard Metrics (Both Tournaments)

| Metric | What It Measures | Good Value |
|--------|-----------------|------------|
| `correlation` | Mean per-era Spearman correlation | > 0.02 |
| `sharpe` | Stability of per-era correlations | > 1.0 |
| `max_drawdown` | Worst cumulative correlation loss | > -0.05 |
| `feature_exposure` | Max feature-prediction correlation | < 0.1 |
| `mmc` | Contribution beyond meta model | > 0.005 |

### Signals-Specific Metrics

| Metric | What It Measures | Why It Matters |
|--------|-----------------|----------------|
| `signals_alpha` | Correlation after neutralization + sample weighting | **This is what Numerai actually scores you on** |
| `vs_example.delta` | Your correlation minus Numerai's baseline | Positive = beating the example model |

The `signals_alpha` metric replicates Numerai's scoring pipeline: neutralize your predictions using the official neutralizer matrix, apply sample weights, then compute per-era correlation. If `correlation` is high but `signals_alpha` is low, your model isn't surviving neutralization.

## API Endpoints

### Manual Submission

```
POST /api/ml/models/{id}/submit
```

Starts a SageMaker inference job. Requires the model to have `s3_artifact_path` and `numerai_model_id` set.

**Response:**
```json
{
  "job_name": "oo-infer-3-20260318-123456",
  "model_id": 3,
  "round_id": 7,
  "status": "submitting"
}
```

### Register Webhook

```
POST /api/ml/models/{id}/webhook
```

Registers the webhook URL with Numerai via GraphQL API. The model must have `numerai_model_id` set.

**Response:**
```json
{
  "model_id": 3,
  "webhook_url": "https://7ia5onp99c.execute-api.ap-southeast-2.amazonaws.com/prod/api/ml/webhook/numerai?model_id=3",
  "webhook_active": true
}
```

### Deregister Webhook

```
DELETE /api/ml/models/{id}/webhook
```

Removes the webhook from Numerai. Submissions stop being automatic.

### Numerai Webhook Callback

```
POST /api/ml/webhook/numerai?model_id={id}
```

Called by Numerai when a new round opens. Exempt from IP whitelist. Finds the specified model (or first active prod model) and starts inference.

## Troubleshooting

### "Model has no S3 artifact path"

The model was registered before the artifact path tracking was added (pre-2026-03-18). Retrain the model — new training runs automatically save the artifact path.

### "Model has no Numerai model ID configured"

Click **Set ID** in the Models tab and paste your Numerai model UUID.

### Inference job fails

Check SageMaker logs:
```bash
aws logs tail /aws/sagemaker/TrainingJobs \
  --log-stream-name-prefix oo-infer- \
  --region ap-southeast-2 --profile cybergarden-dev --follow
```

Common causes:
- **Missing `inference_config.json`** — model was trained before inference support. Retrain it.
- **Numerai credentials not set** — check `NUMERAI_PUBLIC_ID` and `NUMERAI_SECRET_KEY` in SAM template
- **Model artifact corrupted** — check S3 path exists: `aws s3 ls {s3_artifact_path}`

### Webhook not firing

1. Verify webhook is registered: check **Auto ON** badge in Models tab
2. Numerai webhooks only fire when a new round opens (weekly on Saturday ~18:00 UTC)
3. Test manually with **Submit Now** to verify the pipeline works
4. Check API logs for webhook POSTs:
   ```bash
   aws logs tail /aws/lambda/openoptions-ApiFunction-XXX \
     --region ap-southeast-2 --profile cybergarden-dev \
     --filter-pattern "webhook"
   ```

### Submission shows in Rounds tab but not on Numerai

The inference job uploads directly to Numerai via `numerapi`. If the job completed but Numerai doesn't show the submission:
1. Check the S3 submission result: `aws s3 cp s3://openoptions-ml/jobs/oo-infer-{id}-{ts}/submission.json -`
2. Verify the `submission_id` in the result
3. Check the Numerai dashboard for your model slot
