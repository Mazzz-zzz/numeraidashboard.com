"""Entrypoint for the dashboard-managed Prime Intellect worker image."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tarfile
import traceback
from pathlib import Path

import requests

ML_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_ROOT))

SETTING_ENV = {
    "num_rounds": "ML_DEFAULT_NUM_ROUNDS",
    "learning_rate": "ML_DEFAULT_LEARNING_RATE",
    "num_leaves": "ML_DEFAULT_NUM_LEAVES",
    "max_depth": "ML_DEFAULT_MAX_DEPTH",
    "max_train_eras": "ML_MAX_TRAIN_ERAS",
    "early_stopping_rounds": "ML_EARLY_STOPPING_ROUNDS",
    "single_target": "ML_SINGLE_TARGET_MODE",
    "single_target_mode": "ML_SINGLE_TARGET_MODE",
    "target_col": "ML_TARGET_COL",
    "target_cols": "ML_TARGET_COLS",
}

TOP_LEVEL = {
    "mode",
    "tournament",
    "model_type",
    "feature_set",
    "neutralization_pct",
    "upload",
    "target",
    "target_col",
    "target_cols",
    *SETTING_ENV,
}


def _load_config() -> dict:
    raw = os.environ.get("NUMERAI_RUN_CONFIG_JSON", "{}").strip() or "{}"
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("NUMERAI_RUN_CONFIG_JSON must contain a JSON object")
    return value


def _apply_settings(config: dict) -> None:
    for key, env_name in SETTING_ENV.items():
        if key in config:
            value = config[key]
            os.environ[env_name] = json.dumps(value) if isinstance(value, (list, dict, bool)) else str(value)


def _upload_artifact(archive: Path) -> str | None:
    upload_url = os.environ.get("NUMERAI_ARTIFACT_UPLOAD_URL", "").strip()
    artifact_uri = os.environ.get("NUMERAI_ARTIFACT_URI", "").strip()
    if not upload_url:
        return artifact_uri or None
    with archive.open("rb") as artifact:
        response = requests.put(
            upload_url,
            data=artifact,
            headers={"Content-Type": "application/gzip"},
            timeout=300,
        )
    response.raise_for_status()
    return artifact_uri or upload_url.split("?", 1)[0]


def main() -> None:
    run_id = os.environ.get("RUN_ID", "prime-run").strip() or "prime-run"
    output_dir = Path(os.environ.get("NUMERAI_OUTPUT_DIR", "/workspace/output"))
    archive = output_dir.parent / f"{run_id}.tar.gz"
    try:
        config = _load_config()
        _apply_settings(config)

        # Settings are environment-backed and must be imported after applying config.
        from training.trainer import run_training

        target = config.get("target") or config.get("target_col")
        if not target and isinstance(config.get("target_cols"), list):
            target = ",".join(str(value) for value in config["target_cols"])
        model_kwargs = {key: value for key, value in config.items() if key not in TOP_LEVEL}
        metrics = run_training(
            feature_set_name=str(config.get("feature_set", "small")),
            output_dir=str(output_dir),
            skip_download=False,
            upload=False,
            model_type=str(config.get("model_type", "lgbm")),
            neutralization_pct=float(config.get("neutralization_pct", 25)),
            model_kwargs=model_kwargs,
            target=str(target) if target else None,
        )

        with tarfile.open(archive, "w:gz") as bundle:
            bundle.add(output_dir, arcname="model")
        artifact_uri = _upload_artifact(archive)
        if artifact_uri:
            print(f"NUMERAI_ARTIFACT_URI={artifact_uri}", flush=True)
        print(f"NUMERAI_METRICS_JSON={json.dumps(metrics, separators=(',', ':'), default=str)}", flush=True)
        print("NUMERAI_DASHBOARD_TRAINING_COMPLETED", flush=True)
    except Exception as error:
        traceback.print_exc()
        print(f"NUMERAI_DASHBOARD_TRAINING_FAILED={type(error).__name__}:{error}", flush=True)
        raise
    finally:
        shutil.rmtree(archive, ignore_errors=True) if archive.is_dir() else archive.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
