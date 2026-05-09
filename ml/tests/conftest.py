"""Shared fixtures for ML tests."""

from __future__ import annotations

from typing import Dict, List

import numpy as np
import pandas as pd
import pytest


@pytest.fixture
def synthetic_data() -> pd.DataFrame:
    """Create synthetic Numerai-like data for testing.

    50 eras, 100 rows each, 10 features (binned 0-4 like real Numerai),
    multiple targets, id index.
    """
    rng = np.random.RandomState(42)
    n_eras = 50
    rows_per_era = 100
    n_features = 10

    rows = []
    for era in range(n_eras):
        features = rng.randint(0, 5, size=(rows_per_era, n_features)).astype(float)
        # Primary target weakly correlated with feature 0
        target = 0.5 + 0.1 * (features[:, 0] - 2) + 0.05 * rng.randn(rows_per_era)
        target = np.clip(target, 0, 1)

        for i in range(rows_per_era):
            row_id = f"stock_{era:04d}_{i:04d}"
            row = {
                "id": row_id,
                "era": f"era_{era:04d}",
                "target": target[i],
                "target_cyrusd_20": np.clip(target[i] + 0.02 * rng.randn(), 0, 1),
                "target_alpha_20": np.clip(target[i] + 0.03 * rng.randn(), 0, 1),
            }
            for j in range(n_features):
                row[f"feature_{j}"] = features[i, j]
            rows.append(row)

    df = pd.DataFrame(rows)
    df = df.set_index("id")
    return df


@pytest.fixture
def feature_cols() -> List[str]:
    return [f"feature_{i}" for i in range(10)]


@pytest.fixture
def target_cols() -> List[str]:
    return ["target", "target_cyrusd_20", "target_alpha_20"]


@pytest.fixture
def feature_metadata() -> dict:
    """Synthetic features.json metadata for testing."""
    feature_stats = {}
    groups = ["intelligence", "charisma", "strength", "dexterity", "constitution"]
    for i in range(10):
        group = groups[i % len(groups)]
        feature_stats[f"feature_{i}"] = {"group": group}

    return {
        "feature_sets": {
            "small": [f"feature_{i}" for i in range(5)],
            "medium": [f"feature_{i}" for i in range(10)],
        },
        "feature_stats": feature_stats,
    }
