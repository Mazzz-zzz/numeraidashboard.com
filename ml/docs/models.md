# Models

## Model Architecture

### Base Class

All models implement the `NumeraiModel` abstract base class (`models/base.py`):

```python
class NumeraiModel(ABC):
    @abstractmethod
    def fit(self, df, feature_cols, target_col, era_col, **kwargs) -> dict
    @abstractmethod
    def predict(self, df, feature_cols) -> pd.Series
    @abstractmethod
    def save(self, path: Path)
    @classmethod
    @abstractmethod
    def load(cls, path: Path) -> "NumeraiModel"
    @property
    @abstractmethod
    def model_type(self) -> str
```

### LightGBM (`models/lgbm_model.py`)

The primary model. Uses gradient-boosted decision trees for tabular prediction.

#### Parameters

| Parameter | Default | Description |
|---|---|---|
| `num_leaves` | 512 | Maximum leaves per tree. Higher = more complex trees |
| `max_depth` | 8 | Maximum tree depth. Prevents overly deep splits |
| `learning_rate` | 0.005 | Step size per boosting round. Low = more rounds needed |
| `n_estimators` | 10,000 | Maximum boosting rounds (early stopping typically fires sooner) |
| `feature_fraction` | 0.1 | Fraction of features sampled per tree (10%) |
| `bagging_fraction` | 0.5 | Fraction of rows sampled per tree (50%) |
| `early_stopping_rounds` | 200 | Stop if no improvement for N rounds |
| `objective` | `regression` | L2 (MSE) loss |
| `metric` | `l2` | Evaluation metric on validation set |
| `verbosity` | `-1` | Suppress LightGBM logs (we use our own callbacks) |

#### Training Process

```
1. Receive: train_df, feature_cols, target_col, era_col

2. Era-based split:
   - Get unique eras from train_df
   - Sort eras chronologically
   - First 80% of eras → training set
   - Last 20% of eras → validation set

3. Create LightGBM datasets:
   - lgb.Dataset(train_X, train_y)
   - lgb.Dataset(val_X, val_y)  # reference=train_dataset

4. Train with callbacks:
   - lgb.train(params, train_set, valid_sets=[train_set, val_set])
   - Early stopping callback (built-in)
   - Epoch reporting callback (custom, every 100 rounds)
   - Log evaluation callback (built-in)

5. Return training info:
   - best_iteration: round with best validation score
   - best_score: best validation L2 loss
```

#### Era-Based Split Rationale

Standard random train/val split would leak information because rows within the same era are correlated. Era-based splitting ensures the validation eras are entirely unseen during training, which better estimates out-of-sample performance.

```
Eras: [era_0001, era_0002, ..., era_0800, era_0801, ..., era_1000]
       |←——— Training (80%) ———→|  |←—— Validation (20%) ——→|
```

#### Epoch Callback

Every 100 boosting rounds, the custom callback reports:

```python
{
    "epoch": 500,
    "train_loss": 0.04949,     # train L2 (MSE)
    "val_loss": 0.04974,       # validation L2
    "train_l2": 0.04949,       # alias
    "val_l2": 0.04974,         # alias
}
```

The callback handles different metric name formats between LightGBM versions:
- Looks for `l2` or `mse` in evaluation results
- Maps both to standardized `train_loss`/`val_loss` keys

#### Prediction

```python
predictions = model.predict(df, feature_cols)
# Returns pd.Series with same index as df
```

Uses the model's `best_iteration` for prediction (not the final iteration).

#### Serialization

```python
model.save(Path("output/model_target"))
# Creates:
#   output/model_target/model.lgb       # LightGBM binary model
#   output/model_target/metadata.json   # Feature names, params, best_iteration

model = LightGBMModel.load(Path("output/model_target"))
```

### MLP (`models/mlp_model.py`)

A plain multi-layer perceptron with a configurable regularization cocktail. Any non-GBDT architecture produces predictions structurally different from the tree-dominated Numerai meta model, inherently boosting MMC.

**Architecture:** `Input → GaussianNoise → [Linear → BatchNorm → SiLU → Dropout] × N → Linear(out)`

