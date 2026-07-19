"""Download Numerai tournament data via numerapi.

Uses anonymous NumerAPI (no credentials needed for data download).
Downloads train, validation, live parquets, features.json metadata,
meta model, and benchmark model predictions (v5.3).
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd

from config.settings import get_ml_settings


DATA_DIR = Path(__file__).parent.parent / "data_cache"


@contextmanager
def _download_lock(dest: Path):
    """Serialize dataset downloads across processes.

    Parallel local training jobs share one data_cache/. Without a lock, two
    jobs downloading the same round race on numerapi's temp-file rename and
    corrupt the parquet. Holding an exclusive file lock during the download
    loop makes the first job download while others wait, then find everything
    cached. No-op if fcntl is unavailable (non-POSIX).
    """
    try:
        import fcntl
    except ImportError:
        yield
        return
    dest.mkdir(parents=True, exist_ok=True)
    lock_file = open(dest / ".download.lock", "w")  # noqa: SIM115
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
        finally:
            lock_file.close()

# Numerai v5.3 dataset paths ("Quantum" update, Jul 2026: +807 features,
# same targets). Cache filenames carry the version tag so bumping this
# constant never silently reuses a previous version's files for the round.
DATASET_VERSION = "v5.3"
DATASET_VERSION_TAG = DATASET_VERSION.replace(".", "")
DATASET_TRAIN = f"{DATASET_VERSION}/train.parquet"
DATASET_VALIDATION = f"{DATASET_VERSION}/validation.parquet"
DATASET_LIVE = f"{DATASET_VERSION}/live.parquet"
DATASET_FEATURES = f"{DATASET_VERSION}/features.json"
DATASET_META_MODEL = f"{DATASET_VERSION}/meta_model.parquet"
DATASET_TRAIN_BENCHMARKS = f"{DATASET_VERSION}/train_benchmark_models.parquet"
DATASET_VAL_BENCHMARKS = f"{DATASET_VERSION}/validation_benchmark_models.parquet"
DATASET_LIVE_BENCHMARKS = f"{DATASET_VERSION}/live_benchmark_models.parquet"
DATASET_VAL_EXAMPLE_PREDS = f"{DATASET_VERSION}/validation_example_preds.parquet"
DATASET_LIVE_EXAMPLE_PREDS = f"{DATASET_VERSION}/live_example_preds.parquet"


def _get_napi():
    """Get anonymous NumerAPI instance."""
    import numerapi
    return numerapi.NumerAPI()


def download_current_round(dest: Optional[Path] = None) -> Path:
    """Download the current Numerai tournament dataset.

    No credentials needed — NumerAPI() works anonymously for data download.
    Downloads train, validation, live parquets, features.json,
    meta model, and benchmark predictions.
    Caches by round number to avoid re-downloading.

    Returns path to the data directory.
    """
    dest = dest or DATA_DIR
    dest.mkdir(parents=True, exist_ok=True)

    with _download_lock(dest):
        return _download_round_files(dest)


def _download_round_files(dest: Path) -> Path:
    napi = _get_napi()
    current_round = napi.get_current_round()

    # The version tag sorts after untagged (older-version) files for the same
    # round, so the glob-based loaders below always pick the newest version.
    tag = f"_{DATASET_VERSION_TAG}"
    files = {
        f"train_r{current_round}{tag}.parquet": DATASET_TRAIN,
        f"validation_r{current_round}{tag}.parquet": DATASET_VALIDATION,
        f"live_r{current_round}{tag}.parquet": DATASET_LIVE,
        f"features_r{current_round}{tag}.json": DATASET_FEATURES,
        f"meta_model_r{current_round}{tag}.parquet": DATASET_META_MODEL,
        f"train_benchmarks_r{current_round}{tag}.parquet": DATASET_TRAIN_BENCHMARKS,
        f"val_benchmarks_r{current_round}{tag}.parquet": DATASET_VAL_BENCHMARKS,
        f"live_benchmarks_r{current_round}{tag}.parquet": DATASET_LIVE_BENCHMARKS,
        f"val_example_preds_r{current_round}{tag}.parquet": DATASET_VAL_EXAMPLE_PREDS,
        f"live_example_preds_r{current_round}{tag}.parquet": DATASET_LIVE_EXAMPLE_PREDS,
    }

    for local_name, remote_path in files.items():
        local_path = dest / local_name
        if not local_path.exists():
            print(f"  Downloading {remote_path} -> {local_name}...")
            napi.download_dataset(remote_path, str(local_path))
        else:
            print(f"  Using cached {local_name}")

    return dest


def load_feature_metadata(path: Optional[Path] = None) -> dict:
    """Load features.json metadata (feature sets, groups, etc.).

    Returns the parsed JSON dict with keys like 'feature_sets', 'feature_stats'.
    """
    data_dir = path or DATA_DIR
    files = sorted(data_dir.glob("features_r*.json"))
    if not files:
        raise FileNotFoundError(f"No features.json found in {data_dir}")

    with open(files[-1]) as f:
        return json.load(f)


def get_feature_set(metadata: dict, set_name: str = "medium") -> List[str]:
    """Get feature column names for a named feature set.

    Available sets in Numerai v5: small (42), medium (705), all (2376).
    """
    feature_sets = metadata.get("feature_sets", {})
    if set_name not in feature_sets:
        available = list(feature_sets.keys())
        raise ValueError(
            f"Feature set '{set_name}' not found. Available: {available}"
        )
    return feature_sets[set_name]


def _downcast_floats(df: pd.DataFrame) -> pd.DataFrame:
    """Downcast float64 columns to float32 to halve memory usage.

    Numerai features are quantized to 5 bins (0, 0.25, 0.5, 0.75, 1.0)
    so float32 has more than enough precision.
    """
    float_cols = df.select_dtypes(include=["float64"]).columns
    if len(float_cols) > 0:
        df[float_cols] = df[float_cols].astype("float32")
    return df


def load_train_data(
    path: Optional[Path] = None,
    columns: Optional[List[str]] = None,
) -> pd.DataFrame:
    """Load training data from parquet.

    Args:
        path: Data directory (defaults to DATA_DIR).
        columns: If provided, only load these columns (saves RAM).
    """
    data_dir = path or DATA_DIR
    files = sorted(data_dir.glob("train_r*.parquet"))
    if not files:
        raise FileNotFoundError(f"No training data found in {data_dir}")
    return _downcast_floats(pd.read_parquet(files[-1], columns=columns))


def load_validation_data(
    path: Optional[Path] = None,
    columns: Optional[List[str]] = None,
) -> pd.DataFrame:
    """Load validation data from parquet.

    Args:
        path: Data directory (defaults to DATA_DIR).
        columns: If provided, only load these columns (saves RAM).
    """
    data_dir = path or DATA_DIR
    files = sorted(data_dir.glob("validation_r*.parquet"))
    if not files:
        raise FileNotFoundError(f"No validation data found in {data_dir}")
    return _downcast_floats(pd.read_parquet(files[-1], columns=columns))


def load_live_data(
    path: Optional[Path] = None,
    columns: Optional[List[str]] = None,
) -> pd.DataFrame:
    """Load live data for generating predictions.

    Args:
        path: Data directory (defaults to DATA_DIR).
        columns: If provided, only load these columns (saves RAM).
    """
    data_dir = path or DATA_DIR
    files = sorted(data_dir.glob("live_r*.parquet"))
    if not files:
        raise FileNotFoundError(f"No live data found in {data_dir}")
    return _downcast_floats(pd.read_parquet(files[-1], columns=columns))


def load_meta_model(
    path: Optional[Path] = None,
) -> Optional[pd.DataFrame]:
    """Load meta model predictions for validation data.

    The meta model is available from era 1133 onwards.
    Returns None if not downloaded.
    """
    data_dir = path or DATA_DIR
    files = sorted(data_dir.glob("meta_model_r*.parquet"))
    if not files:
        return None
    return pd.read_parquet(files[-1])


def load_benchmark_models(
    path: Optional[Path] = None,
) -> Optional[pd.DataFrame]:
    """Load benchmark model predictions for validation data.

    Contains benchmark LightGBM models trained by Numerai on v5.3 data.
    """
    data_dir = path or DATA_DIR
    files = sorted(data_dir.glob("val_benchmarks_r*.parquet"))
    if not files:
        return None
    return pd.read_parquet(files[-1])


def load_example_predictions(
    split: str = "validation",
    path: Optional[Path] = None,
) -> Optional[pd.DataFrame]:
    """Load Numerai's example predictions for benchmarking.

    Args:
        split: "validation" or "live"
        path: Data directory
    """
    data_dir = path or DATA_DIR
    prefix = "val_example_preds" if split == "validation" else "live_example_preds"
    files = sorted(data_dir.glob(f"{prefix}_r*.parquet"))
    if not files:
        return None
    return pd.read_parquet(files[-1])


def load_train_benchmark_models(
    path: Optional[Path] = None,
) -> Optional[pd.DataFrame]:
    """Load benchmark model predictions for training data.

    Useful for training a model that is aware of benchmark predictions,
    or for computing train-set diagnostics.
    """
    data_dir = path or DATA_DIR
    files = sorted(data_dir.glob("train_benchmarks_r*.parquet"))
    if not files:
        return None
    return pd.read_parquet(files[-1])


def get_current_round(dest: Optional[Path] = None) -> int:
    """Get the current Numerai tournament round number."""
    napi = _get_napi()
    return napi.get_current_round()
