"""Launch a SageMaker training job.

Packages ml/ code into a tarball, uploads to S3, and creates a SageMaker
training job that unpacks the code, installs dependencies, and runs training.

Uses a bootstrap entry point that:
1. Unpacks the source tarball from the S3 input channel
2. pip-installs lightgbm, numerapi, etc.
3. Runs sagemaker/train_entry.py

Usage:
    cd ml/
    python3 sagemaker/launch_job.py --feature-set small
    python3 sagemaker/launch_job.py --feature-set medium --instance ml.m5.2xlarge
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import tarfile
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import boto3


@dataclass(frozen=True)
class SageMakerConfig:
    region: str
    role_arn: str
    s3_bucket: str
    training_image: str
    aws_profile: str | None
    job_prefix: str


def _environment_value(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return None


def load_sagemaker_config() -> SageMakerConfig:
    """Load operator-owned infrastructure without source-level fallbacks."""
    values = {
        "region": _environment_value("AWS_REGION", "AWS_DEFAULT_REGION"),
        "role_arn": _environment_value("SAGEMAKER_ROLE_ARN"),
        "s3_bucket": _environment_value("ML_S3_BUCKET", "ML_ARTIFACT_BUCKET"),
        "training_image": _environment_value("SAGEMAKER_TRAINING_IMAGE"),
    }
    missing = [name for name, value in values.items() if not value]
    if missing:
        required_names = {
            "region": "AWS_REGION",
            "role_arn": "SAGEMAKER_ROLE_ARN",
            "s3_bucket": "ML_S3_BUCKET",
            "training_image": "SAGEMAKER_TRAINING_IMAGE",
        }
        missing_env = ", ".join(required_names[name] for name in missing)
        raise RuntimeError(f"Missing SageMaker configuration: {missing_env}")

    job_prefix = _environment_value("ML_JOB_PREFIX") or "numerai-dashboard"
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?", job_prefix):
        raise RuntimeError("ML_JOB_PREFIX must contain only letters, numbers, and hyphens")

    return SageMakerConfig(
        region=values["region"],
        role_arn=values["role_arn"],
        s3_bucket=values["s3_bucket"],
        training_image=values["training_image"],
        aws_profile=_environment_value("AWS_PROFILE"),
        job_prefix=job_prefix,
    )


def format_aws_cli_options(config: SageMakerConfig) -> str:
    options = ["--region", shlex.quote(config.region)]
    if config.aws_profile:
        options.extend(["--profile", shlex.quote(config.aws_profile)])
    return " ".join(options)


def _package_source(ml_dir: Path, config: SageMakerConfig | None = None) -> str:
    """Package ml/ code (including bootstrap.py) into a tarball and upload to S3."""
    config = config or load_sagemaker_config()
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as f:
        tmp_path = f.name

    with tarfile.open(tmp_path, "w:gz") as tar:
        for item in ml_dir.iterdir():
            if item.name in ("data_cache", "output", "__pycache__", ".env"):
                continue
            tar.add(item, arcname=item.name)

    s3 = boto3.client("s3", region_name=config.region)
    s3_key = "code/ml-source.tar.gz"
    s3.upload_file(tmp_path, config.s3_bucket, s3_key)
    os.unlink(tmp_path)

    return f"s3://{config.s3_bucket}/{s3_key}"


def launch(
    feature_set: str,
    instance_type: str,
    upload: bool = False,
    experiment_name: str | None = None,
    extra_hyperparams: dict | None = None,
    config: SageMakerConfig | None = None,
):
    """Launch a SageMaker training job.

    Args:
        feature_set: Feature set (small/medium/all).
        instance_type: SageMaker instance type.
        upload: Upload submission to Numerai after training.
        experiment_name: Optional name suffix for the job.
        extra_hyperparams: Additional hyperparameters forwarded to bootstrap.py.
            Supported keys (see bootstrap.py HP_TO_ENV):
              model_type, neutralization_pct, num_rounds, learning_rate,
              num_leaves, max_depth, feature_fraction, bagging_fraction,
              early_stopping_rounds, max_train_eras, multi_target_enabled,
              enable_era_stats, enable_group_aggregates.
    """
    config = config or load_sagemaker_config()
    ml_dir = Path(__file__).parent.parent

    print("Packaging source code...")
    source_uri = _package_source(ml_dir, config)
    print(f"  Uploaded to {source_uri}")

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    tag = (
        re.sub(r"[^A-Za-z0-9-]+", "-", experiment_name or feature_set).strip("-")
        or "run"
    )
    job_name = f"{config.job_prefix}-{tag}-{ts}"[:63].rstrip("-")

    hyperparams = {
        "feature_set": feature_set,
        "s3_bucket": config.s3_bucket,
        "job_name": job_name,
    }

    if extra_hyperparams:
        # All SageMaker hyperparams must be strings
        for k, v in extra_hyperparams.items():
            hyperparams[k] = str(v)

    # SageMaker sklearn framework mode: specify entry point + source dir
    # The framework unpacks source_dir and runs sagemaker_program
    sm_hyperparams = {
        **hyperparams,
        "sagemaker_program": "bootstrap.py",
        "sagemaker_submit_directory": f"s3://{config.s3_bucket}/code/ml-source.tar.gz",
    }

    sm = boto3.client("sagemaker", region_name=config.region)

    print(f"Creating training job: {job_name}")
    print(f"  Instance: {instance_type}")
    print(f"  Feature set: {feature_set}")
    print(f"  Image: {config.training_image}")

    sm.create_training_job(
        TrainingJobName=job_name,
        AlgorithmSpecification={
            "TrainingImage": config.training_image,
            "TrainingInputMode": "File",
        },
        RoleArn=config.role_arn,
        HyperParameters=sm_hyperparams,
        InputDataConfig=[
            {
                "ChannelName": "code",
                "DataSource": {
                    "S3DataSource": {
                        "S3DataType": "S3Prefix",
                        "S3Uri": source_uri,
                        "S3DataDistributionType": "FullyReplicated",
                    }
                },
                "CompressionType": "None",
                "InputMode": "File",
            }
        ],
        OutputDataConfig={
            "S3OutputPath": f"s3://{config.s3_bucket}/jobs/{job_name}/output",
        },
        ResourceConfig={
            "InstanceType": instance_type,
            "InstanceCount": 1,
            "VolumeSizeInGB": 50,
        },
        StoppingCondition={
            "MaxRuntimeInSeconds": 7200,
        },
        Environment={
            "ML_NUMERAI_PUBLIC_ID": os.environ.get("ML_NUMERAI_PUBLIC_ID", ""),
            "ML_NUMERAI_SECRET_KEY": os.environ.get("ML_NUMERAI_SECRET_KEY", ""),
        },
    )

    print(f"\nJob launched: {job_name}")
    cli_options = format_aws_cli_options(config)
    print(f"Monitor:")
    print(
        "  aws sagemaker describe-training-job "
        f"--training-job-name {job_name} {cli_options}"
    )
    print(f"Logs:")
    print(
        "  aws logs tail /aws/sagemaker/TrainingJobs "
        f"--log-stream-name-prefix {job_name} {cli_options} --follow"
    )

    return job_name


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Launch SageMaker training job")
    parser.add_argument("--feature-set", default="small", choices=["small", "medium", "all"])
    parser.add_argument("--instance", default="ml.m5.xlarge")
    parser.add_argument("--upload", action="store_true", help="Upload submission to Numerai")
    parser.add_argument("--experiment-name", default=None, help="Name suffix for job")
    parser.add_argument("--model-type", default=None, choices=["lgbm", "catboost", "mlp", "ft_transformer", "tabm", "modern_nca", "tabpfn", "tabicl"])
    parser.add_argument("--neutralization-pct", type=float, default=None)
    parser.add_argument("--learning-rate", type=float, default=None)
    parser.add_argument("--num-leaves", type=int, default=None)
    parser.add_argument("--feature-fraction", type=float, default=None)
    parser.add_argument("--num-rounds", type=int, default=None)
    parser.add_argument("--no-era-stats", action="store_true")
    parser.add_argument("--no-group-agg", action="store_true")
    parser.add_argument(
        "--target", default=None,
        help="Target(s) to train on, e.g. 'target_ender_20'. "
             "Sets single-target mode via target_col",
    )
    args = parser.parse_args()

    # Load .env if present
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip())

    extra = {}
    if args.model_type:
        extra["model_type"] = args.model_type
    if args.neutralization_pct is not None:
        extra["neutralization_pct"] = args.neutralization_pct
    if args.learning_rate is not None:
        extra["learning_rate"] = args.learning_rate
    if args.num_leaves is not None:
        extra["num_leaves"] = args.num_leaves
    if args.feature_fraction is not None:
        extra["feature_fraction"] = args.feature_fraction
    if args.num_rounds is not None:
        extra["num_rounds"] = args.num_rounds
    if args.no_era_stats:
        extra["enable_era_stats"] = "false"
    if args.no_group_agg:
        extra["enable_group_aggregates"] = "false"
    if args.target:
        extra["target_col"] = args.target
        extra["multi_target_enabled"] = "false"

    launch(args.feature_set, args.instance, args.upload,
           experiment_name=args.experiment_name, extra_hyperparams=extra)
