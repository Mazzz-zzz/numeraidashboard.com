"""Local GPU compute provider for ML training jobs.

Local jobs skip remote provisioning — the training runs on the user's machine.
The backend just records the run and returns a job name. The local_runner.py
script handles S3 progress writes, and the poller picks them up the same way
it handles Modal jobs (by reading S3 artifacts).

The poller detects local jobs by the 'local:' prefix in sagemaker_job_arn.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

LOCAL_GPU_TYPES = {
    "gpu",          # generic
    "rtx3090",
    "rtx4090",
    "a6000",
    "a5000",
    "a4000",
    "rtx4080",
    "rtx4070",
    "rtx3080",
    "rtx3070",
    "l40",
    "l40s",
}


def parse_local_instance(instance_type: str) -> str:
    """Extract GPU type from 'local:rtx4090' format."""
    if not instance_type.startswith("local:"):
        raise ValueError(f"Not a local instance type: {instance_type}")
    gpu = instance_type.split(":", 1)[1].lower()
    # Accept any GPU type — the set above is just for known cost rates
    return gpu


def is_local_instance(instance_type: str) -> bool:
    return instance_type.startswith("local:")


def create_training_job(
    job_name: str,
    hyperparams: dict,
    instance_type: str = "local:gpu",
    feature_set: str = "medium",
    upload: bool = False,
    model_type: str = "lgbm",
    neutralization_pct: float = 25.0,
) -> str:
    """Record a local GPU training job.

    Unlike SageMaker/Modal, this doesn't launch anything — the user runs
    local_runner.py on their machine. The backend just creates the DB record
    and returns a job ARN that the poller knows to track via S3.

    Returns a 'local:{gpu}:{job_name}' ARN string for the poller.
    """
    gpu = parse_local_instance(instance_type)

    logger.info("Registered local GPU job: %s (gpu=%s)", job_name, gpu)
    return f"local:{gpu}:{job_name}"
