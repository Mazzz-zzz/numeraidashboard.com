"""CLI entry point for Numerai training pipeline.

Usage:
    python -m training.trainer --feature-set medium --output ./output
    python -m training.trainer --feature-set small --output ./output --upload

Pipeline:
    1. Download data (anonymous, no credentials needed)
    2. Load feature metadata and select feature set
    3. Load data with column filtering (RAM-efficient)
    4. Feature engineering (era stats, group aggregates)
    5. Multi-target LightGBM training
    6. Ensemble (rank-average across target models)
    7. Feature neutralization
    8. Validation metrics
    9. Live predictions + submission CSV
"""

from __future__ import annotations

import argparse
import gc
import json
import sys
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np
import pandas as pd

# Add ml/ to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from config.settings import get_ml_settings
from data.download import (
    download_current_round,
    get_current_round,
    get_feature_set,
    load_benchmark_models,
    load_example_predictions,
    load_feature_metadata,
    load_live_data,
    load_meta_model,
    load_train_data,
    load_validation_data,
)
from data.features import (
    add_era_stats,
    add_group_aggregates,
    discover_feature_groups,
    get_feature_columns,
    neutralize_features,
)
from models import create_model
from training.submission import generate_submission, validate_submission
from training.validate import compute_all_metrics, per_era_correlation, top_exposure_features


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
    feature_groups: Dict[str, List[str]],
    settings,
    era_stat_features: Optional[List[str]] = None,
) -> tuple:
    """Apply feature engineering in-place.

    Returns (all_features, era_stat_features) so the same era_stat_features
    can be passed when engineering validation/live data.
    """
    all_features = list(feature_cols)

    if settings.enable_era_stats:
        if era_stat_features is None:
            # Compute top N features by variance (only from training data)
            n = min(settings.era_stats_top_n, len(feature_cols))
            variances = df[feature_cols].var().nlargest(n)
            era_stat_features = variances.index.tolist()

        add_era_stats(df, era_stat_features, settings.era_col)
        era_derived = [c for c in df.columns if "_era_" in c]
        all_features.extend(era_derived)

    if settings.enable_group_aggregates and feature_groups:
        add_group_aggregates(df, feature_groups)
        group_derived = [c for c in df.columns if c.startswith("group_")]
        all_features.extend(c for c in group_derived if c not in all_features)

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


