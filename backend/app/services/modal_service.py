"""Modal Labs compute provider for ML training jobs.

Spawns training jobs on Modal GPU infrastructure via their web endpoint.
The endpoint dispatches to the correct GPU tier and returns immediately.
The poller detects Modal jobs by the 'modal:' prefix in sagemaker_job_arn
and reads status from S3 instead of calling SageMaker DescribeTrainingJob.
"""

from __future__ import annotations

import logging
from typing import Dict

import httpx

logger = logging.getLogger(__name__)

MODAL_GPU_TYPES = {"t4", "a10g", "l4", "a100", "a100-80gb", "h100"}
MODAL_SPAWN_URL = "https://almaz--openoptions-ml-spawn-training.modal.run"


def parse_modal_instance(instance_type: str) -> str:
    """Extract GPU type from 'modal:a10g' format."""
    if not instance_type.startswith("modal:"):
        raise ValueError(f"Not a Modal instance type: {instance_type}")
    gpu = instance_type.split(":", 1)[1].lower()
    if gpu not in MODAL_GPU_TYPES:
        raise ValueError(f"Unknown Modal GPU: {gpu}. Options: {sorted(MODAL_GPU_TYPES)}")
    return gpu


def is_modal_instance(instance_type: str) -> bool:
    return instance_type.startswith("modal:")


def create_training_job(
    job_name: str,
    hyperparams: Dict,
    instance_type: str = "modal:a10g",
    feature_set: str = "medium",
    upload: bool = False,
    model_type: str = "lgbm",
    neutralization_pct: float = 25.0,
) -> str:
    """Spawn a training job on Modal via HTTP POST to the web endpoint.

    Returns a 'modal:{gpu}:{job_name}' ARN string for the poller.
    """
    gpu = parse_modal_instance(instance_type)

    # Build the full hyperparams dict that modal_runner expects
    full_hyperparams = {
        **hyperparams,
        "feature_set": feature_set,
        "model_type": model_type,
        "neutralization_pct": str(neutralization_pct),
        "upload": "true" if upload else "false",
    }

    payload = {
        "gpu": gpu,
        "job_name": job_name,
        "hyperparams": full_hyperparams,
        "s3_bucket": "openoptions-ml",
    }

    logger.info("Spawning Modal job: %s (gpu=%s)", job_name, gpu)

    resp = httpx.post(MODAL_SPAWN_URL, json=payload, timeout=30.0)
    resp.raise_for_status()
    result = resp.json()

    if result.get("status") == "error":
        raise RuntimeError(f"Modal spawn failed: {result.get('detail')}")

    call_id = result.get("call_id", "unknown")
    logger.info("Modal job spawned: %s (call_id=%s)", job_name, call_id)

    return f"modal:{gpu}:{job_name}"
