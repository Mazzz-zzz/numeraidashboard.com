#!/usr/bin/env python3
"""Run ML training locally with GPU, reporting to the same S3 pipeline.

Runs the same training pipeline as SageMaker/Modal but on a local machine
with a GPU. Writes progress, epoch metrics, and final metrics to S3 so the
poller Lambda picks them up and they appear in the dashboard.

Can be triggered:
  1. Directly via CLI (standalone mode — creates its own job name)
  2. Via the backend API (which pre-creates the experiment + run in DB)

Usage (standalone):
    cd ml/
    python3 sagemaker/local_runner.py --feature-set medium --model-type mlp --gpu rtx4090

    # With experiment tracking (registers with backend API first):
    python3 sagemaker/local_runner.py --feature-set medium --model-type mlp --gpu rtx4090 \
        --api-url http://localhost:8000/api --experiment-name "local-mlp-test"

    # Signals tournament:
    python3 sagemaker/local_runner.py --feature-set signals_medium --model-type lgbm --gpu rtx4090
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import boto3

# Add ml/ to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

DEFAULT_JOB_PREFIX = "numerai-dashboard"


def _resolve_s3_bucket(explicit: str | None = None) -> str:
    bucket = (
        explicit
        or os.environ.get("ML_S3_BUCKET")
        or os.environ.get("ML_ARTIFACT_BUCKET")
        or ""
    ).strip()
    if not bucket:
        raise ValueError("S3 artifact bucket is required: pass --s3-bucket or set ML_S3_BUCKET")
    return bucket


def _aws_region() -> str | None:
    return os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")

# HP_TO_ENV mapping (same as bootstrap.py / modal_runner.py)
HP_TO_ENV = {
    "num_rounds": "ML_DEFAULT_NUM_ROUNDS",
    "learning_rate": "ML_DEFAULT_LEARNING_RATE",
    "num_leaves": "ML_DEFAULT_NUM_LEAVES",
    "max_depth": "ML_DEFAULT_MAX_DEPTH",
    "feature_fraction": "ML_DEFAULT_FEATURE_FRACTION",
    "bagging_fraction": "ML_DEFAULT_BAGGING_FRACTION",
    "min_data_in_leaf": "ML_DEFAULT_MIN_DATA_IN_LEAF",
    "reg_alpha": "ML_DEFAULT_REG_ALPHA",
    "reg_lambda": "ML_DEFAULT_REG_LAMBDA",
    "min_split_gain": "ML_DEFAULT_MIN_SPLIT_GAIN",
    "path_smooth": "ML_DEFAULT_PATH_SMOOTH",
    "max_bin": "ML_DEFAULT_MAX_BIN",
    "early_stopping_rounds": "ML_EARLY_STOPPING_ROUNDS",
    "max_train_eras": "ML_MAX_TRAIN_ERAS",
    "neutralization_proportion": "ML_NEUTRALIZATION_PROPORTION",
    "multi_target_enabled": "ML_MULTI_TARGET_ENABLED",
    "single_target_mode": "ML_SINGLE_TARGET_MODE",
    "target_col": "ML_TARGET_COL",
    "target_cols": "ML_TARGET_COLS",
    "enable_era_stats": "ML_ENABLE_ERA_STATS",
    "enable_group_aggregates": "ML_ENABLE_GROUP_AGGREGATES",
}

# Model-specific kwargs (not env-mapped)
MODEL_KWARGS_KEYS = {
    "hidden_dims", "dropout", "noise_std", "weight_decay", "batch_size",
    "mixup_alpha", "swa", "swa_start_frac", "warmup_epochs", "multi_head",
    "n_ensemble", "d_embedding", "n_neighbors",
    "d_token", "n_blocks", "n_heads", "attn_dropout", "ff_dropout",
    "n_bags", "context_rows", "features_per_bag", "n_recent_eras",
    "n_estimators_per_bag", "norm_methods",
}


def _write_s3_json(s3, bucket: str, key: str, data: dict):
    """Write a JSON object to S3."""
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data, default=str),
        ContentType="application/json",
    )


def _register_with_api(
    api_url: str,
    experiment_name: str,
    job_name: str,
    feature_set: str,
    model_type: str,
    gpu_type: str,
    neutralization_pct: float,
    hyperparams: dict,
) -> dict | None:
    """Register the run with the backend API so it appears immediately in the dashboard."""
    try:
        import httpx
    except ImportError:
        print("  httpx not installed — skipping API registration (will still write to S3)")
        return None

    try:
        # Create experiment + run via the train endpoint with local: instance type
        payload = {
            "experiment_name": experiment_name,
            "description": f"Local GPU run ({gpu_type})",
            "feature_set": feature_set,
            "model_type": model_type,
            "instance_type": f"local:{gpu_type}",
            "neutralization_pct": neutralization_pct,
            "hyperparams": hyperparams,
        }

        resp = httpx.post(f"{api_url}/ml/train", json=payload, timeout=15)
        resp.raise_for_status()
        result = resp.json()
        print(f"  Registered with API: run_id={result['run_id']}, "
              f"experiment_id={result['experiment_id']}")
        return result
    except Exception as e:
        print(f"  Warning: API registration failed: {e}")
        print("  Continuing with S3-only tracking (poller will still pick it up)")
        return None


def run_local(
    feature_set: str = "medium",
    model_type: str = "lgbm",
    neutralization_pct: float = 25.0,
    gpu_type: str = "gpu",
    upload: bool = False,
    output_dir: str = "./output",
    s3_bucket: str | None = None,
    job_name: str | None = None,
    extra_hyperparams: dict | None = None,
    api_url: str | None = None,
    experiment_name: str | None = None,
):
    """Run training locally, writing progress to S3 for the pipeline."""
    s3_bucket = _resolve_s3_bucket(s3_bucket)
    s3 = boto3.client("s3", region_name=_aws_region())
    start_time = time.time()

    # Generate job name
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    if not job_name:
        safe_name = experiment_name or f"{model_type}-{feature_set}"
        safe_name = safe_name.replace(".", "-").replace("_", "-")[:40]
        job_prefix = (
            os.environ.get("ML_JOB_PREFIX", DEFAULT_JOB_PREFIX).strip()
            or DEFAULT_JOB_PREFIX
        )
        job_name = f"{job_prefix}-local-{safe_name}-{ts}"

    hyperparams = extra_hyperparams or {}

    print(f"{'=' * 60}")
    print(f"Local GPU Training")
    print(f"{'=' * 60}")
    print(f"  Job name:       {job_name}")
    print(f"  Feature set:    {feature_set}")
    print(f"  Model type:     {model_type}")
    print(f"  GPU:            {gpu_type}")
    print(f"  Neutralization: {neutralization_pct}%")
    print(f"  S3 bucket:      {s3_bucket}")
    print(f"  Output dir:     {output_dir}")
    if hyperparams:
        print(f"  Extra params:   {hyperparams}")
    print(f"{'=' * 60}")

    # Register with backend API if URL provided
    if api_url and experiment_name:
        _register_with_api(
            api_url, experiment_name, job_name, feature_set, model_type,
            gpu_type, neutralization_pct, hyperparams,
        )

    # Set environment variables from hyperparams (same as bootstrap.py)
    for hp_key, env_key in HP_TO_ENV.items():
        if hp_key in hyperparams:
            val = hyperparams[hp_key]
            os.environ[env_key] = json.dumps(val) if isinstance(val, (list, dict)) else str(val)

    # Extract model-specific kwargs
    model_kwargs = {k: v for k, v in hyperparams.items() if k in MODEL_KWARGS_KEYS}
    if model_kwargs:
        print(f"  Model kwargs:   {model_kwargs}")

    # S3 callbacks (same interface as SageMaker/Modal)
    def progress_callback(info: dict):
        try:
            info["compute"] = "local"
            info["gpu"] = gpu_type
            info["elapsed_seconds"] = round(time.time() - start_time, 1)
            _write_s3_json(s3, s3_bucket, f"jobs/{job_name}/progress.json", info)
        except Exception as e:
            print(f"Warning: progress write failed: {e}")

    def epoch_callback(info: dict):
        try:
            global_epoch = info.get("global_epoch", info.get("epoch", 0))
            info["compute"] = "local"
            info["gpu"] = gpu_type
            _write_s3_json(s3, s3_bucket, f"jobs/{job_name}/epochs/{global_epoch}.json", info)
        except Exception as e:
            print(f"Warning: epoch write failed: {e}")

    # Determine tournament
    is_signals = feature_set.startswith("signals_")
    tournament = "signals" if is_signals else "classic"

    try:
        if tournament == "signals":
            from training.signals_trainer import run_signals_training
            metrics = run_signals_training(
                output_dir=output_dir,
                skip_download=False,
                upload=upload,
                progress_callback=progress_callback,
                epoch_callback=epoch_callback,
                model_type=model_type,
                neutralization_pct=neutralization_pct,
            )
        else:
            from training.trainer import run_training
            metrics = run_training(
                feature_set_name=feature_set,
                output_dir=output_dir,
                skip_download=False,
                upload=upload,
                progress_callback=progress_callback,
                epoch_callback=epoch_callback,
                model_type=model_type,
                neutralization_pct=neutralization_pct,
                model_kwargs=model_kwargs,
            )

        # Write final metrics to S3 (triggers poller to mark run as completed)
        elapsed = round(time.time() - start_time, 1)
        metrics["compute"] = "local"
        metrics["gpu"] = gpu_type
        metrics["elapsed_seconds"] = elapsed
        _write_s3_json(s3, s3_bucket, f"jobs/{job_name}/metrics.json", metrics)

        print(f"\n{'=' * 60}")
        print(f"Training complete!")
        print(f"  Elapsed:     {elapsed:.0f}s ({elapsed/60:.1f}m)")
        print(f"  Job name:    {job_name}")
        print(f"  S3 metrics:  s3://{s3_bucket}/jobs/{job_name}/metrics.json")
        print(f"  Local output: {output_dir}")

        ensemble = metrics.get("ensemble", {})
        if ensemble:
            print(f"  Correlation: {ensemble.get('correlation', 'N/A')}")
            print(f"  Sharpe:      {ensemble.get('sharpe', 'N/A')}")
        print(f"{'=' * 60}")

        return metrics

    except Exception as e:
        elapsed = round(time.time() - start_time, 1)
        error_info = {
            "status": "failed",
            "error": str(e),
            "traceback": traceback.format_exc(),
            "compute": "local",
            "gpu": gpu_type,
            "elapsed_seconds": elapsed,
        }
        try:
            _write_s3_json(s3, s3_bucket, f"jobs/{job_name}/error.json", error_info)
            # Also write a progress update so poller can detect failure
            _write_s3_json(s3, s3_bucket, f"jobs/{job_name}/progress.json", {
                "step": "failed",
                "progress_pct": 0,
                "error": str(e),
                "compute": "local",
                "gpu": gpu_type,
            })
        except Exception:
            pass

        print(f"\nTraining FAILED after {elapsed:.0f}s: {e}")
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run ML training locally with GPU")
    parser.add_argument("--feature-set", default="medium",
                        help="Feature set: small, medium, all, or signals_*")
    parser.add_argument("--model-type", default="lgbm",
                        choices=["lgbm", "catboost", "mlp", "ft_transformer",
                                 "tabm", "modern_nca", "tabpfn", "tabicl"])
    parser.add_argument("--gpu", default="gpu",
                        help="GPU identifier (e.g., rtx4090, a6000, rtx3090)")
    parser.add_argument("--neutralization-pct", type=float, default=25.0)
    parser.add_argument("--output", default="./output")
    parser.add_argument("--upload", action="store_true",
                        help="Upload submission to Numerai after training")
    parser.add_argument(
        "--s3-bucket",
        default=None,
        help="S3 artifact bucket (defaults to ML_S3_BUCKET)",
    )
    parser.add_argument("--job-name", default=None,
                        help="Override job name (auto-generated if omitted)")
    parser.add_argument("--api-url", default=None,
                        help="Backend API URL for experiment tracking (e.g., http://localhost:8000/api)")
    parser.add_argument("--experiment-name", default=None,
                        help="Experiment name (used with --api-url for dashboard registration)")
    parser.add_argument("--extra", nargs="*",
                        help="Extra hyperparams as key=value pairs")
    args = parser.parse_args()

    # Load .env if present
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip())

    # Parse extra hyperparams
    extra = {}
    if args.extra:
        for kv in args.extra:
            k, v = kv.split("=", 1)
            extra[k] = v

    run_local(
        feature_set=args.feature_set,
        model_type=args.model_type,
        neutralization_pct=args.neutralization_pct,
        gpu_type=args.gpu,
        upload=args.upload,
        output_dir=args.output,
        s3_bucket=args.s3_bucket,
        job_name=args.job_name,
        extra_hyperparams=extra,
        api_url=args.api_url,
        experiment_name=args.experiment_name,
    )
