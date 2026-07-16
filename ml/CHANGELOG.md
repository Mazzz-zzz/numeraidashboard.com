# ML Pipeline Changelog

## 2026-07-16 — Local XGBoost training

### New: XGBoost model adapter (`models/xgboost_model.py`)
**Files:** `models/xgboost_model.py`, `models/__init__.py`, `requirements.txt`

Added pinned XGBoost 3.2 support with era-aware validation, early stopping,
sample weights, shared progress callbacks, and UBJ model persistence. The
factory and Builder now expose `model_type=xgboost`, so local daemon runs reuse
the existing Numerai metrics, artifact, polling, and cancellation lifecycle.

### Fix: macOS OpenMP setup covers native boosting libraries
**Files:** `local/setup_libomp.sh`

The no-Homebrew helper now patches both LightGBM and XGBoost dylibs against
PyTorch's bundled `libomp.dylib`, and rejects stale Homebrew prefix records.

## 2026-03-28 — Deep learning models and MLP A/B testing

### New: FT-Transformer model (`models/ft_transformer_model.py`)
**Files:** `models/ft_transformer_model.py`, `models/__init__.py`

Added self-contained FT-Transformer (Gorishniy et al., 2021) — tokenizes each
numerical feature into a learned embedding, applies Transformer self-attention,
and predicts from a [CLS] token. Uses `F.scaled_dot_product_attention` for Flash
Attention on CUDA, avoiding O(N²) memory with 840-feature sequences. Pre-norm
architecture, gradient clipping, and proper weight decay groups.

Attention over features produces fundamentally different decision boundaries from
tree models, giving inherently orthogonal predictions for Numerai MMC.

### New: MLP regularization cocktail with A/B testing
**Files:** `models/mlp_model.py`, `models/__init__.py`, `training/trainer.py`, `sagemaker/modal_runner.py`

Rewrote MLPModel with configurable A/B features, all backward-compatible (defaults
match previous behavior):

- **Mixup augmentation** (`mixup_alpha`): interpolates random sample pairs per
  batch. Smooths decision boundaries on noisy data.
- **Stochastic Weight Averaging** (`swa`): averages model weights over the last
  50% of training, updating BN stats after. Finds flatter minima.
- **LR warmup** (`warmup_epochs`): linear warmup before cosine decay. Prevents
  early large gradient steps from destabilizing.
- **Multi-head output** (`multi_head`): shared backbone + per-target output heads,
  trained on all targets simultaneously. Shared representation acts as implicit
  regularization — the strongest technique for noisy multi-target data.
- **Architecture** (`hidden_dims`): accepts comma-separated string for easy CLI use.
- **Heavier regularization** (`dropout`, `weight_decay`): same params, just needs
  higher values (0.3 and 0.01 respectively).

All features toggleable via Modal CLI `--extra` or the frontend deploy form.

### New: model configuration support for all model types
**Files:** `training/trainer.py`, `sagemaker/modal_runner.py`, `models/*`

Added MLP and FT-Transformer configuration paths for workload launchers.
Model-specific fields include dropout, weight decay, mixup alpha, warmup epochs,
hidden dims, SWA, and multi-head mode. Hyperparameters should now flow from the
Amplify/provider worker path into the trainer and model constructor.

### New: model_kwargs passthrough in trainer
**Files:** `training/trainer.py`

Added `model_kwargs` parameter to `run_training()` which passes through to
`create_model()`. The Modal runner extracts model-specific keys from the
hyperparams dict and passes them as `model_kwargs`. This allows any model
parameter to flow from the CLI/frontend through to the model without requiring
env var mapping.

When `multi_head=true` and `model_type=mlp`, the trainer uses a separate code
path that trains one model on all targets simultaneously instead of looping.

## 2026-03-25 — Ensemble, neutralization & signal quality fixes

### Fix: Exposure-based neutralizer selection
**Files:** `training/validate.py`, `training/trainer.py`, `training/inference.py`

Neutralizer features were selected alphabetically (`feature_cols[:50]`), which
neutralized against arbitrary features instead of the ones driving exposure.
Added `top_exposure_features()` which computes mean absolute per-era rank
correlation between predictions and each feature, then selects the top-N by
actual exposure. This targets the features causing high feature exposure (0.226)
instead of removing signal from unrelated features.

Neutralizer columns are now saved in `inference_config.json` so live predictions
use the same exposure-based selection from training.

### Fix: Reduce default neutralization from 50% to 25%
**Files:** `config/settings.py`, `training/trainer.py`, `bootstrap.py`, `training/inference.py`