#### Parameters

| Parameter | Default | Description |
|---|---|---|
| `hidden_dims` | `512,512,512` | Hidden layer widths (comma-separated string or list) |
| `dropout` | 0.1 | Dropout rate after each hidden layer |
| `noise_std` | 0.05 | Gaussian noise std on inputs (training only) |
| `learning_rate` | 1e-3 | AdamW learning rate |
| `weight_decay` | 1e-4 | AdamW L2 weight decay |
| `batch_size` | 8192 | Training batch size |
| `n_epochs` | 100 | Maximum epochs (capped from `n_estimators`) |
| `early_stopping_rounds` | 10 | Patience (capped from settings) |

#### A/B Testable Features

All features default to **off** (backward-compatible). Toggle via `--extra` on the Modal CLI or the frontend deploy form.

| Feature | Parameter | Off (default) | On (recommended) | Purpose |
|---|---|---|---|---|
| Heavy dropout | `dropout` | 0.1 | 0.3 | Prevent overfitting on noisy features |
| Strong weight decay | `weight_decay` | 1e-4 | 1e-2 | L2 regularization |
| Mixup augmentation | `mixup_alpha` | 0.0 | 0.4 | Interpolate random sample pairs per batch |
| Stochastic Weight Averaging | `swa` | false | true | Average weights over last 50% of training |
| LR warmup | `warmup_epochs` | 0 | 5 | Linear warmup from 1% → full LR, then cosine |
| Architecture | `hidden_dims` | 512,512,512 | 1024,512 | Wider/shallower for less overfitting |
| Multi-head output | `multi_head` | false | true | Shared backbone + per-target heads |

**Mixup** creates synthetic training data by interpolating random pairs: `x_mix = λ·x_i + (1-λ)·x_j` where λ ~ Beta(α, α). Smooths decision boundaries.

**SWA** averages model weights over the last half of training, finding flatter minima that generalize better. Updates BatchNorm statistics after averaging.

**Multi-head** trains one shared backbone with separate output heads for all targets simultaneously. The shared representation must be useful across targets, which acts as strong implicit regularization. Uses `fit_multi_head()` instead of `fit()`.

#### Example: Full Cocktail on Modal

```bash
python3 sagemaker/modal_runner.py --job-name mlp-cocktail \
  --model-type mlp --gpu a100 \
  --extra dropout=0.3 weight_decay=0.01 mixup_alpha=0.4 \
         swa=true warmup_epochs=5 hidden_dims=1024,512 \
         single_target_mode=true target_col=target_ender_20
```

Multi-head (all 8 targets, shared backbone):
```bash
python3 sagemaker/modal_runner.py --job-name mlp-multihead \
  --model-type mlp --gpu a100 \
  --extra dropout=0.3 weight_decay=0.01 mixup_alpha=0.4 multi_head=true
```

### FT-Transformer (`models/ft_transformer_model.py`)

Feature Tokenizer + Transformer (Gorishniy et al., 2021). Tokenizes each numerical feature into a learned embedding, prepends a [CLS] token, and applies standard Transformer self-attention. Consistently outranks other DL methods on tabular benchmarks (average rank 1.8 vs TabNet 7.5, NODE 3.9).

Attention over features captures cross-feature interactions that tree models miss, producing inherently orthogonal predictions for MMC.

**Architecture:** `Input → GaussianNoise → FeatureTokenizer → [CLS] + tokens → TransformerBlocks × N → [CLS] head → Linear(1)`

#### Parameters

| Parameter | Default | Description |
|---|---|---|
| `d_token` | 192 | Embedding dimension per feature token |
| `n_blocks` | 3 | Number of Transformer encoder blocks |
| `n_heads` | 8 | Attention heads per block |
| `attn_dropout` | 0.2 | Dropout on attention weights |
| `ff_dropout` | 0.1 | Dropout in feed-forward layers |
| `noise_std` | 0.05 | Gaussian noise on inputs (training only) |
| `learning_rate` | 1e-4 | AdamW learning rate (lower than MLP) |
| `weight_decay` | 1e-3 | AdamW L2 weight decay |
| `batch_size` | 1024 | Smaller than MLP due to attention memory |
| `n_epochs` | 100 | Maximum epochs |
| `early_stopping_rounds` | 15 | Patience |