def run_training(
    feature_set_name: str = "medium",
    output_dir: str = "./output",
    skip_download: bool = False,
    upload: bool = False,
    progress_callback: Optional[Callable[[dict], None]] = None,
    epoch_callback: Optional[Callable[[dict], None]] = None,
    model_type: str = "lgbm",
    neutralization_pct: float = 25.0,
    model_kwargs: Optional[Dict] = None,
    target: Optional[str] = None,
) -> dict:
    """Full training pipeline.

    Args:
        feature_set_name: Feature set to use (small/medium/all)
        output_dir: Directory for output files
        skip_download: Skip data download if True
        upload: Upload to Numerai after training
        progress_callback: Callback for progress updates
        epoch_callback: Callback for epoch-level metrics
        model_type: Model type (lgbm/catboost/mlp/ft_transformer)
        neutralization_pct: Neutralization proportion (0-100)
        model_kwargs: Extra kwargs passed to create_model (e.g. dropout, mixup_alpha)
        target: Target override. A single target name (e.g. "target_ender_20") or
            comma-separated list (e.g. "target_ender_20,target_jasper_20").
            If None, uses settings (multi_target_enabled / single_target_mode).

    Returns:
        Dict of validation metrics.
    """
    if model_kwargs is None:
        model_kwargs = {}
    settings = get_ml_settings()
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    def _progress(step: str, progress_pct: float, **extra):
        if progress_callback:
            progress_callback({"step": step, "progress_pct": progress_pct, **extra})

    # 1. Download data
    round_num = None
    _progress("downloading", 5)
    if not skip_download:
        print("Step 1: Downloading Numerai data...")
        data_dir = download_current_round()
    else:
        print("Step 1: Skipping download (using cached data)")
        data_dir = None  # uses default DATA_DIR

    # 2. Feature metadata
    _progress("loading_metadata", 10)
    print("Step 2: Loading feature metadata...")
    metadata = load_feature_metadata(data_dir)
    feature_cols = get_feature_set(metadata, feature_set_name)
    print(f"  Feature set '{feature_set_name}': {len(feature_cols)} features")

    # Determine which targets to train on
    if target:
        target_cols = [t.strip() for t in target.split(",")]
        # Use first target for scoring/validation
        settings.target_col = target_cols[0]
        print(f"  Target override: {target_cols} (scoring against {settings.target_col})")
    elif settings.single_target_mode:
        target_cols = [settings.target_col]
        print(f"  Single-target mode: {settings.target_col}")
    elif settings.multi_target_enabled:
        target_cols = settings.target_cols
    else:
        target_cols = [settings.target_col]

    # 3. Load data with column filtering
    #    Read era column first to determine which eras to keep, then load
    #    only those rows — avoids loading the full dataset into memory.
    print("Step 3: Loading training data...")
    load_cols = _build_columns_to_load(feature_cols, target_cols, settings.era_col)

    if settings.max_train_eras > 0:
        # Read only the era column to pick eras before loading all features
        era_only = load_train_data(data_dir, columns=[settings.era_col])
        all_eras = sorted(era_only[settings.era_col].unique())
        del era_only
        gc.collect()
        keep_eras = set(all_eras[-settings.max_train_eras:])
        print(f"  Subsampling to {len(keep_eras)} most recent train eras")

        train_df = load_train_data(data_dir, columns=load_cols)
        train_df = train_df[train_df[settings.era_col].isin(keep_eras)]
    else:
        train_df = load_train_data(data_dir, columns=load_cols)

    print(f"  Train: {train_df.shape[0]:,} rows, {train_df.shape[1]} columns")

    # Cap validation to 200 eras (validation set can be very large)
    max_val_eras = min(settings.max_train_eras, 200) if settings.max_train_eras > 0 else 0
    if max_val_eras > 0:
        val_era_only = load_validation_data(data_dir, columns=[settings.era_col])
        val_all_eras = sorted(val_era_only[settings.era_col].unique())
        del val_era_only
        gc.collect()
        keep_val_eras = set(val_all_eras[-max_val_eras:])
        print(f"  Subsampling to {len(keep_val_eras)} most recent val eras")

        val_df = load_validation_data(data_dir, columns=load_cols)
        val_df = val_df[val_df[settings.era_col].isin(keep_val_eras)]
    else:
        val_df = load_validation_data(data_dir, columns=load_cols)

    print(f"  Validation: {val_df.shape[0]:,} rows")

    # Filter to targets actually present in data
    available_targets = [t for t in target_cols if t in train_df.columns]
    skipped_targets = [t for t in target_cols if t not in train_df.columns]
    if skipped_targets:
        print(f"  Skipping targets not in data: {skipped_targets}")
    print(f"  Training targets: {available_targets}")

    # 4. Feature engineering
    _progress("feature_engineering", 15)
    print("Step 4: Feature engineering...")
    feature_groups = discover_feature_groups(metadata, feature_cols)
    print(f"  Found {len(feature_groups)} feature groups")

    all_features, era_stat_features = _apply_feature_engineering(
        train_df, feature_cols, feature_groups, settings
    )
    _apply_feature_engineering(
        val_df, feature_cols, feature_groups, settings,
        era_stat_features=era_stat_features,
    )
    print(f"  Total features after engineering: {len(all_features)}")

    # 5. Multi-target training
    print("Step 5: Training models...")
    models = {}
    train_infos = {}
    val_predictions = {}
    global_epoch_offset = 0

    # Check if multi-head MLP mode is requested
    use_multi_head = (
        model_type == "mlp"
        and model_kwargs.get("multi_head", False)
        and len(available_targets) > 1
    )
    # Coerce string "true"/"false" from CLI
    if isinstance(use_multi_head, str):
        use_multi_head = use_multi_head.lower() in ("true", "1", "yes")

    if use_multi_head:
        # ── Multi-head MLP: one model, all targets ──
        print(f"  Multi-head MLP: training on {len(available_targets)} targets simultaneously")
        _progress("training", 20, target="multi_head", target_idx=0,
                  total_targets=len(available_targets))

        # Drop rows where ALL targets are NaN
        target_mask = train_df[available_targets].notna().any(axis=1)
        train_subset = train_df[target_mask].copy()
        # Fill remaining NaN targets with 0 (multi-head needs all columns)
        train_subset[available_targets] = train_subset[available_targets].fillna(0)

        val_target_mask = val_df[available_targets].notna().any(axis=1)
        val_subset = val_df[val_target_mask].copy()
        val_subset[available_targets] = val_subset[available_targets].fillna(0)

        mh_cb = None
        if epoch_callback:
            def mh_cb(info):
                info["target"] = "multi_head"
                info["target_idx"] = 0
                info["total_targets"] = len(available_targets)
                info["global_epoch"] = info["epoch"]
                epoch_callback(info)

        model = create_model(
            model_type=model_type,
            learning_rate=settings.default_learning_rate,
            n_estimators=settings.default_num_rounds,
            early_stopping_rounds=settings.early_stopping_rounds,
            **model_kwargs,
        )

        info = model.fit_multi_head(
            train_subset, all_features, available_targets, settings.era_col,
            epoch_callback=mh_cb,
            val_df=val_subset,
        )
        train_infos["multi_head"] = info
        print(f"    Best iteration: {info['best_iteration']}")

        # Generate per-target val predictions from each head
        for tidx, target in enumerate(available_targets):
            val_mask = val_df[target].notna()
            val_predictions[target] = model.predict(
                val_df[val_mask], all_features, target_idx=tidx,
            )
            models[target] = model  # same model object for all targets

        model.save(output_path / "model_multi_head")

    else:
        # ── Standard: one model per target ──
        for target_idx, target in enumerate(available_targets):
            # Skip targets with too many NaNs
            target_nans = train_df[target].isna().sum()
            if target_nans > len(train_df) * 0.5:
                print(f"  Skipping {target} ({target_nans} NaN rows)")
                continue

            _progress(
                "training", 20 + (60 * target_idx / len(available_targets)),
                target=target, target_idx=target_idx, total_targets=len(available_targets),
            )
            print(f"  Training on {target}...")
            # Drop rows with NaN target for this model
            mask = train_df[target].notna()
            train_subset = train_df[mask]

            # Build val subset for this target (real Numerai validation data)
            val_mask = val_df[target].notna() if target in val_df.columns else None
            val_subset = val_df[val_mask] if val_mask is not None else None

            # Wrap epoch_callback to add target name, global epoch,
            # and per-era correlation every 10 epochs
            target_epoch_cb = None
            if epoch_callback:
                _offset = global_epoch_offset
                _target = target
                _tidx = target_idx
                _total = len(available_targets)
                _val_sub = val_subset
                _feats = all_features
                _era_col = settings.era_col
                _is_icl_model = model_type in ("tabpfn", "tabicl")
                def target_epoch_cb(info, _o=_offset, _t=_target, _ti=_tidx,
                                    _tot=_total, _vs=_val_sub, _f=_feats, _ec=_era_col,
                                    _icl=_is_icl_model):
                    info["target"] = _t
                    info["target_idx"] = _ti
                    info["total_targets"] = _tot
                    info["global_epoch"] = _o + info["epoch"]
                    # Compute per-era correlation:
                    # - ICL models: at the last bag (when val_loss is set by the model)
                    # - Other models: every 10 global epochs
                    # ICL models: skip redundant predict — val_loss is already
                    # computed inside fit() and the full predict happens once
                    # after training at line ~412
                    should_compute = (
                        (False if _icl else info["global_epoch"] % 10 == 0)
                        and _vs is not None and model is not None
                    )
                    if should_compute:
                        try:
                            _preds = model.predict(_vs, _f)
                            _tmp = _vs[[_ec, _t]].copy()
                            _tmp["_pred"] = _preds.values
                            _era_corrs = per_era_correlation(_tmp, "_pred", _t, _ec)
                            _mean_corr = float(_era_corrs.mean())
                            _sharpe = float(_era_corrs.mean() / _era_corrs.std()) if _era_corrs.std() > 0 else 0.0
                            info["correlation"] = _mean_corr
                            info["sharpe"] = _sharpe
                        except Exception:
                            pass  # Don't fail training over metrics
                    epoch_callback(info)

            model = create_model(
                model_type=model_type,
                num_leaves=settings.default_num_leaves,
                max_depth=settings.default_max_depth,
                learning_rate=settings.default_learning_rate,
                n_estimators=settings.default_num_rounds,
                feature_fraction=settings.default_feature_fraction,
                bagging_fraction=settings.default_bagging_fraction,
                min_data_in_leaf=settings.default_min_data_in_leaf,
                reg_alpha=settings.default_reg_alpha,
                reg_lambda=settings.default_reg_lambda,
                min_split_gain=settings.default_min_split_gain,
                path_smooth=settings.default_path_smooth,
                max_bin=settings.default_max_bin,
                early_stopping_rounds=settings.early_stopping_rounds,
                **model_kwargs,
            )

            info = model.fit(
                train_subset, all_features, target, settings.era_col,
                epoch_callback=target_epoch_cb,
                val_df=val_subset,
            )
            train_infos[target] = info
            global_epoch_offset += info["best_iteration"]
            print(f"    Best iteration: {info['best_iteration']}")

            # Validation predictions
            val_mask = val_df[target].notna()
            val_predictions[target] = model.predict(val_df[val_mask], all_features)

            # Save individual model
            model_path = output_path / f"model_{target}"
            model.save(model_path)

            # For GPU-heavy in-context models, evict from memory immediately
            # to avoid OOM when training subsequent targets. Store path for
            # lazy reload at live-prediction time.
            _is_icl = model_type in ("tabpfn", "tabicl")
            if _is_icl:
                del model
                gc.collect()
                try:
                    import torch
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                except ImportError:
                    pass
                models[target] = model_path  # path sentinel for lazy reload
                print(f"    [ICL] Evicted model from memory (saved to {model_path})")
            else:
                models[target] = model

    # Free training data — no longer needed after all models are fitted
    del train_df
    gc.collect()

    if not models:
        raise RuntimeError("No models were trained — check target columns")

    if settings.single_target_mode:
        # Single-target: skip filtering/ensemble, use the one model directly
        only_target = list(val_predictions.keys())[0]
        only_preds = val_predictions[only_target]
        common_idx = only_preds.index
        ensemble_preds = only_preds
        print(f"  Single-target mode: using {only_target} directly (no ensemble)")
    else:
        # 5b. Filter weak targets from ensemble
        print("Step 5b: Filtering weak targets...")
        target_corrs = {}
        for target, preds in val_predictions.items():
            target_df_tmp = val_df.loc[preds.index].copy()
            target_df_tmp["_pred"] = preds.values
            era_corrs = per_era_correlation(target_df_tmp, "_pred", target, settings.era_col)
            mean_corr = float(era_corrs.mean())
            target_corrs[target] = mean_corr
            print(f"  {target}: mean_corr={mean_corr:.6f}")

        # ICL models (TabICL, TabPFN) produce weaker per-target correlations
        # but valuable orthogonal signal — use a much lower threshold to keep
        # more targets in the ensemble.
        _is_icl = model_type in ("tabicl", "tabpfn")
        min_corr = 0.001 if _is_icl else settings.min_target_correlation
        if _is_icl:
            print(f"  ICL model: using relaxed min_target_correlation={min_corr}")
        strong_targets = {t: c for t, c in target_corrs.items() if c >= min_corr}
        if not strong_targets:
            best = max(target_corrs, key=target_corrs.get)
            strong_targets = {best: target_corrs[best]}
            print(f"  All targets below threshold — keeping best: {best}")

        dropped = set(target_corrs) - set(strong_targets)
        if dropped:
            print(f"  Dropped {len(dropped)} weak targets: {sorted(dropped)}")
            for t in dropped:
                del val_predictions[t]
                del models[t]
        print(f"  Ensemble uses {len(strong_targets)} targets: {sorted(strong_targets.keys())}")

        # 6. Ensemble
        print("Step 6: Ensemble predictions...")
        common_idx = val_df.index
        for preds in val_predictions.values():
            common_idx = common_idx.intersection(preds.index)

        aligned_preds = {
            name: preds.loc[common_idx]
            for name, preds in val_predictions.items()
        }
        ensemble_preds = _ensemble_predictions(aligned_preds)

    # 7. Neutralization
    _progress("neutralization", 82)
    print("Step 7: Feature neutralization...")
    val_common = val_df.loc[common_idx].copy()
    val_common["prediction"] = ensemble_preds.values

    # Select neutralizer features by actual exposure (not alphabetically)
    neutralizer_cols = top_exposure_features(
        val_common, "prediction", feature_cols, settings.era_col,
        top_n=settings.neutralization_top_n,
    )
    print(f"  Top {len(neutralizer_cols)} features by exposure selected for neutralization")

    # Convert percentage (0-100) to proportion (0-1)
    neutralization_proportion = neutralization_pct / 100.0

    if neutralizer_cols and neutralization_proportion > 0:
        val_common["prediction"] = neutralize_features(
            val_common,
            "prediction",
            neutralizer_cols,
            proportion=neutralization_proportion,
            era_col=settings.era_col,
        )
        print(f"  Neutralized against {len(neutralizer_cols)} features "
              f"(proportion={neutralization_proportion:.0%}, per-era)")

    # 8. Validation
    _progress("validation", 85)
    print("Step 8: Validation metrics...")

    # Load meta model and benchmarks for advanced validation
    meta_model_col = None
    benchmark_cols = None
    try:
        meta_df = load_meta_model(data_dir)
        if meta_df is not None:
            # Join meta model predictions (available era 1133+)
            common_ids = val_common.index.intersection(meta_df.index)
            if len(common_ids) > 0:
                val_common = val_common.loc[common_ids].copy()
                val_common["numerai_meta_model"] = meta_df.loc[common_ids, "numerai_meta_model"]
                meta_model_col = "numerai_meta_model"
                print(f"  Meta model joined: {len(common_ids):,} rows (era 1133+)")
    except Exception as e:
        print(f"  Meta model not available: {e}")

    try:
        bm_df = load_benchmark_models(data_dir)
        if bm_df is not None:
            common_ids = val_common.index.intersection(bm_df.index)
            if len(common_ids) > 0:
                bm_cols = [c for c in bm_df.columns if c.startswith("v52_lgbm_")]
                for col in bm_cols:
                    val_common.loc[common_ids, col] = bm_df.loc[common_ids, col]
                benchmark_cols = bm_cols
                print(f"  Benchmarks joined: {len(bm_cols)} models")
    except Exception as e:
        print(f"  Benchmarks not available: {e}")

    # Load example predictions for benchmarking
    example_preds = None
    try:
        example_preds = load_example_predictions("validation", data_dir)
        if example_preds is not None:
            print(f"  Example predictions loaded: {example_preds.shape[0]:,} rows")
    except Exception as e:
        print(f"  Example predictions not available: {e}")

    metrics = compute_all_metrics(
        val_common, "prediction", settings.target_col, settings.era_col,
        feature_cols=[c for c in neutralizer_cols if c in val_common.columns],
        meta_model_col=meta_model_col,
        benchmark_cols=benchmark_cols,
        example_preds=example_preds,
    )
    print(f"  Ensemble metrics: {json.dumps(metrics, indent=2)}")
    if "vs_example" in metrics:
        vs = metrics["vs_example"]
        print(f"  vs Example: ours={vs.get('our_correlation', 0):.6f}, "
              f"example={vs.get('example_correlation', 0):.6f}, "
              f"delta={vs.get('delta', 0):+.6f}")

    # Write a partial metrics.json *immediately* with just the ensemble.
    # If the per-target loop below OOMs or otherwise crashes, we still have
    # the headline metrics on disk. Without this, the entire tabm-combo sweep
    # of 2026-04-04 was marked FAILED rc=-9 because every run died after
    # printing metrics but before this write — see ml-analysis "harvest bug".
    all_metrics = {
        "ensemble": metrics,
        "per_target": {},
        "feature_set": feature_set_name,
        "n_features": len(all_features),
        "n_models": len(models),
        "training_info": {k: {"best_iteration": v["best_iteration"]} for k, v in train_infos.items()},
    }
    with open(output_path / "metrics.json", "w") as f:
        json.dump(all_metrics, f, indent=2)

    # Per-target metrics (skip feature_exposure — only needed for ensemble).
    # Build a minimal frame per target instead of copying the full val_df —
    # the .copy() was the memory peak that pushed the process past the cap.
    per_target_metrics = {}
    for target, preds in val_predictions.items():
        idx = preds.index
        minimal = pd.DataFrame({
            "prediction": preds.values,
            target: val_df.loc[idx, target].values,
            settings.era_col: val_df.loc[idx, settings.era_col].values,
        }, index=idx)
        per_target_metrics[target] = compute_all_metrics(
            minimal, "prediction", target, settings.era_col,
            feature_cols=[],
        )
        del minimal
    gc.collect()

    # Update metrics.json with per_target now that the loop succeeded
    all_metrics["per_target"] = per_target_metrics
    with open(output_path / "metrics.json", "w") as f:
        json.dump(all_metrics, f, indent=2)

    # Save inference config so inference.py can replay the pipeline
    inference_config = {
        "feature_set": feature_set_name,
        "feature_cols": feature_cols,
        "era_stat_features": era_stat_features,
        "neutralization_pct": neutralization_pct,
        "neutralization_top_n": settings.neutralization_top_n,
        "neutralizer_cols": neutralizer_cols,
        "targets": list(models.keys()),
        "model_type": model_type,
        "tournament": "classic",
        "enable_era_stats": settings.enable_era_stats,
        "enable_group_aggregates": settings.enable_group_aggregates,
    }
    with open(output_path / "inference_config.json", "w") as f:
        json.dump(inference_config, f, indent=2)

    # 9. Live predictions + submission
    _progress("live_predictions", 90)
    print("Step 9: Live predictions...")
    try:
        live_cols = _build_columns_to_load(feature_cols, [], settings.era_col)
        live_df = load_live_data(data_dir, columns=live_cols)
        print(f"  Live data: {live_df.shape[0]:,} rows")

        # Apply same feature engineering (use same era_stat_features as training)
        _apply_feature_engineering(
            live_df, feature_cols, feature_groups, settings,
            era_stat_features=era_stat_features,
        )

        # Predict with all models (reload ICL models one-at-a-time from disk)
        live_predictions = {}
        for target, model_or_path in models.items():
            if isinstance(model_or_path, Path):
                model = create_model(model_type=model_type, **model_kwargs)
                model.load(model_or_path)
            else:
                model = model_or_path
            live_predictions[target] = model.predict(live_df, all_features)
            if isinstance(model_or_path, Path):
                del model
                gc.collect()
                try:
                    import torch
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                except ImportError:
                    pass

        live_ensemble = _ensemble_predictions(live_predictions)

        # Neutralize live predictions (same cols and per-era as validation)
        if neutralizer_cols and neutralization_proportion > 0:
            live_df_copy = live_df.copy()
            live_df_copy["prediction"] = live_ensemble.values
            live_ensemble = neutralize_features(
                live_df_copy,
                "prediction",
                neutralizer_cols,
                proportion=neutralization_proportion,
                era_col=settings.era_col,
            )

        # Get round number
        try:
            round_num = get_current_round()
        except Exception:
            round_num = None

        csv_path = generate_submission(live_ensemble, output_path, round_num)
        validate_submission(csv_path, expected_ids=live_df.index)
        print(f"  Submission written: {csv_path}")

    except FileNotFoundError:
        print("  No live data found — skipping submission generation")
        csv_path = None

    # 10. Optional upload
    if upload and csv_path:
        if not settings.numerai_public_id or not settings.numerai_secret_key:
            print("  Upload requested but credentials not set "
                  "(ML_NUMERAI_PUBLIC_ID / ML_NUMERAI_SECRET_KEY)")
        else:
            from training.submission import upload_submission
            sid = upload_submission(
                csv_path,
                settings.numerai_public_id,
                settings.numerai_secret_key,
                settings.numerai_model_id,
            )
            print(f"  Uploaded! Submission ID: {sid}")

    _progress("completed", 100)
    print("Done.")
    return all_metrics


