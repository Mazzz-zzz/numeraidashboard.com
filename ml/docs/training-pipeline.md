# Training Pipeline

Step-by-step walkthrough of what happens when you run training, either locally or on SageMaker.

## Entry Points

| Mode | Command | Entry Point |
|---|---|---|
| Local CLI | `python3 -m training.trainer --feature-set small` | `training/trainer.py:main()` |
| SageMaker | `python3 sagemaker/launch_job.py --feature-set small` | `bootstrap.py` → `training/trainer.py:run_training()` |
| Dashboard | Click "Start Training" on `/ml` tab | API → `sagemaker_service.py` → SageMaker → `bootstrap.py` |

All paths converge on `run_training()` in `training/trainer.py`.

## Pipeline Steps

### Step 1: Download Data

```python
data_dir = download_current_round()
```

Downloads from Numerai's public API via `numerapi` (no credentials needed):

| File | Size | Rows | Description |
|---|---|---|---|
| `train.parquet` | ~2.3GB | ~2.7M | Historical training data (1000+ eras) |
| `validation.parquet` | ~3.5GB | ~3.9M | Out-of-sample validation data |
| `live.parquet` | ~5MB | ~5K | Current round live data |
| `features.json` | ~1MB | — | Feature metadata (names, groups, sets) |

Files are cached in `data_cache/` by round number (e.g., `train_r1222.parquet`). If the file already exists, the download is skipped.

### Step 2: Load Feature Metadata

```python
metadata = load_feature_metadata(data_dir)
feature_cols = get_feature_set(metadata, feature_set_name)
```

Numerai provides named feature sets in `features.json`:

| Set | Features | Description |
|---|---|---|
| `small` | 42 | Minimal, fast to train |
| `medium` | 705 | Good balance of signal and speed |
| `all` | 2376 | Every available feature |

### Step 3: Load Data

```python
load_cols = _build_columns_to_load(feature_cols, target_cols, era_col)
train_df = load_train_data(data_dir, columns=load_cols)
val_df = load_validation_data(data_dir, columns=load_cols)
```

Only loads the columns we need (feature set + targets + era). This is critical for RAM — loading all 2376 columns would use ~40GB.

**Target columns** (when `multi_target_enabled=True`):
- `target` — primary target
- `target_cyrusd_20` — Cyrus USD 20-day
- `target_alpha_20` — Alpha 20-day
- `target_bravo_20` — Bravo 20-day
- `target_caroline_20` — Caroline 20-day
- `target_delta_20` — Delta 20-day

### Step 4: Feature Engineering

```python
all_features, era_stat_features = _apply_feature_engineering(
    train_df, feature_cols, feature_groups, settings
)
_apply_feature_engineering(
    val_df, feature_cols, feature_groups, settings,
    era_stat_features=era_stat_features,  # use same features as training
)
```

#### Era Statistics (`enable_era_stats=True`)

For the top N features by variance (default N=30):
- **Demeaning**: `feature_X_era_demean = feature_X - era_mean(feature_X)`
- **Z-score**: `feature_X_era_zscore = (feature_X - era_mean) / era_std`

This captures within-era relative positioning. The same top-N features selected from training data are used for validation/live data to ensure column consistency.

#### Group Aggregates (`enable_group_aggregates=True`)

Numerai features belong to groups (intelligence, charisma, strength, etc.):
- `group_{name}_mean` — mean across features in group
- `group_{name}_std` — standard deviation across features
- `group_{name}_skew` — skewness across features

#### Rolling Features (`enable_rolling_features=False`, disabled by default)

Rolling statistics over era windows (5, 10, 20 eras):
- `feature_X_roll5_mean`, `feature_X_roll5_std`, etc.

#### GARCH (`enable_garch=False`, disabled by default)

GARCH(1,1) conditional volatility on era-level return proxies. Requires the `arch` library.

#### Feature Count

| Feature Set | Raw | After Engineering |
|---|---|---|
| small (42) | 42 | ~102 |
| medium (705) | 705 | ~765 |
| all (2376) | 2376 | ~2436 |

### Step 5: Multi-Target Training

```python
for target in available_targets:
    model = LightGBMModel(...)
    info = model.fit(train_subset, all_features, target, era_col,
                     epoch_callback=epoch_callback)
    val_predictions[target] = model.predict(val_df, all_features)
    model.save(output_path / f"model_{target}")
```

For each target:

