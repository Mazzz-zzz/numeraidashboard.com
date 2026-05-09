"""Thin boto3 wrapper for SageMaker training jobs."""

from __future__ import annotations

import logging
from typing import Dict, Optional

import boto3

from app.config import get_settings

logger = logging.getLogger(__name__)

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = boto3.client("sagemaker", region_name="ap-southeast-2")
    return _client


def create_training_job(
    job_name: str,
    hyperparams: Dict[str, str],
    instance_type: str = "ml.m5.xlarge",
    feature_set: str = "medium",
    upload: bool = False,
    model_type: str = "lgbm",
    neutralization_pct: float = 50.0,
) -> str:
    """Create a SageMaker training job. Returns the job ARN."""
    settings = get_settings()
    client = _get_client()

    source_tarball = f"s3://{settings.ml_s3_bucket}/code/ml-source.tar.gz"

    # All hyperparams must be strings for SageMaker
    sm_hyperparams = {k: str(v) for k, v in hyperparams.items()}
    sm_hyperparams.setdefault("feature_set", feature_set)
    sm_hyperparams.setdefault("s3_bucket", settings.ml_s3_bucket)
    sm_hyperparams.setdefault("job_name", job_name)
    sm_hyperparams.setdefault("model_type", model_type)
    sm_hyperparams.setdefault("neutralization_pct", str(neutralization_pct))
    # sklearn framework needs entry point and source directory
    sm_hyperparams["sagemaker_program"] = "bootstrap.py"
    sm_hyperparams["sagemaker_submit_directory"] = source_tarball
    if upload:
        sm_hyperparams["upload"] = "true"

    # Container environment — Numerai credentials for submission upload
    environment: Dict[str, str] = {}
    if upload and settings.numerai_public_id:
        environment["ML_NUMERAI_PUBLIC_ID"] = settings.numerai_public_id
        environment["ML_NUMERAI_SECRET_KEY"] = settings.numerai_secret_key
        environment["ML_NUMERAI_MODEL_ID"] = settings.numerai_model_id

    create_kwargs: Dict = dict(
        TrainingJobName=job_name,
        AlgorithmSpecification={
            "TrainingImage": settings.sagemaker_ecr_image,
            "TrainingInputMode": "File",
        },
        RoleArn=settings.sagemaker_role_arn,
        HyperParameters=sm_hyperparams,
        OutputDataConfig={
            "S3OutputPath": f"s3://{settings.ml_s3_bucket}/jobs/{job_name}/output",
        },
        ResourceConfig={
            "InstanceType": instance_type,
            "InstanceCount": 1,
            "VolumeSizeInGB": 30,
        },
        StoppingCondition={
            "MaxRuntimeInSeconds": 7200,  # 2 hours max
        },
    )
    if environment:
        create_kwargs["Environment"] = environment

    response = client.create_training_job(**create_kwargs)

    return response["TrainingJobArn"]


def describe_job(job_name: str) -> dict:
    """Describe a SageMaker training job."""
    client = _get_client()
    response = client.describe_training_job(TrainingJobName=job_name)
    return {
        "status": response["TrainingJobStatus"],
        "secondary_status": response.get("SecondaryStatus", ""),
        "failure_reason": response.get("FailureReason", ""),
        "creation_time": response.get("CreationTime"),
        "training_start_time": response.get("TrainingStartTime"),
        "training_end_time": response.get("TrainingEndTime"),
    }


def create_inference_job(
    job_name: str,
    model_artifact_s3: str,
    tournament: str = "classic",
    model_type: str = "lgbm",
    numerai_model_id: str = "",
) -> str:
    """Create a SageMaker job for inference (predict + submit).

    Uses the same ECR image as training but runs in inference mode.
    Returns the job ARN.
    """
    settings = get_settings()
    client = _get_client()

    source_tarball = f"s3://{settings.ml_s3_bucket}/code/ml-source.tar.gz"

    sm_hyperparams = {
        "mode": "inference",
        "model_artifact_s3": model_artifact_s3,
        "tournament": tournament,
        "model_type": model_type,
        "numerai_model_id": numerai_model_id,
        "s3_bucket": settings.ml_s3_bucket,
        "job_name": job_name,
        "sagemaker_program": "bootstrap.py",
        "sagemaker_submit_directory": source_tarball,
    }

    environment: Dict[str, str] = {}
    if settings.numerai_public_id:
        environment["ML_NUMERAI_PUBLIC_ID"] = settings.numerai_public_id
        environment["ML_NUMERAI_SECRET_KEY"] = settings.numerai_secret_key
        environment["ML_NUMERAI_MODEL_ID"] = numerai_model_id

    create_kwargs: Dict = dict(
        TrainingJobName=job_name,
        AlgorithmSpecification={
            "TrainingImage": settings.sagemaker_ecr_image,
            "TrainingInputMode": "File",
        },
        RoleArn=settings.sagemaker_role_arn,
        HyperParameters=sm_hyperparams,
        OutputDataConfig={
            "S3OutputPath": f"s3://{settings.ml_s3_bucket}/jobs/{job_name}/output",
        },
        ResourceConfig={
            "InstanceType": "ml.m5.large",  # Inference is lightweight
            "InstanceCount": 1,
            "VolumeSizeInGB": 20,
        },
        StoppingCondition={
            "MaxRuntimeInSeconds": 1800,  # 30 min max for inference
        },
    )
    if environment:
        create_kwargs["Environment"] = environment

    response = client.create_training_job(**create_kwargs)
    return response["TrainingJobArn"]


def get_model_artifact_path(job_name: str) -> Optional[str]:
    """Get the S3 path to the model artifact from a completed training job."""
    client = _get_client()
    try:
        resp = client.describe_training_job(TrainingJobName=job_name)
        artifacts = resp.get("ModelArtifacts", {})
        return artifacts.get("S3ModelArtifacts")
    except Exception:
        logger.warning("Failed to get model artifact for %s", job_name)
        return None


def stop_job(job_name: str) -> None:
    """Stop a running SageMaker training job."""
    client = _get_client()
    try:
        client.stop_training_job(TrainingJobName=job_name)
    except client.exceptions.ClientError as e:
        # Job may already be stopped/completed
        logger.warning("Failed to stop job %s: %s", job_name, e)
