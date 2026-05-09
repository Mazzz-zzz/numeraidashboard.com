# Feature Engineering

All feature engineering is in `data/features.py` (and optionally `data/garch.py`). Features are applied in-place on DataFrames and are consistent across train, validation, and live data.

## Raw Features

Numerai provides features as pre-binned values (0, 1, 2, 3, 4) representing quintile ranks. All features are prefixed with `feature_`.

| Feature Set | Count | Examples |
|---|---|---|
| `small` | 42 | Core signal features |
| `medium` | 705 | Broader signal coverage |
| `all` | 2376 | Every available feature |

## Engineered Features

### Era Statistics

**Module**: `data/features.py:add_era_stats()`
**Toggle**: `ML_ENABLE_ERA_STATS=true` (default)

For the top N features by variance (default N=30), computes per-era transformations:

```
feature_X_era_demean = feature_X - mean(feature_X within this era)
feature_X_era_zscore = (feature_X - era_mean) / era_std
```

**Purpose**: Raw features capture absolute quintile rank. Era demeaning captures *relative* rank within each era, which is more predictive because eras have different distributional characteristics.

**Column consistency**: The top-N features are selected by variance from the *training* data only. The same feature list is then passed to validation and live data engineering via the `era_stat_features` parameter. This prevents column mismatch errors.

**Added columns**: 2 per feature (demean + zscore) x 30 features = 60 columns.

### Group Aggregates

**Module**: `data/features.py:add_group_aggregates()`
**Toggle**: `ML_ENABLE_GROUP_AGGREGATES=true` (default)

Groups are discovered from `features.json` metadata at runtime:

```python
feature_groups = discover_feature_groups(metadata, feature_cols)
# e.g., {"intelligence": ["feature_abc", "feature_def", ...], "charisma": [...], ...}
```

For each group:
```
group_{name}_mean = row-wise mean across features in group
group_{name}_std  = row-wise std across features in group
group_{name}_skew = row-wise skew across features in group
```

**Purpose**: Captures the overall "level" of each feature group for a given stock. If all intelligence features are high for a stock, that's a different signal than if they're mixed.

**Added columns**: 3 per group. With ~11 groups in the small set and some having no active features, typically adds 0-15 columns.

### Rolling Features (Disabled by Default)

**Module**: `data/features.py:add_rolling_features()`
**Toggle**: `ML_ENABLE_ROLLING_FEATURES=false`

Computes rolling statistics over era windows:

```
feature_X_roll5_mean  = rolling mean of era-level median over 5 eras
feature_X_roll5_std   = rolling std of era-level median over 5 eras
feature_X_roll10_mean = ... over 10 eras
feature_X_roll20_mean = ... over 20 eras
```

**Purpose**: Captures temporal trends in feature distributions. If a feature's era-level median is trending up, that's a regime signal.

**Added columns**: 6 per feature x number of features. Can add thousands of columns — use sparingly.

**Why disabled**: Adds significant RAM usage and training time with marginal benefit for the small/medium feature sets.

### GARCH Volatility (Disabled by Default)

**Module**: `data/garch.py:fit_garch_features()`
**Toggle**: `ML_ENABLE_GARCH=false`
**Requires**: `arch` library (`pip install arch`)

Fits a GARCH(1,1) model on era-level return proxies:

1. Computes era-level median of selected features as a return proxy
2. Fits `GARCH(1,1)`: `sigma_t^2 = omega + alpha * epsilon_{t-1}^2 + beta * sigma_{t-1}^2`
3. Maps conditional volatility back to individual rows
4. Adds regime indicator (high/low volatility)

**Purpose**: Captures volatility clustering in feature dynamics. High-volatility regimes may warrant different prediction strategies.

**Added columns**: 2 per feature (volatility estimate + regime indicator).

**Why disabled**: Requires the `arch` library (heavy dependency), and the benefit is marginal for standard Numerai submissions.

## Feature Neutralization

**Module**: `data/features.py:neutralize_features()`
**Applied**: After ensemble predictions, before validation and submission

Not a feature engineering step per se, but closely related. Reduces the correlation between predictions and raw features:

```python
# OLS: prediction = features @ beta + residual
beta = lstsq(features_with_const, predictions)
adjusted = predictions - proportion * (features @ beta - intercept)
```

**Parameters**:
- `neutralization_proportion` (default 0.5): How much of the feature-correlated signal to remove
- `neutralization_top_n` (default 50): Number of raw features to neutralize against

**Trade-off**: Neutralization reduces `feature_exposure` (good for Numerai scoring) but also reduces `mean_corr` (raw prediction quality). The 50% proportion is a middle ground.

## Pipeline Diagram

```
Raw Features (42/705/2376 columns)
    │
    ├─ Era Statistics ──► +60 columns (30 features x 2)
    │
    ├─ Group Aggregates ──► +0-33 columns (up to 11 groups x 3)
    │
    ├─ Rolling Features ──► +0 columns (disabled by default)
    │
    ├─ GARCH ──► +0 columns (disabled by default)
    │
    ▼
All Features (e.g., 102 for small set)
    │
    ▼
LightGBM Training
    │
    ▼
Predictions
    │
    ├─ Ensemble (rank-average)
    │
    ├─ Neutralization (OLS residualization)
    │
    ▼
Submission
```