1. **Drop NaN rows** — some targets have missing values for certain eras
2. **Era-based split** — 80% of eras for training, 20% for validation (within the training data)
3. **LightGBM training** with early stopping:
   - Objective: `regression` (L2 loss)
   - Up to 10,000 boosting rounds
   - Early stopping after 200 rounds without improvement
   - Typical result: 1000-4000 rounds depending on target
4. **Validation predictions** — predict on the full validation set
5. **Save model** — LightGBM binary + metadata JSON

#### LightGBM Parameters

| Parameter | Value | Rationale |
|---|---|---|
| `num_leaves` | 512 | Large enough to capture complex interactions |
| `max_depth` | 8 | Prevents overly deep trees |
| `learning_rate` | 0.005 | Low rate + early stopping = automatic round selection |
| `feature_fraction` | 0.1 | Only 10% of features per tree (reduces correlation between trees) |
| `bagging_fraction` | 0.5 | Only 50% of rows per tree (reduces overfitting) |
| `early_stopping_rounds` | 200 | Patient stopping — Numerai targets are noisy |
| `n_estimators` | 10,000 | Upper bound; early stopping typically fires at 1000-4000 |

#### Epoch Callback

Every 100 rounds, the epoch callback fires with:
```json
{"epoch": 100, "train_loss": 0.04974, "val_loss": 0.04978}
```

In SageMaker mode, this writes to `s3://openoptions-ml/jobs/{name}/epochs/100.json`.

### Step 6: Ensemble

```python
ensemble_preds = _ensemble_predictions(aligned_preds)
```

Rank-average across all 6 target models:
1. Rank-normalize each model's predictions to [0, 1]
2. Average the ranks
3. The result is a single prediction per row

This is the standard Numerai ensemble technique — it's robust because rank-averaging is invariant to the scale of individual model predictions.

### Step 7: Feature Neutralization

```python
val_common["prediction"] = neutralize_features(
    val_common, "prediction", neutralizer_cols,
    proportion=settings.neutralization_proportion,
)
```

Reduces feature exposure via OLS residualization:
1. Regress predictions on top 50 raw features: `prediction = features @ beta + residual`
2. Subtract a proportion of the fitted values: `adjusted = prediction - 0.5 * (features @ beta)`
3. The residual has lower correlation with raw features

**Why**: Numerai's scoring penalizes high feature exposure. Neutralization trades some raw correlation for better feature-neutral performance.

### Step 8: Validation

```python
metrics = compute_all_metrics(val_common, "prediction", target_col, era_col, feature_cols)
```

Computes Numerai-standard metrics:

| Metric | Formula | Good Value |
|---|---|---|
| `mean_corr` | Mean of per-era Spearman correlations | > 0.02 |
| `sharpe` | mean_corr / std_corr * sqrt(52) | > 1.0 |
| `max_drawdown` | Max cumulative correlation loss | > -0.05 |
| `feature_exposure` | Max per-era feature-prediction correlation | < 0.1 |

Per-target metrics are also computed for each individual model.

### Step 9: Live Predictions + Submission

```python
csv_path = generate_submission(live_ensemble, output_path, round_num)
validate_submission(csv_path, expected_ids=live_df.index)
```

1. Apply same feature engineering to live data (using same `era_stat_features` from training)
2. Predict with all 6 models
3. Rank-average ensemble
4. Neutralize
5. Rank-normalize to [0, 1]
6. Write `submission_r{round}.csv` with columns: `id`, `prediction`
7. Validate format (no NaN, range [0,1], all IDs present)

### Step 10: Upload (Optional)

```python
if upload:
    upload_submission(csv_path, public_id, secret_key, model_id)
```

Uploads to Numerai via `numerapi.NumerAPI()`. Requires `ML_NUMERAI_PUBLIC_ID` and `ML_NUMERAI_SECRET_KEY`.

## Output Files

After a successful run:

```
output/
├── model_target/
│   ├── model.lgb          # LightGBM binary
│   └── metadata.json      # Feature names, params, best iteration
├── model_target_cyrusd_20/
├── model_target_alpha_20/
├── model_target_bravo_20/
├── model_target_caroline_20/
├── model_target_delta_20/
├── metrics.json            # All validation metrics
└── submission_r1222.csv    # Live predictions
```

## Timing (Approximate)

On ml.m5.xlarge (4 vCPU, 16GB RAM) with `small` feature set:

| Step | Duration |
|---|---|
| Download data | 5-8 min |
| Load + feature engineering | 1-2 min |
| Training (6 targets) | 60-90 min |
| Ensemble + neutralization | 2-3 min |
| Validation | 1-2 min |
| Live predictions | 1-2 min |
| **Total** | **~1.5-2 hours** |
