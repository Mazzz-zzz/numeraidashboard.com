# Model reference

Builder and `create_model` write `model_type` into a model draft's `runConfig`. When the draft is launched, the selected provider passes that value to the Python trainer, which constructs the matching implementation.

All configurations can also include the common pipeline fields `mode`, `tournament`, `feature_set`, `neutralization_pct`, `upload`, and `max_train_eras`. Extra model-specific fields are preserved by MCP.

## Gradient boosting

### LightGBM — `lgbm`

The fast CPU baseline for structured Numerai data. It uses era-aware validation and early stopping and is a good first choice for feature and neutralization sweeps. macOS requires LightGBM and `libomp`.

Key fields: `num_rounds`, `learning_rate`, `num_leaves`, `max_depth`, `feature_fraction`, `bagging_fraction`, `bagging_freq`, and `early_stopping_rounds`.

[LightGBM documentation](https://lightgbm.readthedocs.io/)

### XGBoost — `xgboost`

A portable histogram-tree CPU challenger with era-aware early stopping. The trainer maps `feature_fraction` to column sampling and `bagging_fraction` to row subsampling.

Key fields: `num_rounds`, `learning_rate`, `max_depth`, `feature_fraction`, `bagging_fraction`, and `early_stopping_rounds`.

[XGBoost documentation](https://xgboost.readthedocs.io/)

### CatBoost — `catboost`

A robust tree challenger that runs on CPU or a package-dependent GPU build. It is useful for low-touch experiments and uses era-aware validation.

Key fields: `num_rounds`, `learning_rate`, `max_depth`, `l2_leaf_reg`, `random_strength`, `bagging_temperature`, `border_count`, and `early_stopping_rounds`.

[CatBoost documentation](https://catboost.ai/)

### WarpGBM — `warpgbm`

GPU-native gradient boosting from the Numerai community, running its binning, histogram, split-search, and inference loops as tensor operations. The local runner uses the `Mazzz-zzz/warpgbm@mps-support` fork, which adds a pure-PyTorch kernel fallback so it runs on Apple Silicon (MPS) and CPU as well as CUDA. Pre-binned int8 features (`feature_dtype: "int8"`) hit its fast path. `era_buckets` above 1 enables Directional Era-Splitting (invariant splits across era groups) — measured to reduce correlation on v5.3 data, so the default is pooled training.

Key fields: `num_rounds`, `learning_rate`, `max_depth`, `min_data_in_leaf`, `feature_fraction`, `max_bin`, and `era_buckets`.

[WarpGBM repository](https://github.com/jefferythewind/warpgbm)

## Neural tabular

These PyTorch models automatically resolve CUDA, Apple MPS, or CPU on the local worker.

### MLP — `mlp`

The small neural baseline. It supports feature noise, mixup, stochastic weight averaging, learning-rate warmup, and optional multi-head targets.

Key fields: `num_rounds`, `learning_rate`, `hidden_dims`, `dropout`, `noise_std`, `weight_decay`, `batch_size`, `early_stopping_rounds`, `mixup_alpha`, `swa`, `swa_start_frac`, `warmup_epochs`, and `multi_head`.

[PyTorch neural-network documentation](https://pytorch.org/docs/stable/nn.html)

### FT-Transformer — `ft_transformer`

A feature-token transformer that uses self-attention to learn cross-feature interactions. It is useful for testing signal that is orthogonal to tree ensembles.

Key fields: `num_rounds`, `learning_rate`, `d_token`, `n_blocks`, `n_heads`, `attn_dropout`, `ff_dropout`, `noise_std`, `weight_decay`, `batch_size`, and `early_stopping_rounds`.

[RTDL reference implementation](https://github.com/yandex-research/rtdl-revisiting-models)

### ModernNCA — `modern_nca`

A neural nearest-neighbor model that learns an embedding space and predicts from neighbor relationships.

Key fields: `num_rounds`, `learning_rate`, `hidden_dims`, `d_embedding`, `n_neighbors`, `dropout`, `noise_std`, `weight_decay`, `batch_size`, and `early_stopping_rounds`.

[ModernNCA paper](https://huggingface.co/papers/2407.03257)

### TabM — `tabm`

A parameter-efficient MLP ensemble. Members share weight matrices and use inexpensive per-member BatchEnsemble scaling vectors, providing ensemble diversity at roughly single-MLP parameter cost.

Key fields: `num_rounds`, `learning_rate`, `n_ensemble`, `hidden_dims`, `dropout`, `noise_std`, `weight_decay`, `batch_size`, and `early_stopping_rounds`.

[TabM repository](https://github.com/yandex-research/tabm)

## Foundation and in-context models

These models store selected context rows rather than fine-tuning a new set of weights.

### TabPFN — `tabpfn`

A pretrained in-context tabular learner. Bagged row and feature subsampling provides an inductive bias that is useful for orthogonal signal and MMC tests. It supports CUDA, Apple MPS, or CPU.

Key fields: `n_bags`, `context_rows`, `features_per_bag`, `n_recent_eras`, `n_estimators_per_bag`, and `device`.

[TabPFN repository](https://github.com/PriorLabs/TabPFN)

### TabICL — `tabicl`

An open column-row-dataset transformer for scalable in-context prediction. It supports offloading and mixed precision. For stability, the local worker defaults TabICL to CPU on Apple Silicon unless `NUMERAI_TABICL_ALLOW_MPS=1` explicitly enables experimental MPS execution.

Key fields: `n_bags`, `context_rows`, `features_per_bag`, `n_recent_eras`, `n_estimators_per_bag`, `norm_methods`, `device`, `offload_mode`, `use_amp`, `use_fa3`, and `batch_size`.

[TabICL documentation](https://tabicl.readthedocs.io/en/latest/), [GitHub](https://github.com/soda-inria/tabicl), and [paper](https://arxiv.org/html/2502.05564v1)

## Local Mac runs

For an available `local` provider, omit `compute_type`. MCP queues the run and the normal workstation worker claims it by outbound polling. The MCP client must not call the daemon directly and must not route to Modal as a fallback.