#### Implementation Details

- **Self-contained**: No external `rtdl` dependency — runs in the Modal container with just PyTorch.
- **Flash Attention**: Uses `F.scaled_dot_product_attention` which dispatches to Flash Attention on CUDA, avoiding O(N²) memory for long feature sequences.
- **Pre-norm**: LayerNorm before attention/FFN (more stable training).
- **Gradient clipping**: `max_norm=1.0` for Transformer stability.
- **Weight decay groups**: No decay on biases and LayerNorm parameters.
- **Memory**: With 840 features (medium set), batch_size=1024 fits on A100-40GB. Epoch time is ~28 min (vs ~3 min for MLP).

#### Example

```bash
python3 sagemaker/modal_runner.py --job-name ftt-test \
  --model-type ft_transformer --gpu a100 \
  --extra single_target_mode=true target_col=target_ender_20
```

### CatBoost (`models/catboost_model.py`)

Alternative gradient boosting via CatBoost. Uses the same `NumeraiModel` interface with CatBoost-native parameters (`iterations`, `depth`, `learning_rate`).

### Ensemble (`models/ensemble.py`)

Utility functions for combining predictions from multiple models:

#### Rank Average

```python
ensemble = rank_average({"target": preds1, "target_alpha_20": preds2, ...})
```

1. Rank-normalize each model's predictions to [0, 1] using percentile ranks
2. Average the ranks across models
3. Result is a single prediction per row

This is the standard Numerai ensemble technique. Rank-averaging is robust because:
- Invariant to prediction scale (each model's predictions are normalized)
- Combines diverse signals without one model dominating
- Preserves rank ordering from each model

#### Weighted Blend

```python
ensemble = weighted_blend(
    {"target": preds1, "target_alpha_20": preds2},
    {"target": 0.6, "target_alpha_20": 0.4}
)
```

Like rank average, but with custom weights per model. Useful when some targets are known to be more predictive.

## Multi-Target Strategy

### Why 6 Targets?

Numerai provides multiple target variants that capture different aspects of stock returns:
- Different time horizons (forward-looking periods)
- Different return decompositions (factors, styles)
- Different risk adjustments

Training on multiple targets and ensembling produces:
- **More robust predictions** — reduces variance from any single noisy target
- **Better feature utilization** — different targets emphasize different features
- **Higher effective Sharpe** — diversification across targets

### Target Handling

```python
# Skip targets with >50% NaN
if train_df[target].isna().sum() > len(train_df) * 0.5:
    continue

# Drop NaN rows for this specific target
mask = train_df[target].notna()
train_subset = train_df[mask]
```

Different targets have different NaN patterns — some may be missing for certain eras. Each model trains only on rows where its specific target is available.

## Adding New Models

To add a new model type:

1. Create `models/new_model.py` implementing `NumeraiModel`
2. Implement `fit()`, `predict()`, `save()`, `load()`, `model_type`
3. Add optional import in `models/__init__.py` with `try/except ImportError`
4. Add to `create_model()` factory and `list_available_models()` in `models/__init__.py`
5. Add model type to `valid_model_types` set in `backend/app/routers/ml.py`
6. Add `<option>` to frontend dropdowns in `ml/+page.svelte`, `signals/+page.svelte`, and `TrainConfigModal.svelte`
7. Add CLI choices in `training/trainer.py` and `sagemaker/launch_job.py`
8. If the model needs extra pip packages, add them to the Modal image in `sagemaker/modal_runner.py`

### Currently available models

| Model | Type | Architecture | Best for |
|---|---|---|---|
| LightGBM | `lgbm` | Gradient-boosted trees | Baseline CORR, fast training |
| CatBoost | `catboost` | Gradient-boosted trees | Alternative GBDT signal |
| MLP | `mlp` | Feed-forward neural net | MMC via non-GBDT architecture |
| FT-Transformer | `ft_transformer` | Attention over features | MMC via cross-feature interactions |
