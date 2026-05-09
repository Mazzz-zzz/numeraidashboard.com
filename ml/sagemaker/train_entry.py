"""SageMaker training entry point.

SageMaker provides:
- /opt/ml/input/config/hyperparameters.json — training config
- /opt/ml/model/ — write final model artifacts here
- /opt/ml/output/ — write failure details here
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import traceback
from pathlib import Path

import boto3

# Add ml/ to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))


def _load_hyperparams() -> dict:
    """Load hyperparameters from SageMaker config or env vars."""
    hp_path = Path("/opt/ml/input/config/hyperparameters.json")
    if hp_path.exists():
        with open(hp_path) as f:
            return json.load(f)

    # Fallback: parse SM_HP_* env vars
    return {
        k[5:].lower(): v
        for k, v in os.environ.items()
        if k.startswith("SM_HP_")
    }


def _write_s3_json(bucket: str, key: str, data: dict):
    """Write a JSON object to S3."""
    s3 = boto3.client("s3")
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(data, default=str),
        ContentType="application/json",
    )


def main():
    model_dir = os.environ.get("SM_MODEL_DIR", "/opt/ml/model")
    output_dir = os.environ.get("SM_OUTPUT_DIR", "/opt/ml/output")

    try:
        hp = _load_hyperparams()
        feature_set = hp.get("feature_set", "medium")
        s3_bucket = hp.get("s3_bucket", "openoptions-ml")
        job_name = hp.get("job_name", "unknown")

        print(f"Starting training: feature_set={feature_set}, job_name={job_name}")

        # Progress callback writes to S3
        def progress_callback(info: dict):
            try:
                _write_s3_json(
                    s3_bucket,
                    f"jobs/{job_name}/progress.json",
                    info,
                )
            except Exception as e:
                print(f"Warning: failed to write progress to S3: {e}")

        # Epoch callback writes individual epoch files to S3
        def epoch_callback(info: dict):
            try:
                epoch = info.get("epoch", 0)
                _write_s3_json(
                    s3_bucket,
                    f"jobs/{job_name}/epochs/{epoch}.json",
                    info,
                )
            except Exception as e:
                print(f"Warning: failed to write epoch {info.get('epoch')} to S3: {e}")

        # Run the training pipeline
        from training.trainer import run_training

        metrics = run_training(
            feature_set_name=feature_set,
            output_dir=model_dir,
            skip_download=False,
            upload=False,
            progress_callback=progress_callback,
            epoch_callback=epoch_callback,
        )

        # Upload final metrics to S3
        _write_s3_json(s3_bucket, f"jobs/{job_name}/metrics.json", metrics)

        # Copy any model artifacts to the model output dir
        print(f"Training complete. Artifacts in {model_dir}")

    except Exception as e:
        traceback.print_exc()
        # Write failure info
        failure_path = Path(output_dir) / "failure"
        failure_path.mkdir(parents=True, exist_ok=True)
        with open(failure_path / "error.txt", "w") as f:
            f.write(traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
