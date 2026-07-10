from __future__ import annotations

import pytest

from sagemaker.launch_job import format_aws_cli_options, load_sagemaker_config


REQUIRED_ENV = (
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "SAGEMAKER_ROLE_ARN",
    "ML_S3_BUCKET",
    "ML_ARTIFACT_BUCKET",
    "SAGEMAKER_TRAINING_IMAGE",
    "AWS_PROFILE",
    "ML_JOB_PREFIX",
)


def clear_cloud_environment(monkeypatch):
    for name in REQUIRED_ENV:
        monkeypatch.delenv(name, raising=False)


def test_sagemaker_config_requires_operator_infrastructure(monkeypatch):
    clear_cloud_environment(monkeypatch)

    with pytest.raises(RuntimeError, match="Missing SageMaker configuration"):
        load_sagemaker_config()


def test_sagemaker_config_reads_environment(monkeypatch):
    clear_cloud_environment(monkeypatch)
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("SAGEMAKER_ROLE_ARN", "arn:aws:iam::123456789012:role/example")
    monkeypatch.setenv("ML_S3_BUCKET", "artifact-bucket")
    monkeypatch.setenv("SAGEMAKER_TRAINING_IMAGE", "registry.example/training:latest")
    monkeypatch.setenv("AWS_PROFILE", "research")

    config = load_sagemaker_config()

    assert config.region == "us-east-1"
    assert config.role_arn == "arn:aws:iam::123456789012:role/example"
    assert config.s3_bucket == "artifact-bucket"
    assert config.training_image == "registry.example/training:latest"
    assert config.job_prefix == "numerai-dashboard"
    assert format_aws_cli_options(config) == "--region us-east-1 --profile research"


def test_sagemaker_config_rejects_invalid_job_prefix(monkeypatch):
    clear_cloud_environment(monkeypatch)
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("SAGEMAKER_ROLE_ARN", "arn:aws:iam::123456789012:role/example")
    monkeypatch.setenv("ML_S3_BUCKET", "artifact-bucket")
    monkeypatch.setenv("SAGEMAKER_TRAINING_IMAGE", "registry.example/training:latest")
    monkeypatch.setenv("ML_JOB_PREFIX", "invalid prefix")

    with pytest.raises(RuntimeError, match="ML_JOB_PREFIX"):
        load_sagemaker_config()
