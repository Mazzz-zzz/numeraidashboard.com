# Configuration Reference

All ML settings are managed via Pydantic's `BaseSettings` in `config/settings.py`. Settings are loaded from environment variables with the `ML_` prefix, or from a `.env` file in the `ml/` directory.

## Environment Variables

### Credentials

| Variable | Default | Description |
|---|---|---|
| `ML_NUMERAI_PUBLIC_ID` | `""` | Numerai API public key (for upload only) |
| `ML_NUMERAI_SECRET_KEY` | `""` | Numerai API secret key (for upload only) |
| `ML_NUMERAI_MODEL_ID` | `""` | Numerai model slot ID (for upload) |

Data download does not require credentials — `numerapi` supports anonymous access to tournament data.

### S3 Storage

| Variable | Default | Description |
|---|---|---|
| `ML_S3_BUCKET` | `openoptions-ml` | S3 bucket for models, data, job artifacts |
| `ML_S3_PREFIX` | `numerai/` | Key prefix within bucket |

### LightGBM Training

| Variable | Default | Description |
|---|---|---|
| `ML_DEFAULT_MODEL_TYPE` | `lgbm` | Model type: `lgbm`, `catboost`, `mlp`, `ft_transformer` |
| `ML_DEFAULT_NUM_ROUNDS` | `10000` | Maximum boosting rounds |
| `ML_DEFAULT_LEARNING_RATE` | `0.005` | Learning rate (eta) |
| `ML_DEFAULT_NUM_LEAVES` | `512` | Max leaves per tree |
| `ML_DEFAULT_MAX_DEPTH` | `8` | Max tree depth |
| `ML_DEFAULT_FEATURE_FRACTION` | `0.1` | Column subsampling per tree (10%) |
| `ML_DEFAULT_BAGGING_FRACTION` | `0.5` | Row subsampling per tree (50%) |
| `ML_EARLY_STOPPING_ROUNDS` | `200` | Stop after N rounds without improvement |

### Feature Set

| Variable | Default | Description |
|---|---|---|
| `ML_FEATURE_SET` | `medium` | Feature set: `small` (42), `medium` (705), `all` (2376) |

### Feature Engineering

| Variable | Default | Description |
|---|---|---|
| `ML_ENABLE_ERA_STATS` | `true` | Per-era demeaning and z-score normalization |
| `ML_ENABLE_GROUP_AGGREGATES` | `true` | Cross-feature group statistics (mean, std, skew) |
| `ML_ENABLE_ROLLING_FEATURES` | `false` | Rolling mean/std over era windows |
| `ML_ENABLE_GARCH` | `false` | GARCH(1,1) conditional volatility features |
| `ML_ERA_STATS_TOP_N` | `30` | Number of top-variance features for era stats |

### Multi-Target Training

| Variable | Default | Description |
|---|---|---|
| `ML_MULTI_TARGET_ENABLED` | `true` | Train on multiple target columns |
| `ML_TARGET_COLS` | `target,target_cyrusd_20,...` | Comma-separated target columns |

Default targets:
- `target` — primary
- `target_cyrusd_20` — Cyrus USD 20-day forward
- `target_alpha_20` — Alpha 20-day
- `target_bravo_20` — Bravo 20-day
- `target_caroline_20` — Caroline 20-day
- `target_delta_20` — Delta 20-day

### Feature Neutralization

| Variable | Default | Description |
|---|---|---|
| `ML_NEUTRALIZATION_PROPORTION` | `0.5` | Strength of neutralization (0=none, 1=full) |
| `ML_NEUTRALIZATION_TOP_N` | `50` | Number of features to neutralize against |

### Memory Management

| Variable | Default | Description |
|---|---|---|
| `ML_MAX_TRAIN_ERAS` | `0` | Subsample training to N eras (0 = all eras) |

Use this on machines with limited RAM. Setting `ML_MAX_TRAIN_ERAS=200` reduces memory usage significantly at the cost of training on less data.

### Column Identifiers

| Variable | Default | Description |
|---|---|---|
| `ML_ERA_COL` | `era` | Column name for era identifier |
| `ML_TARGET_COL` | `target` | Primary target column name |
| `ML_FEATURE_PREFIX` | `feature_` | Prefix identifying feature columns |

## .env File

Create `ml/.env` (this file is gitignored):

```bash
# Required for submission upload
ML_NUMERAI_PUBLIC_ID=your_public_id_here
ML_NUMERAI_SECRET_KEY=your_secret_key_here

# Optional: specify model slot
ML_NUMERAI_MODEL_ID=your_model_id

# Override defaults
ML_FEATURE_SET=small
ML_DEFAULT_NUM_ROUNDS=5000
ML_EARLY_STOPPING_ROUNDS=100
```

## Hyperparameter Overrides

When launching from the dashboard or Modal CLI, hyperparameters can be overridden. These are passed as `hyperparams` in the `TrainRequest` and stored in `ml_runs.hyperparams_json`.

Settings-level hyperparams (mapped to `ML_*` env vars via `HP_TO_ENV` in `modal_runner.py`):
```json
{
  "num_rounds": 10000,
  "learning_rate": 0.005,
  "num_leaves": 512,
  "max_depth": 8,
  "feature_fraction": 0.1,
  "bagging_fraction": 0.5,
  "early_stopping_rounds": 200,
  "max_train_eras": 200,
  "single_target_mode": true,
  "target_col": "target_ender_20"
}
```

### MLP / FT-Transformer Model Parameters

These are passed directly to the model constructor (not via env vars). Set them via `--extra` on the Modal CLI or the frontend deploy form.

| Parameter | Default | Description |
|---|---|---|
| `dropout` | 0.1 | Dropout rate after each hidden layer |
| `weight_decay` | 1e-4 | AdamW L2 weight decay |
| `hidden_dims` | `512,512,512` | Hidden layer widths (comma-separated) |
| `noise_std` | 0.05 | Input Gaussian noise std (training only) |
| `batch_size` | 8192 (MLP) / 1024 (FT-T) | Training batch size |
| `mixup_alpha` | 0.0 | Mixup augmentation strength (0=off, 0.4=recommended) |
| `swa` | false | Enable Stochastic Weight Averaging |
| `swa_start_frac` | 0.5 | Start SWA at this fraction of total epochs |
| `warmup_epochs` | 0 | Linear LR warmup epochs (0=off) |
| `multi_head` | false | Multi-head MLP: shared backbone, per-target output heads |

Example — MLP with full regularization cocktail:
```bash
python3 sagemaker/modal_runner.py --job-name mlp-cocktail \
  --model-type mlp --gpu a100 \
  --extra dropout=0.3 weight_decay=0.01 mixup_alpha=0.4 \
         swa=true warmup_epochs=5 hidden_dims=1024,512
```

Example — FT-Transformer:
```bash
python3 sagemaker/modal_runner.py --job-name ftt-test \
  --model-type ft_transformer --gpu a100 \
  --extra single_target_mode=true target_col=target_ender_20
```

## Feature Groups

Numerai v5 features belong to named groups. The group assignments are defined in `features.json` (downloaded from Numerai) and referenced in `config/feature_groups.yaml`.

Known groups:
- `intelligence`, `charisma`, `strength`, `dexterity`, `constitution`
- `wisdom`, `agility`, `serenity`, `sunshine`, `rain`, `midnight`

Group aggregates (mean/std/skew) are computed across features within each group, adding 3 columns per group.
