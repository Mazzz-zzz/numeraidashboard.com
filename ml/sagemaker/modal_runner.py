"""Modal Labs compute provider for ML training jobs.

Runs the same training pipeline as bootstrap.py on Modal CPU or GPU infrastructure.
Modal handles provisioning, container setup, and teardown automatically.

Usage:
    # From ml/ directory
    python3 sagemaker/modal_runner.py --job-name test-run --feature-set medium --model-type mlp --gpu a10g

    # Or triggered by the backend via modal_service.py
"""

from __future__ import annotations

import os

import modal

# ── Modal App Definition ──────────────────────────────────────────────────

GPU_MAP = {
    "cpu": "CPU",
    "t4": "T4",
    "a10g": "A10G",
    "l4": "L4",
    "a100": "A100-40GB",
    "a100-80gb": "A100-80GB",
    "h100": "H100",
}

DEFAULT_MODAL_APP_NAME = "numerai-dashboard-ml"
MODAL_APP_NAME = (
    os.environ.get("MODAL_APP_NAME", DEFAULT_MODAL_APP_NAME).strip()
    or DEFAULT_MODAL_APP_NAME
)

app = modal.App(MODAL_APP_NAME)

# Base image with all ML dependencies pre-installed
ml_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "numpy", "pandas", "pyarrow", "scipy", "scikit-learn",
        "lightgbm", "catboost", "numerapi", "pyyaml",
        "pydantic", "pydantic-settings", "boto3", "fastapi",
        "tabpfn", "tabicl", "huggingface_hub",
    )
    .pip_install("torch", index_url="https://download.pytorch.org/whl/cu121")
)

