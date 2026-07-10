"""Download Numerai Signals v2.1 data via numerapi.

Uses SignalsAPI (no credentials needed for data download).
Downloads train, validation, live parquets, plus neutralizer matrices
and sample weights unique to the Signals tournament.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

import pandas as pd

DATA_DIR = Path(__file__).parent.parent / "signals_data_cache"

# Numerai Signals v2.1 dataset paths (Alpha update, Jul 2025)
DATASET_VERSION = "v2.1"

SIGNALS_FILES = {
    "train.parquet": f"{DATASET_VERSION}/train.parquet",
    "train_neutralizer.parquet": f"{DATASET_VERSION}/train_neutralizer.parquet",
    "train_sample_weights.parquet": f"{DATASET_VERSION}/train_sample_weights.parquet",
    "validation.parquet": f"{DATASET_VERSION}/validation.parquet",
    "validation_neutralizer.parquet": f"{DATASET_VERSION}/validation_neutralizer.parquet",
    "validation_sample_weights.parquet": f"{DATASET_VERSION}/validation_sample_weights.parquet",
    "validation_example_preds.parquet": f"{DATASET_VERSION}/validation_example_preds.parquet",
    "live.parquet": f"{DATASET_VERSION}/live.parquet",
    "live_example_preds.parquet": f"{DATASET_VERSION}/live_example_preds.parquet",
}


def _get_signals_api():
    """Get anonymous SignalsAPI instance."""
    from numerapi import SignalsAPI
    return SignalsAPI()


def download_signals_data(dest: Optional[Path] = None) -> Path:
    """Download the current Numerai Signals dataset.

    No credentials needed — SignalsAPI() works anonymously for data download.
    Downloads train, validation, live parquets, neutralizer matrices,
    and sample weight vectors.

    Returns path to the data directory.
    """
    dest = dest or DATA_DIR
    dest.mkdir(parents=True, exist_ok=True)

    api = _get_signals_api()

    for local_name, remote_path in SIGNALS_FILES.items():
        local_path = dest / local_name
        if not local_path.exists():
            print(f"  Downloading {remote_path} -> {local_name}...")
            api.download_dataset(remote_path, str(local_path))
        else:
            print(f"  Using cached {local_name}")

    return dest


def load_signals_train(
    path: Optional[Path] = None,
    columns: Optional[List[str]] = None,
) -> pd.DataFrame:
    """Load Signals training data."""
    data_dir = path or DATA_DIR
    fpath = data_dir / "train.parquet"
    if not fpath.exists():
        raise FileNotFoundError(f"No Signals training data at {fpath}")
    return pd.read_parquet(fpath, columns=columns)


def load_signals_validation(
    path: Optional[Path] = None,
    columns: Optional[List[str]] = None,
) -> pd.DataFrame:
    """Load Signals validation data (expands weekly)."""
    data_dir = path or DATA_DIR
    fpath = data_dir / "validation.parquet"
    if not fpath.exists():
        raise FileNotFoundError(f"No Signals validation data at {fpath}")
    return pd.read_parquet(fpath, columns=columns)


def load_signals_live(
    path: Optional[Path] = None,
    columns: Optional[List[str]] = None,
) -> pd.DataFrame:
    """Load Signals live data (changes daily)."""
    data_dir = path or DATA_DIR
    fpath = data_dir / "live.parquet"
    if not fpath.exists():
        raise FileNotFoundError(f"No Signals live data at {fpath}")
    return pd.read_parquet(fpath, columns=columns)


def load_signals_neutralizer(
    split: str = "train",
    path: Optional[Path] = None,
) -> Optional[pd.DataFrame]:
    """Load neutralizer matrix for a given split.

    The neutralizer matrix is used by Signals Alpha and MPC to neutralize
    your signal. Training with this matrix makes your model neutralization-aware.

    Args:
        split: "train" or "validation"
        path: Data directory
    """
    data_dir = path or DATA_DIR
    fpath = data_dir / f"{split}_neutralizer.parquet"
    if not fpath.exists():
        return None
    return pd.read_parquet(fpath)


def load_signals_sample_weights(
    split: str = "train",
    path: Optional[Path] = None,
) -> Optional[pd.DataFrame]:
    """Load sample weights for a given split.

    Signals Alpha and MPC use sample weights to weight your signal after
    neutralization. Training with these weights makes your model
    sample-weight-aware.

    Args:
        split: "train" or "validation"
        path: Data directory
    """
    data_dir = path or DATA_DIR
    fpath = data_dir / f"{split}_sample_weights.parquet"
    if not fpath.exists():
        return None
    return pd.read_parquet(fpath)


def get_signals_feature_columns(df: pd.DataFrame, prefix: str = "feature_") -> List[str]:
    """Discover feature columns from the dataframe itself.

    Unlike Classic which has a features.json, Signals features are
    discovered directly from the parquet columns.
    """
    return [c for c in df.columns if c.startswith(prefix)]


def get_signals_target_columns(df: pd.DataFrame, prefix: str = "target") -> List[str]:
    """Discover target columns from the dataframe."""
    return [c for c in df.columns if c.startswith(prefix)]
