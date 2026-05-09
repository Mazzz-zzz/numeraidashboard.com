"""Inference-only pipeline for Numerai live submissions.

Loads a pre-trained model artifact from disk (extracted from S3),
downloads live data, applies the same feature engineering as training,
predicts, rank-normalizes, and uploads to Numerai.

Used by bootstrap.py in inference mode when triggered by webhook/manual submit.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))

from data.download import (
    download_current_round,
    get_current_round,
    get_feature_set,
    load_feature_metadata,
    load_live_data,
)
from data.features import (
    add_era_stats,
    add_group_aggregates,
    discover_feature_groups,
    neutralize_features,
)
from models import create_model
from training.submission import generate_submission, upload_submission, validate_submission


def run_inference(
    model_dir: str,
    numerai_public_id: str,
    numerai_secret_key: str,
    numerai_model_id: str,
    progress_callback: Optional[Callable[[dict], None]] = None,
) -> dict:
    """Run inference on live data using a pre-trained model.

    The model_dir must contain:
    - inference_config.json (saved during training)
    - model_<target>/model.txt + meta.json for each target

    Args:
        model_dir: Path to extracted model artifact directory.
        numerai_public_id: Numerai API public ID.
        numerai_secret_key: Numerai API secret key.
        numerai_model_id: Numerai model slot ID.
        progress_callback: Optional callback for progress updates.

    Returns:
        Dict with submission_id, round_number, and status.
    """
    model_path = Path(model_dir)

    def _progress(step: str, pct: float, **extra):
        if progress_callback:
            progress_callback({"step": step, "progress_pct": pct, **extra})

    # 1. Load inference config
    _progress("loading_config", 5)
    config_path = model_path / "inference_config.json"
    if not config_path.exists():
        raise FileNotFoundError(
            f"No inference_config.json in {model_path}. "
            "Model was trained before inference support was added."
        )

    with open(config_path) as f:
        config = json.load(f)

    feature_set_name = config["feature_set"]
    feature_cols = config["feature_cols"]
    era_stat_features = config.get("era_stat_features")
    neutralization_pct = config.get("neutralization_pct", 25.0)
    targets = config["targets"]
    model_type = config.get("model_type", "lgbm")
    tournament = config.get("tournament", "classic")
    enable_era_stats = config.get("enable_era_stats", True)
    enable_group_aggregates = config.get("enable_group_aggregates", True)
    neutralization_top_n = config.get("neutralization_top_n", 50)
    saved_neutralizer_cols = config.get("neutralizer_cols")  # exposure-based, saved from training

    print(f"Inference config: {len(targets)} targets, {len(feature_cols)} features, "
          f"feature_set={feature_set_name}, model_type={model_type}")

    # 2. Download live data
    _progress("downloading", 10)
    print("Downloading live data...")
    data_dir = download_current_round()

    try:
        round_num = get_current_round()
    except Exception:
        round_num = None
    print(f"  Current round: {round_num}")

    # 3. Load live data
    _progress("loading_data", 30)
    print("Loading live data...")
    era_col = "era"
    live_cols = list(feature_cols) + [era_col]
    # Only load columns that exist in the live parquet
    live_df = load_live_data(data_dir)
    available_cols = [c for c in live_cols if c in live_df.columns]
    live_df = live_df[available_cols]
    print(f"  Live data: {live_df.shape[0]:,} rows, {live_df.shape[1]} columns")

    # 4. Feature engineering (same as training)
    _progress("feature_engineering", 40)
    print("Feature engineering...")
    all_features = list(feature_cols)

    if enable_era_stats and era_stat_features:
        present_era_stat = [c for c in era_stat_features if c in live_df.columns]
        if present_era_stat:
            add_era_stats(live_df, present_era_stat, era_col)
            era_derived = [c for c in live_df.columns if "_era_" in c]
            all_features.extend(era_derived)

    if enable_group_aggregates:
        try:
            metadata = load_feature_metadata(data_dir)
            feature_groups = discover_feature_groups(metadata, feature_cols)
            if feature_groups:
                add_group_aggregates(live_df, feature_groups)
                group_derived = [c for c in live_df.columns if c.startswith("group_")]
                all_features.extend(c for c in group_derived if c not in all_features)
        except Exception as e:
            print(f"  Group aggregates skipped: {e}")

    # Filter to features that actually exist in the DataFrame
    all_features = [f for f in all_features if f in live_df.columns]
    print(f"  Total features for prediction: {len(all_features)}")

    # 5. Load models and predict
    _progress("predicting", 60)
    print("Loading models and predicting...")
    live_predictions: Dict[str, pd.Series] = {}

    for target in targets:
        target_model_path = model_path / f"model_{target}"
        if not target_model_path.exists():
            print(f"  Skipping {target} (no model directory)")
            continue

        model = create_model(model_type=model_type)
        model.load(target_model_path)
        preds = model.predict(live_df, all_features)
        live_predictions[target] = preds
        print(f"  {target}: predicted {len(preds):,} rows")

    if not live_predictions:
        raise RuntimeError("No models found in artifact — nothing to predict")

    # 6. Ensemble
    _progress("ensemble", 75)
    print("Ensemble predictions...")
    if len(live_predictions) == 1:
        ensemble = next(iter(live_predictions.values()))
    else:
        ranked = pd.DataFrame({
            name: preds.rank(pct=True, method="average")
            for name, preds in live_predictions.items()
        })
        ensemble = ranked.mean(axis=1)
        ensemble.name = "prediction"

    # 7. Neutralize
    _progress("neutralization", 80)
    neutralization_proportion = neutralization_pct / 100.0
    if saved_neutralizer_cols:
        neutralizer_cols = [c for c in saved_neutralizer_cols if c in live_df.columns]
    else:
        neutralizer_cols = feature_cols[:neutralization_top_n]
        neutralizer_cols = [c for c in neutralizer_cols if c in live_df.columns]

    if neutralizer_cols and neutralization_proportion > 0:
        print(f"Neutralizing against {len(neutralizer_cols)} features "
              f"(proportion={neutralization_proportion:.0%})...")
        live_df_copy = live_df.copy()
        live_df_copy["prediction"] = ensemble.values
        ensemble = neutralize_features(
            live_df_copy, "prediction", neutralizer_cols,
            proportion=neutralization_proportion,
            era_col="era",
        )

    # 8. Generate submission
    _progress("submission", 85)
    print("Generating submission...")
    output_dir = model_path / "inference_output"
    csv_path = generate_submission(ensemble, output_dir, round_num)
    validate_submission(csv_path, expected_ids=live_df.index)
    print(f"  Submission CSV: {csv_path}")

    # 9. Upload to Numerai
    _progress("uploading", 90)
    print(f"Uploading to Numerai (model_id={numerai_model_id})...")
    submission_id = upload_submission(
        csv_path, numerai_public_id, numerai_secret_key, numerai_model_id,
    )
    print(f"  Submission ID: {submission_id}")

    _progress("completed", 100)
    result = {
        "submission_id": submission_id,
        "round_number": round_num,
        "n_predictions": len(ensemble),
        "n_models": len(live_predictions),
        "targets": list(live_predictions.keys()),
        "status": "submitted",
    }
    print(f"Inference complete: {json.dumps(result)}")
    return result
