"""Quick A/B test for TabICL params on Modal GPU.

Downloads only train data (not validation), uses last 20 eras, splits
train/val internally. Should finish in ~5-10 minutes on L4.

Usage: modal run sagemaker/quick_test.py
"""
from __future__ import annotations
import os

import modal

app = modal.App("tabicl-quick-test")

ml_image = (
    modal.Image.debian_slim(python_version="3.11")

    .pip_install(
        "numpy", "pandas", "pyarrow", "scipy", "scikit-learn",
        "lightgbm", "numerapi", "pyyaml", "pydantic", "pydantic-settings",
        "boto3", "tabicl", "huggingface_hub",
    )
    .pip_install("torch", index_url="https://download.pytorch.org/whl/cu121")
    .pip_install("tabicl")  # ensure latest
)

aws_secret = modal.Secret.from_name(
    "aws-credentials",
    required_keys=["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
)
hf_secret = modal.Secret.from_name("huggingface-credentials")


@app.function(image=ml_image, gpu="L4", timeout=1800, secrets=[aws_secret, hf_secret])
def run_ab_test(s3_bucket: str):
    import json
    import os
    import tarfile
    import tempfile
    import time
    import sys

    import boto3
    import numpy as np
    import pandas as pd

    t0 = time.time()

    # Download and extract source
    s3 = boto3.client("s3")
    work_dir = tempfile.mkdtemp(prefix="ml_")
    tar_path = os.path.join(work_dir, "source.tar.gz")
    s3.download_file(s3_bucket, "code/ml-source.tar.gz", tar_path)
    with tarfile.open(tar_path, "r:gz") as tar:
        tar.extractall(work_dir)
    os.unlink(tar_path)
    sys.path.insert(0, work_dir)
    os.chdir(work_dir)

    from pathlib import Path
    from models import create_model

    # Download ONLY train data (skip huge validation file)
    import numerapi
    napi = numerapi.NumerAPI()
    current_round = napi.get_current_round()
    data_dir = Path(f"data_cache")
    data_dir.mkdir(exist_ok=True)

    # Features metadata
    feat_path = data_dir / f"features_r{current_round}.json"
    if not feat_path.exists():
        napi.download_dataset(f"v5.0/features.json", str(feat_path))
    with open(feat_path) as f:
        metadata = json.load(f)
    feature_cols = metadata["feature_sets"]["small"]
    print(f"[{time.time()-t0:.0f}s] {len(feature_cols)} small features")

    # Train data only
    train_path = data_dir / f"train_r{current_round}.parquet"
    if not train_path.exists():
        napi.download_dataset(f"v5.0/train.parquet", str(train_path))
    print(f"[{time.time()-t0:.0f}s] Train data downloaded")

    cols = ["era", "target"] + feature_cols
    train = pd.read_parquet(train_path, columns=cols)
    eras = sorted(train["era"].unique())

    # Use last 20 eras, split: 16 train / 4 val
    train = train[train["era"].isin(eras[-20:])]
    train = train[train["target"].notna()]
    val_df = train[train["era"].isin(eras[-4:])].copy()
    train_df = train[~train["era"].isin(eras[-4:])].copy()
    del train
    print(f"[{time.time()-t0:.0f}s] Train: {len(train_df):,}, Val: {len(val_df):,}")

    # Per-era correlation helper
    def era_corr(preds, df):
        tmp = df[["era", "target"]].copy()
        tmp["_pred"] = preds.values
        corrs = tmp.groupby("era").apply(
            lambda g: g["_pred"].corr(g["target"]), include_groups=False
        )
        return corrs

    results = {}

    configs = {
        "old_defaults": dict(
            n_bags=4, context_rows=8000, n_recent_eras=12,
            n_estimators_per_bag=4, norm_methods="default",         ),
        "new_defaults": dict(
            n_bags=4, context_rows=20000, n_recent_eras=16,
            n_estimators_per_bag=8, norm_methods="all",        ),
        "new_more_bags": dict(
            n_bags=8, context_rows=20000, n_recent_eras=16,
            n_estimators_per_bag=8, norm_methods="all",        ),
    }

    for name, kwargs in configs.items():
        t1 = time.time()
        model = create_model(model_type="tabicl", **kwargs)
        model.fit(train_df, feature_cols, "target", "era", val_df=val_df)

        preds = model.predict(val_df, feature_cols)
        raw_corr = float(preds.corr(val_df["target"]))
        ec = era_corr(preds, val_df)
        mean_corr = float(ec.mean())
        sharpe = float(ec.mean() / ec.std()) if ec.std() > 0 else 0

        elapsed = time.time() - t1
        results[name] = {
            "raw_corr": raw_corr,
            "mean_era_corr": mean_corr,
            "sharpe": sharpe,
            "elapsed_s": round(elapsed, 1),
        }
        print(f"[{time.time()-t0:.0f}s] {name}: era_corr={mean_corr:.6f} sharpe={sharpe:.3f} ({elapsed:.0f}s)")

        del model
        import torch
        torch.cuda.empty_cache()

    print(f"\n{'='*60}")
    print(f"{'Config':<20} {'Era Corr':>10} {'Sharpe':>8} {'Time':>6}")
    print(f"{'-'*60}")
    for name, r in results.items():
        print(f"{name:<20} {r['mean_era_corr']:>10.6f} {r['sharpe']:>8.3f} {r['elapsed_s']:>5.0f}s")

    return results


@app.local_entrypoint()
def main(s3_bucket: str = ""):
    import json as _json

    resolved_bucket = (
        s3_bucket
        or os.environ.get("ML_S3_BUCKET")
        or os.environ.get("ML_ARTIFACT_BUCKET")
        or ""
    ).strip()
    if not resolved_bucket:
        raise ValueError("Pass --s3-bucket or set ML_S3_BUCKET")

    results = run_ab_test.remote(resolved_bucket)
    print("\nFinal results:", _json.dumps(results, indent=2))
