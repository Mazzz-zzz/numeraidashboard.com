"""Numerai Signals training pipeline.

Parallel to trainer.py but tailored for Signals v2.1 Alpha dataset:
- Downloads via SignalsAPI instead of NumerAPI
- Supports neutralizer-aware training (train_neutralizer.parquet)
- Supports sample-weight-aware training (train_sample_weights.parquet)
- Discovers features/targets from parquet columns (no features.json)
- Uploads via SignalsAPI
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))

from config.settings import get_ml_settings
from data.signals_download import (
    download_signals_data,
    get_signals_feature_columns,
    get_signals_target_columns,
    load_signals_live,
    load_signals_neutralizer,
    load_signals_sample_weights,
    load_signals_train,
    load_signals_validation,
)
from data.features import (
    add_era_stats,
    add_group_aggregates,
    neutralize_features,
)
from models import create_model
from training.submission import generate_submission, validate_submission
from training.validate import compute_all_metrics


def _build_columns_to_load(
    feature_cols: List[str],
    target_cols: List[str],
    era_col: str,
) -> List[str]:
    """Build the list of columns to load from parquet (saves RAM)."""
    cols = list(feature_cols) + [era_col]
    for t in target_cols:
        if t not in cols:
            cols.append(t)
    return cols


def _apply_feature_engineering(
    df: pd.DataFrame,
    feature_cols: List[str],
    settings,
    era_stat_features: Optional[List[str]] = None,
) -> tuple:
    """Apply feature engineering in-place.

    Signals doesn't have feature groups from metadata, so we skip
    group aggregates. Era stats still apply.

    Returns (all_features, era_stat_features).
    """
    all_features = list(feature_cols)

    if settings.enable_era_stats:
        if era_stat_features is None:
            n = min(settings.era_stats_top_n, len(feature_cols))
            variances = df[feature_cols].var().nlargest(n)
            era_stat_features = variances.index.tolist()

        add_era_stats(df, era_stat_features, settings.era_col)
        era_derived = [c for c in df.columns if "_era_" in c]
        all_features.extend(era_derived)

    return all_features, era_stat_features


def _rank_normalize(series: pd.Series) -> pd.Series:
    """Rank-normalize a Series to [0, 1]."""
    return series.rank(pct=True, method="average")


def _ensemble_predictions(
    predictions: Dict[str, pd.Series],
) -> pd.Series:
    """Rank-average ensemble across multiple target models."""
    if not predictions:
        raise ValueError("No predictions to ensemble")

    if len(predictions) == 1:
        return next(iter(predictions.values()))

    ranked = pd.DataFrame({
        name: _rank_normalize(preds)
        for name, preds in predictions.items()
    })
    ensemble = ranked.mean(axis=1)
    ensemble.name = "prediction"
    return ensemble


def run_signals_training(
    output_dir: str = "./output",
    skip_download: bool = False,
    upload: bool = False,
    progress_callback: Optional[Callable[[dict], None]] = None,
    epoch_callback: Optional[Callable[[dict], None]] = None,
    model_type: str = "lgbm",
    neutralization_pct: float = 50.0,
    neutralizer_aware: bool = True,
    sample_weight_aware: bool = True,
) -> dict:
    """Full Signals training pipeline.

    Args:
        output_dir: Directory for output files
        skip_download: Skip data download if True
        upload: Upload to Numerai Signals after training
        progress_callback: Callback for progress updates
        epoch_callback: Callback for epoch-level metrics
        model_type: Model type (lgbm/catboost)
        neutralization_pct: Neutralization proportion (0-100)
        neutralizer_aware: Use neutralizer matrix during training
        sample_weight_aware: Use sample weights during training

    Returns:
        Dict of validation metrics.
    """
    settings = get_ml_settings()
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    def _progress(step: str, progress_pct: float, **extra):
        if progress_callback:
            progress_callback({"step": step, "progress_pct": progress_pct, **extra})

    # 1. Download Signals data
    _progress("downloading", 5)
    if not skip_download:
        print("Step 1: Downloading Signals v2.1 data...")
        data_dir = download_signals_data()
    else:
        print("Step 1: Skipping download (using cached data)")
        data_dir = None

    # 2. Load training data and discover features/targets
    _progress("loading_data", 10)
    print("Step 2: Loading Signals training data...")

    # First load a small slice to discover columns
    train_df = load_signals_train(data_dir)
    feature_cols = get_signals_feature_columns(train_df)
    all_target_cols = get_signals_target_columns(train_df)

    print(f"  Discovered {len(feature_cols)} features, {len(all_target_cols)} targets")
    print(f"  Targets: {all_target_cols}")

    # Determine which targets to train on
    if settings.multi_target_enabled:
        target_cols = all_target_cols
    else:
        # Use first target as default
        target_cols = [all_target_cols[0]] if all_target_cols else ["target"]

    # Subsample eras for memory management
    if settings.max_train_eras > 0:
        all_eras = sorted(train_df[settings.era_col].unique())
        keep_eras = all_eras[-settings.max_train_eras:]
        train_df = train_df[train_df[settings.era_col].isin(keep_eras)]
        print(f"  Subsampled to {settings.max_train_eras} most recent eras")

    print(f"  Train: {train_df.shape[0]:,} rows, {train_df.shape[1]} columns")

    # 3. Load validation data
    print("Step 3: Loading validation data...")
    val_df = load_signals_validation(data_dir)

    if settings.max_train_eras > 0:
        val_eras = sorted(val_df[settings.era_col].unique())
        keep_val_eras = val_eras[-min(settings.max_train_eras, len(val_eras)):]
        val_df = val_df[val_df[settings.era_col].isin(keep_val_eras)]

    print(f"  Validation: {val_df.shape[0]:,} rows")

    # 4. Load neutralizer and sample weights if requested
    _progress("loading_extras", 12)
    train_neutralizer = None
    train_sample_weights = None

    if neutralizer_aware:
        print("Step 3b: Loading neutralizer matrix...")
        train_neutralizer = load_signals_neutralizer("train", data_dir)
        if train_neutralizer is not None:
            # Align indices
            common_idx = train_df.index.intersection(train_neutralizer.index)
            train_neutralizer = train_neutralizer.loc[common_idx]
            print(f"  Neutralizer: {train_neutralizer.shape[1]} columns, {len(common_idx):,} rows")
        else:
            print("  Neutralizer matrix not found, skipping")

    if sample_weight_aware:
        print("Step 3c: Loading sample weights...")
        train_sample_weights = load_signals_sample_weights("train", data_dir)
        if train_sample_weights is not None:
            common_idx = train_df.index.intersection(train_sample_weights.index)
            train_sample_weights = train_sample_weights.loc[common_idx]
            print(f"  Sample weights: {len(common_idx):,} rows")
        else:
            print("  Sample weights not found, skipping")

    # Filter to targets actually present in data
    available_targets = [t for t in target_cols if t in train_df.columns]
    skipped_targets = [t for t in target_cols if t not in train_df.columns]
    if skipped_targets:
        print(f"  Skipping targets not in data: {skipped_targets}")
    print(f"  Training targets: {available_targets}")

    # 5. Feature engineering
    _progress("feature_engineering", 15)
    print("Step 4: Feature engineering...")

    all_features, era_stat_features = _apply_feature_engineering(
        train_df, feature_cols, settings
    )
    _apply_feature_engineering(
        val_df, feature_cols, settings,
        era_stat_features=era_stat_features,
    )
    print(f"  Total features after engineering: {len(all_features)}")

    # 6. Multi-target training
    print("Step 5: Training models...")
    models = {}
    train_infos = {}
    val_predictions = {}
    global_epoch_offset = 0

    for target_idx, target in enumerate(available_targets):
        target_nans = train_df[target].isna().sum()
        if target_nans > len(train_df) * 0.5:
            print(f"  Skipping {target} ({target_nans} NaN rows)")
            continue

        _progress(
            "training", 20 + (60 * target_idx / len(available_targets)),
            target=target, target_idx=target_idx, total_targets=len(available_targets),
        )
        print(f"  Training on {target}...")

        mask = train_df[target].notna()
        train_subset = train_df[mask].copy()

        # Build sample weight array aligned with train_subset
        sw_array = None
        if train_sample_weights is not None:
            sw_common = train_subset.index.intersection(train_sample_weights.index)
            weight_col_name = train_sample_weights.columns[0]
            weights = pd.Series(1.0, index=train_subset.index)
            if len(sw_common) > 0:
                weights.loc[sw_common] = train_sample_weights.loc[sw_common, weight_col_name]
            sw_array = weights.values

        # Wrap epoch_callback
        target_epoch_cb = None
        if epoch_callback:
            _offset = global_epoch_offset
            _target = target
            _tidx = target_idx
            _total = len(available_targets)
            def target_epoch_cb(info, _o=_offset, _t=_target, _ti=_tidx, _tot=_total):
                info["target"] = _t
                info["target_idx"] = _ti
                info["total_targets"] = _tot
                info["global_epoch"] = _o + info["epoch"]
                epoch_callback(info)

        model = create_model(
            model_type=model_type,
            num_leaves=settings.default_num_leaves,
            max_depth=settings.default_max_depth,
            learning_rate=settings.default_learning_rate,
            n_estimators=settings.default_num_rounds,
            feature_fraction=settings.default_feature_fraction,
            bagging_fraction=settings.default_bagging_fraction,
            early_stopping_rounds=settings.early_stopping_rounds,
        )

        info = model.fit(
            train_subset, all_features, target, settings.era_col,
            epoch_callback=target_epoch_cb,
            sample_weight=sw_array,
        )
        models[target] = model
        train_infos[target] = info
        global_epoch_offset += info["best_iteration"]
        print(f"    Best iteration: {info['best_iteration']}")

        # Validation predictions
        val_mask = val_df[target].notna()
        val_predictions[target] = model.predict(val_df[val_mask], all_features)

        # Save individual model
        model_path = output_path / f"model_{target}"
        model.save(model_path)

    if not models:
        raise RuntimeError("No models were trained — check target columns")

    # 7. Ensemble
    print("Step 6: Ensemble predictions...")
    common_idx = val_df.index
    for preds in val_predictions.values():
        common_idx = common_idx.intersection(preds.index)

    aligned_preds = {
        name: preds.loc[common_idx]
        for name, preds in val_predictions.items()
    }
    ensemble_preds = _ensemble_predictions(aligned_preds)

    # 8. Neutralization
    _progress("neutralization", 82)
    print("Step 7: Neutralization...")
    val_common = val_df.loc[common_idx].copy()
    val_common["prediction"] = ensemble_preds.values

    neutralization_proportion = neutralization_pct / 100.0

    # Use the Signals neutralizer matrix if available, else fall back to feature-based
    val_neutralizer = None
    if neutralizer_aware:
        val_neutralizer = load_signals_neutralizer("validation", data_dir)

    if val_neutralizer is not None and neutralization_proportion > 0:
        neut_common = val_common.index.intersection(val_neutralizer.index)
        if len(neut_common) > 0:
            neut_cols = val_neutralizer.columns.tolist()
            for col in neut_cols:
                val_common.loc[neut_common, col] = val_neutralizer.loc[neut_common, col]
            val_common["prediction"] = neutralize_features(
                val_common.loc[neut_common],
                "prediction",
                neut_cols,
                proportion=neutralization_proportion,
            )
            print(f"  Neutralized using Signals neutralizer ({len(neut_cols)} columns, "
                  f"proportion={neutralization_proportion:.0%})")
    elif neutralization_proportion > 0:
        # Fallback: neutralize against top features
        neutralizer_cols = feature_cols[:settings.neutralization_top_n]
        neutralizer_cols = [c for c in neutralizer_cols if c in val_common.columns]
        if neutralizer_cols:
            val_common["prediction"] = neutralize_features(
                val_common,
                "prediction",
                neutralizer_cols,
                proportion=neutralization_proportion,
            )
            print(f"  Neutralized against {len(neutralizer_cols)} features (fallback)")

    # 9. Validation metrics (including Signals Alpha)
    _progress("validation", 85)
    print("Step 8: Validation metrics...")

    # Load validation neutralizer + sample weights for Alpha metric
    val_sample_weights = None
    if sample_weight_aware:
        val_sample_weights = load_signals_sample_weights("validation", data_dir)
        if val_sample_weights is not None:
            print(f"  Validation sample weights: {val_sample_weights.shape[0]:,} rows")

    # Load example predictions for benchmarking
    example_preds = None
    try:
        example_path = (data_dir or Path(__file__).parent.parent / "signals_data_cache") / "validation_example_preds.parquet"
        if example_path.exists():
            example_preds = pd.read_parquet(example_path)
            print(f"  Example predictions loaded: {example_preds.shape[0]:,} rows")
    except Exception as e:
        print(f"  Example predictions not available: {e}")

    # Use first target as primary for metrics
    primary_target = available_targets[0]
    metrics = compute_all_metrics(
        val_common, "prediction", primary_target, settings.era_col,
        neutralizer=val_neutralizer,
        sample_weights=val_sample_weights,
        example_preds=example_preds,
    )
    print(f"  Ensemble metrics: {json.dumps(metrics, indent=2)}")
    if "signals_alpha" in metrics:
        print(f"  Signals Alpha: {metrics['signals_alpha']:.6f}")
    if "vs_example" in metrics:
        vs = metrics["vs_example"]
        print(f"  vs Example: ours={vs.get('our_correlation', 0):.6f}, "
              f"example={vs.get('example_correlation', 0):.6f}, "
              f"delta={vs.get('delta', 0):+.6f}")

    per_target_metrics = {}
    for target, preds in val_predictions.items():
        target_df = val_df.loc[preds.index].copy()
        target_df["prediction"] = preds.values
        per_target_metrics[target] = compute_all_metrics(
            target_df, "prediction", target, settings.era_col,
        )

    all_metrics = {
        "ensemble": metrics,
        "per_target": per_target_metrics,
        "tournament": "signals",
        "data_version": "v2.1",
        "n_features": len(all_features),
        "n_models": len(models),
        "neutralizer_aware": neutralizer_aware,
        "sample_weight_aware": sample_weight_aware,
        "training_info": {k: {"best_iteration": v["best_iteration"]} for k, v in train_infos.items()},
    }

    with open(output_path / "metrics.json", "w") as f:
        json.dump(all_metrics, f, indent=2)

    # Save inference config so inference.py can replay the pipeline
    inference_config = {
        "feature_set": "signals_v2.1",
        "feature_cols": feature_cols,
        "era_stat_features": era_stat_features,
        "neutralization_pct": neutralization_pct,
        "neutralization_top_n": settings.neutralization_top_n,
        "targets": list(models.keys()),
        "model_type": model_type,
        "tournament": "signals",
        "enable_era_stats": settings.enable_era_stats,
        "enable_group_aggregates": settings.enable_group_aggregates,
        "neutralizer_aware": neutralizer_aware,
        "sample_weight_aware": sample_weight_aware,
    }
    with open(output_path / "inference_config.json", "w") as f:
        json.dump(inference_config, f, indent=2)

    # 10. Live predictions + submission
    _progress("live_predictions", 90)
    print("Step 9: Live predictions...")
    csv_path = None
    try:
        live_df = load_signals_live(data_dir)
        print(f"  Live data: {live_df.shape[0]:,} rows")

        _apply_feature_engineering(
            live_df, feature_cols, settings,
            era_stat_features=era_stat_features,
        )

        live_predictions = {}
        for target, model in models.items():
            live_predictions[target] = model.predict(live_df, all_features)

        live_ensemble = _ensemble_predictions(live_predictions)

        # Neutralize live predictions
        if neutralization_proportion > 0:
            live_df_copy = live_df.copy()
            live_df_copy["prediction"] = live_ensemble.values
            neutralizer_cols = feature_cols[:settings.neutralization_top_n]
            neutralizer_cols = [c for c in neutralizer_cols if c in live_df_copy.columns]
            if neutralizer_cols:
                live_ensemble = neutralize_features(
                    live_df_copy,
                    "prediction",
                    neutralizer_cols,
                    proportion=neutralization_proportion,
                )

        csv_path = generate_submission(live_ensemble, output_path)
        print(f"  Submission written: {csv_path}")

    except FileNotFoundError:
        print("  No live data found — skipping submission generation")

    # 11. Optional upload via SignalsAPI
    if upload and csv_path:
        if not settings.numerai_public_id or not settings.numerai_secret_key:
            print("  Upload requested but credentials not set "
                  "(ML_NUMERAI_PUBLIC_ID / ML_NUMERAI_SECRET_KEY)")
        else:
            _progress("uploading", 95)
            print("Step 10: Uploading to Numerai Signals...")
            try:
                from numerapi import SignalsAPI
                signals_api = SignalsAPI(
                    public_id=settings.numerai_public_id,
                    secret_key=settings.numerai_secret_key,
                )
                sid = signals_api.upload_predictions(
                    str(csv_path),
                    model_id=settings.numerai_model_id,
                )
                print(f"  Uploaded! Submission ID: {sid}")
            except Exception as e:
                print(f"  Upload failed: {e}")

    _progress("completed", 100)
    print("Done.")
    return all_metrics