# Modal secrets
aws_secret = modal.Secret.from_name(
    os.environ.get("MODAL_AWS_SECRET_NAME", "aws-credentials"),
    required_keys=["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
)
hf_secret = modal.Secret.from_name(
    os.environ.get("MODAL_HF_SECRET_NAME", "huggingface-credentials")
)

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


def _resolve_s3_bucket(explicit: str | None = None) -> str:
    bucket = (
        explicit
        or os.environ.get("ML_S3_BUCKET")
        or os.environ.get("ML_ARTIFACT_BUCKET")
        or ""
    ).strip()
    if not bucket:
        raise ValueError("s3_bucket is required or ML_S3_BUCKET must be set")
    return bucket


def _validate_hyperparams(hyperparams: dict) -> dict:
    if not isinstance(hyperparams, dict):
        raise ValueError("hyperparams must be an object")
    if "target_cols" in hyperparams and not isinstance(hyperparams["target_cols"], list):
        raise ValueError("target_cols must be a JSON array of target column names")
    target_cols = hyperparams.get("target_cols")
    if isinstance(target_cols, list) and not all(isinstance(col, str) and col.strip() for col in target_cols):
        raise ValueError("target_cols must contain non-empty strings")
    return hyperparams


def _env_value(value) -> str:
    import json

    return json.dumps(value) if isinstance(value, (list, dict)) else str(value)


def _apply_hyperparam_env(hyperparams: dict) -> None:
    import os

    for env_key in HP_TO_ENV.values():
        os.environ.pop(env_key, None)
    for hp_key, env_key in HP_TO_ENV.items():
        if hp_key in hyperparams:
            os.environ[env_key] = _env_value(hyperparams[hp_key])


def _is_modal_cancelled_exception(error: Exception) -> bool:
    name = type(error).__name__.lower()
    message = str(error).lower()
    return "cancel" in name or "cancel" in message


def _run_training_impl(
    source_tarball_s3: str,
    hyperparams: dict,
    job_name: str,
    s3_bucket: str | None = None,
):
    """Shared training logic for all GPU tiers."""
    import json
    import os
    import sys
    import time
    import traceback

    import boto3

    s3_bucket = _resolve_s3_bucket(s3_bucket)
    start_time = time.time()
    s3 = boto3.client("s3")

    def write_s3_json(s3_key, data):
        s3.put_object(
            Bucket=s3_bucket, Key=s3_key,
            Body=json.dumps(data, default=str),
            ContentType="application/json",
        )

    try:
        return _run_training_inner(
            source_tarball_s3, hyperparams, job_name, s3_bucket,
            s3, write_s3_json, start_time,
        )
    except Exception as e:
        elapsed = time.time() - start_time
        error_info = {
            "status": "failed",
            "error": str(e),
            "traceback": traceback.format_exc(),
            "elapsed_seconds": round(elapsed, 1),
        }
        print(f"Training FAILED after {elapsed:.0f}s: {e}")
        traceback.print_exc()
        try:
            write_s3_json(f"jobs/{job_name}/failure.json", error_info)
        except Exception:
            print("Warning: could not write failure.json to S3")
        raise


def _run_training_inner(
    source_tarball_s3: str,
    hyperparams: dict,
    job_name: str,
    s3_bucket: str,
    s3,
    write_s3_json,
    start_time: float,
):
    """Inner training logic — exceptions bubble up to _run_training_impl."""
    import json
    import os
    import sys
    import tarfile
    import tempfile
    import time

    parts = source_tarball_s3.replace("s3://", "").split("/", 1)
    bucket, key = parts[0], parts[1]

    work_dir = tempfile.mkdtemp(prefix="ml_")
    tar_path = os.path.join(work_dir, "source.tar.gz")
    print(f"Downloading source from {source_tarball_s3}...")
    s3.download_file(bucket, key, tar_path)

    with tarfile.open(tar_path, "r:gz") as tar:
        tar.extractall(work_dir)
    os.unlink(tar_path)

    # 2. Set up environment (same as bootstrap.py HP_TO_ENV)
    hyperparams = _validate_hyperparams(hyperparams)
    _apply_hyperparam_env(hyperparams)

    # 3. Add source to Python path and run training
    sys.path.insert(0, work_dir)
    os.chdir(work_dir)

    feature_set = hyperparams.get("feature_set", "medium")
    model_type = hyperparams.get("model_type", "lgbm")
    neutralization_pct = float(hyperparams.get("neutralization_pct", "25.0"))
    upload = hyperparams.get("upload", "false") == "true"
    tournament = hyperparams.get("tournament", "classic")
    output_dir = os.path.join(work_dir, "output")

    def progress_callback(info):
        try:
            write_s3_json(f"jobs/{job_name}/progress.json", info)
        except Exception as e:
            print(f"Warning: progress write failed: {e}")

    def epoch_callback(info):
        try:
            global_epoch = info.get("global_epoch", info.get("epoch", 0))
            write_s3_json(f"jobs/{job_name}/epochs/{global_epoch}.json", info)
        except Exception as e:
            print(f"Warning: epoch write failed: {e}")

    # Extract model-specific kwargs (not env-mapped settings)
    MODEL_KWARGS_KEYS = {
        "hidden_dims", "dropout", "noise_std", "weight_decay", "batch_size",
        "mixup_alpha", "swa", "swa_start_frac", "warmup_epochs", "multi_head",
        # TabM
        "n_ensemble",
        # ModernNCA
        "d_embedding", "n_neighbors",
        # FT-Transformer
        "d_token", "n_blocks", "n_heads", "attn_dropout", "ff_dropout",
        # TabPFN / TabICL
        "n_bags", "context_rows", "features_per_bag", "n_recent_eras", "n_estimators_per_bag",
        "norm_methods", "device", "offload_mode", "use_amp", "use_fa3",
    }
    model_kwargs = {k: v for k, v in hyperparams.items() if k in MODEL_KWARGS_KEYS}
    if model_kwargs:
        print(f"Model kwargs: {model_kwargs}")

    print(f"Starting Modal training: tournament={tournament}, feature_set={feature_set}, "
          f"model_type={model_type}, neutralization={neutralization_pct}%, "
          f"job_name={job_name}, upload={upload}")

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

    elapsed = time.time() - start_time
    metrics["elapsed_seconds"] = round(elapsed, 1)
    write_s3_json(f"jobs/{job_name}/metrics.json", metrics)
    print(f"Modal training complete! ({elapsed:.0f}s)")
    return {"status": "completed", "metrics": metrics}


# One function per compute tier — Modal requires resources to be static in the decorator
@app.function(
    image=ml_image,
    cpu=8.0,
    memory=32768,
    timeout=86400,
    retries=0,
    secrets=[aws_secret, hf_secret],
)
def run_training_job_cpu(
    source_tarball_s3: str,
    hyperparams: dict,
    job_name: str,
    s3_bucket: str | None = None,
):
    return _run_training_impl(source_tarball_s3, hyperparams, job_name, s3_bucket)


@app.function(image=ml_image, gpu="T4", timeout=86400, retries=0, secrets=[aws_secret, hf_secret])
def run_training_job_t4(
    source_tarball_s3: str,
    hyperparams: dict,
    job_name: str,
    s3_bucket: str | None = None,
):
    return _run_training_impl(source_tarball_s3, hyperparams, job_name, s3_bucket)


@app.function(image=ml_image, gpu="A10G", timeout=86400, retries=0, secrets=[aws_secret, hf_secret])
def run_training_job(
    source_tarball_s3: str,
    hyperparams: dict,
    job_name: str,
    s3_bucket: str | None = None,
):
    return _run_training_impl(source_tarball_s3, hyperparams, job_name, s3_bucket)


@app.function(image=ml_image, gpu="L4", timeout=86400, retries=0, secrets=[aws_secret, hf_secret])
def run_training_job_l4(
    source_tarball_s3: str,
    hyperparams: dict,
    job_name: str,
    s3_bucket: str | None = None,
):
    return _run_training_impl(source_tarball_s3, hyperparams, job_name, s3_bucket)


@app.function(image=ml_image, gpu="A100-40GB", timeout=86400, retries=0, secrets=[aws_secret, hf_secret])
def run_training_job_a100(
    source_tarball_s3: str,
    hyperparams: dict,
    job_name: str,
    s3_bucket: str | None = None,
):
    return _run_training_impl(source_tarball_s3, hyperparams, job_name, s3_bucket)


@app.function(image=ml_image, gpu="A100-80GB", timeout=86400, retries=0, secrets=[aws_secret, hf_secret])
def run_training_job_a100_80gb(
    source_tarball_s3: str,
    hyperparams: dict,
    job_name: str,
    s3_bucket: str | None = None,
):
    return _run_training_impl(source_tarball_s3, hyperparams, job_name, s3_bucket)


@app.function(image=ml_image, gpu="H100", timeout=86400, retries=0, secrets=[aws_secret, hf_secret])
def run_training_job_h100(
    source_tarball_s3: str,
    hyperparams: dict,
    job_name: str,
    s3_bucket: str | None = None,
):
    return _run_training_impl(source_tarball_s3, hyperparams, job_name, s3_bucket)


# ── Inference function ─────────────────────────────────────────────────────


def _run_inference_impl(
    source_tarball_s3: str,
    model_artifact_s3: str,
    numerai_public_id: str,
    numerai_secret_key: str,
    numerai_model_id: str,
    job_name: str,
    s3_bucket: str | None = None,
):
    """Run inference + Numerai upload for a single submission.

    Downloads source code + the trained model artifact from S3, then delegates
    to training.inference.run_inference. Writes progress and result JSON to S3
    so the dashboard can poll job state without holding a Modal connection.
    """
    import json
    import os
    import sys
    import tarfile
    import tempfile
    import time
    import traceback

    import boto3

    s3_bucket = _resolve_s3_bucket(s3_bucket)
    start_time = time.time()
    s3 = boto3.client("s3")

    def write_s3_json(s3_key, data):
        s3.put_object(
            Bucket=s3_bucket, Key=s3_key,
            Body=json.dumps(data, default=str),
            ContentType="application/json",
        )

    def progress_callback(info):
        try:
            write_s3_json(f"jobs/{job_name}/progress.json", info)
        except Exception as e:
            print(f"Warning: progress write failed: {e}")

    try:
        src_parts = source_tarball_s3.replace("s3://", "").split("/", 1)
        work_dir = tempfile.mkdtemp(prefix="ml_")
        src_tar = os.path.join(work_dir, "source.tar.gz")
        print(f"Downloading source from {source_tarball_s3}...")
        s3.download_file(src_parts[0], src_parts[1], src_tar)
        with tarfile.open(src_tar, "r:gz") as tar:
            tar.extractall(work_dir)
        os.unlink(src_tar)
        sys.path.insert(0, work_dir)
        os.chdir(work_dir)

        art_parts = model_artifact_s3.replace("s3://", "").split("/", 1)
        model_dir = tempfile.mkdtemp(prefix="model_")
        model_tar = os.path.join(model_dir, "model.tar.gz")
        print(f"Downloading model artifact from {model_artifact_s3}...")
        s3.download_file(art_parts[0], art_parts[1], model_tar)
        with tarfile.open(model_tar, "r:gz") as tar:
            tar.extractall(model_dir)
        os.unlink(model_tar)

        from training.inference import run_inference

        result = run_inference(
            model_dir=model_dir,
            numerai_public_id=numerai_public_id,
            numerai_secret_key=numerai_secret_key,
            numerai_model_id=numerai_model_id,
            progress_callback=progress_callback,
        )

        elapsed = time.time() - start_time
        result["elapsed_seconds"] = round(elapsed, 1)
        write_s3_json(f"jobs/{job_name}/submission.json", result)
        print(f"Inference complete! ({elapsed:.0f}s)")
        return {"status": "completed", "result": result}
    except Exception as e:
        elapsed = time.time() - start_time
        error_info = {
            "status": "failed",
            "error": str(e),
            "traceback": traceback.format_exc(),
            "elapsed_seconds": round(elapsed, 1),
        }
        print(f"Inference FAILED after {elapsed:.0f}s: {e}")
        traceback.print_exc()
        try:
            write_s3_json(f"jobs/{job_name}/failure.json", error_info)
        except Exception:
            print("Warning: could not write failure.json to S3")
        raise


@app.function(image=ml_image, gpu="L4", timeout=3600, retries=0, secrets=[aws_secret, hf_secret])
def run_inference_job(
    source_tarball_s3: str,
    model_artifact_s3: str,
    numerai_public_id: str,
    numerai_secret_key: str,
    numerai_model_id: str,
    job_name: str,
    s3_bucket: str | None = None,
):
    return _run_inference_impl(
        source_tarball_s3=source_tarball_s3,
        model_artifact_s3=model_artifact_s3,
        numerai_public_id=numerai_public_id,
        numerai_secret_key=numerai_secret_key,
        numerai_model_id=numerai_model_id,
        job_name=job_name,
        s3_bucket=s3_bucket,
    )


# ── Web endpoint: allows Lambda to trigger jobs via HTTP POST ──────────

GPU_FN_MAP = {
    "cpu": run_training_job_cpu,
    "t4": run_training_job_t4,
    "a10g": run_training_job,
    "l4": run_training_job_l4,
    "a100": run_training_job_a100,
    "a100-80gb": run_training_job_a100_80gb,
    "h100": run_training_job_h100,
}


@app.function(image=ml_image, secrets=[aws_secret, hf_secret])
@modal.fastapi_endpoint(method="POST")
def spawn_training(body: dict):
    """HTTP endpoint that Lambda calls to spawn a training job.

    POST body:
        {
            "gpu": "cpu",  # or t4/a10g/l4/a100/a100-80gb/h100
            "job_name": "numerai-dashboard-exp-78-...",
            "hyperparams": {...},
            "s3_bucket": "your-artifact-bucket"
        }

    Returns:
        {"status": "spawned", "call_id": "..."}
    """
    gpu = body.get("gpu", "a10g").lower()
    job_name = body["job_name"]
    try:
        hyperparams = _validate_hyperparams(body.get("hyperparams", {}))
    except ValueError as e:
        return {"status": "error", "detail": str(e)}
    try:
        s3_bucket = _resolve_s3_bucket(body.get("s3_bucket"))
    except ValueError as error:
        return {"status": "error", "detail": str(error)}
    source_uri = f"s3://{s3_bucket}/code/ml-source.tar.gz"

    fn = GPU_FN_MAP.get(gpu)
    if fn is None:
        return {"status": "error", "detail": f"Unknown compute type: {gpu}. Options: {sorted(GPU_FN_MAP.keys())}"}

    call = fn.spawn(
        source_tarball_s3=source_uri,
        hyperparams=hyperparams,
        job_name=job_name,
        s3_bucket=s3_bucket,
    )
    return {"status": "spawned", "call_id": call.object_id}


@app.function(image=ml_image, secrets=[aws_secret, hf_secret])
@modal.fastapi_endpoint(method="POST")
def spawn_inference(body: dict):
    """HTTP endpoint that Lambda calls to run inference + Numerai upload.

    POST body:
        {
            "job_name": "submit-<modelId>-<round>",
            "model_artifact_s3": "s3://bucket/path/model.tar.gz",
            "numerai_public_id": "...",
            "numerai_secret_key": "...",
            "numerai_model_id": "<slot uuid>",
            "s3_bucket": "your-artifact-bucket"
        }

    Returns:
        {"status": "spawned", "call_id": "..."}
    """
    job_name = body.get("job_name")
    if not job_name:
        return {"status": "error", "detail": "job_name is required"}

    model_artifact_s3 = body.get("model_artifact_s3")
    if not model_artifact_s3:
        return {"status": "error", "detail": "model_artifact_s3 is required"}

    numerai_public_id = body.get("numerai_public_id")
    numerai_secret_key = body.get("numerai_secret_key")
    numerai_model_id = body.get("numerai_model_id")
    if not numerai_public_id or not numerai_secret_key or not numerai_model_id:
        return {
            "status": "error",
            "detail": "numerai_public_id, numerai_secret_key, and numerai_model_id are required",
        }

    try:
        s3_bucket = _resolve_s3_bucket(body.get("s3_bucket"))
    except ValueError as error:
        return {"status": "error", "detail": str(error)}
    source_uri = f"s3://{s3_bucket}/code/ml-source.tar.gz"

    call = run_inference_job.spawn(
        source_tarball_s3=source_uri,
        model_artifact_s3=model_artifact_s3,
        numerai_public_id=numerai_public_id,
        numerai_secret_key=numerai_secret_key,
        numerai_model_id=numerai_model_id,
        job_name=job_name,
        s3_bucket=s3_bucket,
    )
    return {"status": "spawned", "call_id": call.object_id}


def _read_job_json(s3, bucket: str, key: str):
    import json

    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        return json.loads(obj["Body"].read().decode("utf-8"))
    except Exception:
        return None


def _job_status_snapshot(job_name: str | None, s3_bucket: str) -> dict:
    if not job_name:
        return {}

    import boto3

    s3 = boto3.client("s3")
    progress = _read_job_json(s3, s3_bucket, f"jobs/{job_name}/progress.json")
    metrics = _read_job_json(s3, s3_bucket, f"jobs/{job_name}/metrics.json")
    failure = _read_job_json(s3, s3_bucket, f"jobs/{job_name}/failure.json")

    logs = []
    if progress:
        step = progress.get("step", "running")
        pct = progress.get("progress_pct")
        suffix = f" {pct}%" if pct is not None else ""
        logs.append({"level": "INFO", "log": f"progress: {step}{suffix}", "progress": progress})
    if metrics:
        elapsed = metrics.get("elapsed_seconds")
        suffix = f" in {elapsed}s" if elapsed is not None else ""
        logs.append({"level": "INFO", "log": f"training metrics written{suffix}", "metrics": metrics})
    if failure:
        error = failure.get("error", "training failed")
        logs.append({"level": "ERROR", "log": f"training failed: {error}", "failure": failure})

    snapshot = {}
    if logs:
        snapshot["logs"] = logs
        snapshot["logTail"] = "\n".join(str(item["log"]) for item in logs)
    payload = {
        key: value
        for key, value in {
            "progress": progress,
            "metrics": metrics,
            "failure": failure,
        }.items()
        if value is not None
    }
    if payload:
        snapshot["metricsJson"] = payload
    if failure:
        snapshot["error"] = failure.get("error", "training failed")
    return snapshot


@app.function(image=ml_image, secrets=[aws_secret])
@modal.fastapi_endpoint(method="POST")
def job_status(body: dict):
    """HTTP endpoint that returns the status of a Modal call by id.

    POST body: {"call_id": "...", "job_name": "...", "s3_bucket": "..."}
    Returns: {"status": "running|completed|failed", ...}
    """
    call_id = body.get("call_id")
    if not call_id:
        return {"status": "error", "detail": "call_id is required"}
    job_name = body.get("job_name")
    try:
        s3_bucket = _resolve_s3_bucket(body.get("s3_bucket"))
    except ValueError as error:
        return {"status": "error", "detail": str(error)}
    snapshot = _job_status_snapshot(job_name, s3_bucket)

    try:
        call = modal.FunctionCall.from_id(call_id)
    except Exception as e:
        return {"status": "error", "detail": f"Unknown call_id: {e}"}

    try:
        result = call.get(timeout=0)
    except modal.exception.OutputExpiredError:
        return {"status": "failed", "error": "Modal output expired", **snapshot}
    except TimeoutError:
        if snapshot.get("error"):
            return {"status": "failed", **snapshot}
        return {"status": "running", **snapshot}
    except Exception as e:
        if _is_modal_cancelled_exception(e):
            return {"status": "cancelled", "error": str(e), **snapshot}
        return {"status": "failed", "error": str(e), **snapshot}

    return {"status": "completed", "result": result, **snapshot}


@app.function(image=ml_image)
@modal.fastapi_endpoint(method="POST")
def job_cancel(body: dict):
    """HTTP endpoint that cancels a Modal call by id.

    POST body: {"call_id": "..."}
    """
    call_id = body.get("call_id")
    if not call_id:
        return {"status": "error", "detail": "call_id is required"}

    try:
        call = modal.FunctionCall.from_id(call_id)
        call.cancel()
    except Exception as e:
        return {"status": "error", "detail": str(e)}

    return {"status": "cancelled"}


# ── CLI entrypoint for testing ────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Launch training on Modal")
    parser.add_argument("--job-name", required=True)
    parser.add_argument("--feature-set", default="medium")
    parser.add_argument("--model-type", default="lgbm")
    parser.add_argument("--gpu", default="a10g", choices=list(GPU_MAP.keys()))
    parser.add_argument("--neutralization-pct", type=float, default=25.0)
    parser.add_argument(
        "--s3-bucket",
        default=os.environ.get("ML_S3_BUCKET") or os.environ.get("ML_ARTIFACT_BUCKET"),
        help="S3 artifact bucket (defaults to ML_S3_BUCKET)",
    )
    parser.add_argument("--extra", nargs="*", help="Extra hyperparams as key=value")
    args = parser.parse_args()
    if not args.s3_bucket:
        parser.error("--s3-bucket or ML_S3_BUCKET is required")

    hyperparams = {
        "feature_set": args.feature_set,
        "model_type": args.model_type,
        "neutralization_pct": str(args.neutralization_pct),
    }
    if args.extra:
        for kv in args.extra:
            k, v = kv.split("=", 1)
            hyperparams[k] = v

    source_uri = f"s3://{args.s3_bucket}/code/ml-source.tar.gz"

    # Pick the right function for the compute tier
    fn_name_map = {
        "cpu": "run_training_job_cpu",
        "t4": "run_training_job_t4",
        "a10g": "run_training_job",
        "l4": "run_training_job_l4",
        "a100": "run_training_job_a100",
        "a100-80gb": "run_training_job_a100_80gb",
        "h100": "run_training_job_h100",
    }
    fn_name = fn_name_map.get(args.gpu, "run_training_job")
    print(f"Using Modal function: {fn_name} (compute={args.gpu})")
    fn = modal.Function.from_name(MODAL_APP_NAME, fn_name)
    call = fn.spawn(
        source_tarball_s3=source_uri,
        hyperparams=hyperparams,
        job_name=args.job_name,
        s3_bucket=args.s3_bucket,
    )
    print(f"Modal job spawned: {call.object_id}")
    print("Waiting for result...")
    result = call.get()
    print(f"Result: {result}")
