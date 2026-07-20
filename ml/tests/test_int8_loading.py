"""int8 feature loading: lossless for quantized features, opt-in via env."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from data import download


QUANT = [0.0, 0.25, 0.5, 0.75, 1.0]


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    rng = np.random.default_rng(7)
    n = 200
    df = pd.DataFrame(
        {
            "era": np.repeat([f"{i:04d}" for i in range(1, 5)], n // 4),
            "feature_alpha": rng.choice(QUANT, n).astype("float32"),
            "feature_beta": rng.choice(QUANT, n).astype("float32"),
            "target_ender_20": rng.random(n).astype("float32"),
        },
        index=pd.Index([f"id_{i}" for i in range(n)], name="id"),
    )
    df.to_parquet(tmp_path / "train_r9999_v53.parquet")
    return tmp_path, df


def _load(tmp_path, columns):
    return download.load_train_data(tmp_path, columns=columns)


def test_float_path_unchanged_by_default(data_dir, monkeypatch):
    tmp_path, original = data_dir
    monkeypatch.delenv("ML_FEATURE_DTYPE", raising=False)
    df = _load(tmp_path, ["era", "feature_alpha", "feature_beta", "target_ender_20"])
    assert df["feature_alpha"].dtype == np.float32
    pd.testing.assert_frame_equal(df, original)


def test_int8_features_lossless(data_dir, monkeypatch):
    tmp_path, original = data_dir
    monkeypatch.setenv("ML_FEATURE_DTYPE", "int8")
    df = _load(tmp_path, ["era", "feature_alpha", "feature_beta", "target_ender_20"])

    for col in ("feature_alpha", "feature_beta"):
        assert df[col].dtype == np.int8
        np.testing.assert_array_equal(df[col].to_numpy(), (original[col] * 4).round().astype(np.int8))
    # Non-feature columns keep their dtypes and values; index preserved.
    assert df["target_ender_20"].dtype == np.float32
    pd.testing.assert_series_equal(df["target_ender_20"], original["target_ender_20"])
    pd.testing.assert_index_equal(df.index, original.index)


def test_int8_ignored_without_feature_columns(data_dir, monkeypatch):
    tmp_path, original = data_dir
    monkeypatch.setenv("ML_FEATURE_DTYPE", "int8")
    df = _load(tmp_path, ["era", "target_ender_20"])
    pd.testing.assert_frame_equal(df, original[["era", "target_ender_20"]])


def test_int8_handles_nan_as_median_bin(tmp_path, monkeypatch):
    df = pd.DataFrame(
        {"feature_alpha": [0.0, np.nan, 1.0], "target_ender_20": [0.1, 0.2, 0.3]},
        index=pd.Index(["a", "b", "c"], name="id"),
    )
    df.to_parquet(tmp_path / "train_r9999_v53.parquet")
    monkeypatch.setenv("ML_FEATURE_DTYPE", "int8")
    out = download.load_train_data(tmp_path, columns=["feature_alpha", "target_ender_20"])
    np.testing.assert_array_equal(out["feature_alpha"].to_numpy(), np.array([0, 2, 4], dtype=np.int8))
