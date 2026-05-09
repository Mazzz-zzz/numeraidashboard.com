#!/usr/bin/env python3
"""Launch a grid of Numerai Classic experiments on SageMaker.

Each experiment varies one (or a few) hyperparameters from the baseline.
All experiments use the same source tarball (uploaded once) and run in
parallel on separate SageMaker instances.

Usage:
    cd ml/
    python3 sagemaker/launch_experiments.py                 # launch all
    python3 sagemaker/launch_experiments.py --dry-run       # print without launching
    python3 sagemaker/launch_experiments.py --only baseline no-neut high-neut
"""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

from launch_job import S3_BUCKET, launch

# ── Experiment definitions ──────────────────────────────────────────────
# Each entry: (name, feature_set, extra_hyperparams)
# Baseline uses production defaults from MlSettings:
#   medium features, lr=0.005, num_leaves=512, feature_fraction=0.1,
#   neutralization=50%, era_stats=on, group_agg=on, 8 targets

EXPERIMENTS = [
    # 1. Baseline — current production config
    ("baseline", "medium", {}),

    # 2–4. Neutralization sweep
    ("no-neut", "medium", {"neutralization_pct": "0"}),
    ("low-neut", "medium", {"neutralization_pct": "25"}),
    ("high-neut", "medium", {"neutralization_pct": "75"}),

    # 5–6. Feature set size
    ("small-feat", "small", {}),
    ("all-feat", "all", {}),

    # 7–8. Learning rate
    ("lr-low", "medium", {"learning_rate": "0.001"}),
    ("lr-high", "medium", {"learning_rate": "0.01"}),

    # 9–10. Regularization via feature_fraction
    ("ff-low", "medium", {"feature_fraction": "0.05"}),
    ("ff-high", "medium", {"feature_fraction": "0.3"}),

    # 11–12. Tree complexity
    ("leaves-256", "medium", {"num_leaves": "256"}),
    ("leaves-1024", "medium", {"num_leaves": "1024"}),

    # 13–14. Feature engineering ablation
    ("no-era-stats", "medium", {"enable_era_stats": "false"}),
    ("no-fe", "medium", {"enable_era_stats": "false", "enable_group_aggregates": "false"}),

    # 15. CatBoost comparison
    ("catboost", "medium", {"model_type": "catboost"}),

    # ── Community Technique Ablation Tests ───────────────────────────────
    # Based on Numerai community research 2024-2025
    
    # 16. High neutralization (50%)
    ("neut-50", "medium", {"neutralization_pct": "50"}),
    
    # 17. Very low feature fraction (community best practice)
    ("feat-frac-0.1", "medium", {"feature_fraction": "0.1"}),
    
    # 18. High min_data_in_leaf (more regularization)
    ("high-min-leaf", "medium", {"min_data_in_leaf": "500"}),
    
    # 19. Low learning rate (slower training)
    ("low-lr", "medium", {"learning_rate": "0.005"}),
    
    # 20. Era-boosted training (3 models with era sampling)
    ("era-boost", "medium", {"era_boosting": "true", "n_era_models": "3"}),
    
    # 21. Stable feature selection (community technique)
    ("stable-features", "medium", {"use_stable_features": "true", "n_stable_features": "800"}),
    
    # 22. Combo: best 3 techniques
    ("combo-best", "medium", {
        "neutralization_pct": "50",
        "feature_fraction": "0.1", 
        "min_data_in_leaf": "500"
    }),
    
    # 23. Combo: all community techniques
    ("combo-super", "medium", {
        "neutralization_pct": "50",
        "feature_fraction": "0.1",
        "min_data_in_leaf": "500",
        "learning_rate": "0.005",
        "era_boosting": "true",
        "n_era_models": "3"
    }),
]

# Instance sizing — all features needs more RAM
INSTANCE_MAP = {
    "small": "ml.m5.xlarge",    # 16 GB — plenty for 42 features
    "medium": "ml.m5.4xlarge",  # 64 GB — v5.2 full dataset needs headroom
    "all": "ml.m5.4xlarge",     # 64 GB — 2376 features + full dataset
}


def main():
    parser = argparse.ArgumentParser(description="Launch experiment grid")
    parser.add_argument("--dry-run", action="store_true", help="Print experiments without launching")
    parser.add_argument("--only", nargs="+", help="Only launch these experiments (by name)")
    parser.add_argument("--instance", default=None, help="Override instance type for all jobs")
    args = parser.parse_args()

    # Load .env
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip())

    experiments = EXPERIMENTS
    if args.only:
        experiments = [(n, f, h) for n, f, h in EXPERIMENTS if n in args.only]
        if not experiments:
            print(f"No experiments matched: {args.only}")
            print(f"Available: {[n for n, _, _ in EXPERIMENTS]}")
            return

    print(f"{'DRY RUN — ' if args.dry_run else ''}Launching {len(experiments)} experiments\n")

    launched = []
    for name, feature_set, extra in experiments:
        instance = args.instance or INSTANCE_MAP.get(feature_set, "ml.m5.xlarge")
        print(f"  [{name}] feature_set={feature_set}, instance={instance}")
        if extra:
            print(f"    overrides: {extra}")

        if args.dry_run:
            launched.append(f"oo-numerai-{name}-DRYRUN")
            continue

        job_name = launch(
            feature_set=feature_set,
            instance_type=instance,
            experiment_name=name,
            extra_hyperparams=extra,
        )
        launched.append(job_name)
        # Small delay to avoid API throttling
        time.sleep(2)

    print(f"\n{'=' * 60}")
    print(f"Launched {len(launched)} jobs:")
    for jn in launched:
        print(f"  {jn}")
    print(f"\nMonitor all:")
    print(f"  aws sagemaker list-training-jobs --name-contains oo-numerai "
          f"--region ap-southeast-2 --profile cybergarden-dev --sort-by CreationTime")
    print(f"\nResults land in: s3://{S3_BUCKET}/jobs/<job-name>/metrics.json")


if __name__ == "__main__":
    main()