At 50% neutralization, the best individual target (delta_20 at 0.022 corr) was
being crushed to ~0.002 in the ensemble. Community consensus is 20-30%.
Reduced default from 50% to 25% across all entry points.

### Fix: Drop weak targets from ensemble
**Files:** `config/settings.py`, `training/trainer.py`

All 8 targets were equally weighted in the ensemble despite massive performance
differences (delta_20=0.022 vs jasper_20=0.008). Weak models add noise and
dilute signal. Added `min_target_correlation` setting (default 0.01) — targets
with mean per-era correlation below this threshold are dropped before ensembling.
At least one target (the best) is always kept.

### Fix: Per-era neutralization
**Files:** `data/features.py`, `training/trainer.py`, `training/inference.py`

`neutralize_features` ran global OLS across all validation rows, but Numerai
scores per-era. Global OLS can fit cross-era patterns that don't exist within
any single era, producing misleading neutralization. Refactored to support
per-era neutralization via an `era_col` parameter — OLS runs within each era
separately. Eras with too few rows (< n_features + 2) are skipped to avoid
rank-deficient OLS. Backward compatible: omitting `era_col` preserves the
old global behavior.

## 2026-03-25 — Validation & performance fixes

### Fix: Use real Numerai validation data for early stopping
**Files:** `models/lgbm_model.py`, `models/catboost_model.py`, `models/base.py`, `training/trainer.py`

Previously, `fit()` split the training data 80/20 by era for early stopping.
With `max_train_eras=200`, this meant early stopping monitored only the last
40 training eras — temporally adjacent to the training set and nearly
indistinguishable from it. Val loss appeared flat (~0.050 baseline variance)
because the eval set provided no real signal.

Now `trainer.py` passes the actual Numerai validation file (`validation.parquet`)
into each model's `fit()` as the early stopping eval set. All training eras are
used for training. Early stopping monitors a temporally distinct dataset, so val
loss will track real generalization and early stopping will fire meaningfully.

### Fix: Sawtooth pattern in epoch loss chart explained & documented
**Files:** `training/trainer.py` (existing behavior, no code change)

The zigzag pattern in loss charts between ~epochs 1000–1400 was caused by
multi-target training: 8 models train sequentially, each starting fresh, but
epoch callbacks use a `global_epoch_offset` that stitches them into one timeline.
When target N finishes and target N+1 starts, loss jumps up — creating the
sawtooth. This is cosmetic, not a training bug.

### Perf: Cache per-era correlations in validation metrics
**Files:** `training/validate.py`

`compute_all_metrics` called `per_era_correlation` redundantly — once each for
`mean_correlation`, `sharpe_ratio`, and `max_drawdown` (3x per model). With 8
targets + ensemble + benchmarks, this ran Spearman correlation across hundreds
of eras ~27 times instead of ~9. Added `_era_corrs` cache parameter so
correlations are computed once and reused, cutting validation time by ~3x.

### Perf: Replace scipy.stats.spearmanr with pandas rank().corr()
**Files:** `training/validate.py`

`per_era_correlation` used `scipy.stats.spearmanr` which has overhead per call
(p-value computation, input validation). Replaced with `pandas rank().corr()`
which is faster for the rank-correlation-only case. Also added
`include_groups=False` to silence pandas FutureWarning on groupby.apply.

### Perf: Vectorize feature_exposure calculation
**Files:** `training/validate.py`

`feature_exposure` ran a Python loop calling `spearmanr` for every feature in
every era (50 features x 200 eras = 10,000 scipy calls). Replaced with
vectorized `rank()` + `corrwith()` — ranks all columns once per era, then
computes all correlations in a single operation.

### Perf: Skip feature_exposure for per-target metrics
**Files:** `training/trainer.py`

Per-target validation called `compute_all_metrics` with full feature exposure
for each of 8 targets. Feature exposure is only meaningful for the final
ensemble, not individual target models. Passing `feature_cols=[]` for per-target
metrics eliminates 8 redundant feature exposure passes (8 x 10,000 correlation
calls).

### Fix: Instance size for v5.2 dataset
**Files:** `sagemaker/launch_experiments.py`

Bumped `medium` and `all` feature sets from `ml.m5.xlarge` (16 GB) /
`ml.m5.2xlarge` (32 GB) to `ml.m5.4xlarge` (64 GB). The full v5.2 Classic
dataset exceeds 16 GB when loaded into memory, causing all experiments launched
on 2026-03-18 to fail with OOM.