def main():
    parser = argparse.ArgumentParser(description="Numerai ML Training Pipeline")
    parser.add_argument(
        "--feature-set", default="medium",
        help="Feature set: small (42), medium (705), all (2376)",
    )
    parser.add_argument("--output", default="./output")
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument(
        "--upload", action="store_true",
        help="Upload submission to Numerai (requires credentials)",
    )
    parser.add_argument(
        "--model-type", default="lgbm",
        choices=["lgbm", "catboost", "mlp", "ft_transformer", "tabm", "modern_nca", "tabpfn", "tabicl"],
        help="Model type: lgbm, catboost, mlp, ft_transformer, tabm, modern_nca, tabpfn, or tabicl",
    )
    parser.add_argument(
        "--neutralization-pct", type=float, default=25.0,
        help="Neutralization percentage (0-100, default: 25)",
    )
    parser.add_argument(
        "--target", default=None,
        help="Target(s) to train on, e.g. 'target_ender_20' or "
             "'target_ender_20,target_jasper_20'. Default: use settings",
    )
    args = parser.parse_args()

    run_training(
        feature_set_name=args.feature_set,
        output_dir=args.output,
        skip_download=args.skip_download,
        upload=args.upload,
        model_type=args.model_type,
        neutralization_pct=args.neutralization_pct,
        target=args.target,
    )


if __name__ == "__main__":
    main()
