"""Pydantic settings for ML training pipeline."""

from __future__ import annotations

from typing import List

from pydantic_settings import BaseSettings


class MlSettings(BaseSettings):
    # Numerai credentials (only needed for upload, not data download)
    numerai_public_id: str = ""
    numerai_secret_key: str = ""
    numerai_model_id: str = ""

    # S3 storage for models and data. Provider-backed jobs require an explicit bucket.
    s3_bucket: str = ""
    s3_prefix: str = "numerai/"

    # LightGBM training defaults — production settings
    default_model_type: str = "lgbm"
    default_num_rounds: int = 10000
    default_learning_rate: float = 0.005
    default_num_leaves: int = 512
    default_max_depth: int = 8
    default_feature_fraction: float = 0.1
    default_bagging_fraction: float = 0.5
    default_min_data_in_leaf: int = 20
    default_reg_alpha: float = 0.0
    default_reg_lambda: float = 0.0
    default_min_split_gain: float = 0.0
    default_path_smooth: float = 0.0
    default_max_bin: int = 255
    early_stopping_rounds: int = 200

    # Single-target mode: skip multi-target ensemble, train one model only
    single_target_mode: bool = False

    # Feature set: "small" (42), "medium" (705), "all" (2376)
    feature_set: str = "medium"

    # Feature dtype for data loading: "float32" (default) or "int8".
    # Numerai features are 5-bin quantized (0, 0.25, 0.5, 0.75, 1), so int8
    # (values 0-4) is lossless for tree models and cuts frame memory 4x —
    # required to fit all-features x full-history on a 96GB machine. Neural
    # trainers expect float32 inputs, so int8 is opt-in per run.
    feature_dtype: str = "float32"

    # Feature engineering toggles
    enable_era_stats: bool = True
    enable_group_aggregates: bool = True
    enable_rolling_features: bool = False
    enable_garch: bool = False

    # Era stats: top N features by variance
    era_stats_top_n: int = 30

    # Multi-target training — all 20-day horizon targets from v5.2 Faith II (list unchanged in v5.3)
    multi_target_enabled: bool = True
    target_cols: List[str] = [
        "target",
        "target_agnes_20",
        "target_alpha_20",
        "target_bravo_20",
        "target_caroline_20",
        "target_charlie_20",
        "target_claudia_20",
        "target_cyrusd_20",
        "target_delta_20",
        "target_echo_20",
        "target_ender_20",
        "target_jasper_20",
        "target_jeremy_20",
        "target_ralph_20",
        "target_rowan_20",
        "target_sam_20",
        "target_teager2b_20",
        "target_tyler_20",
        "target_victor_20",
        "target_waldo_20",
        "target_xerxes_20",
    ]

    # Feature neutralization
    neutralization_proportion: float = 0.25
    neutralization_top_n: int = 50

    # Ensemble: drop targets with mean per-era correlation below this
    min_target_correlation: float = 0.01

    # Memory management — 0 = all eras; 200 fits in 16GB with medium features
    max_train_eras: int = 200

    # Column identifiers
    era_col: str = "era"
    target_col: str = "target"
    feature_prefix: str = "feature_"

    # Database (for logging results)
    db_url: str = ""

    class Config:
        env_prefix = "ML_"


def get_ml_settings() -> MlSettings:
    return MlSettings()
