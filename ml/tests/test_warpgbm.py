"""WarpGBM wrapper: fit/predict/save/load contract on synthetic data."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

pytest.importorskip("warpgbm")

from models import create_model  # noqa: E402
from models.warpgbm_model import WarpGBMModel  # noqa: E402


@pytest.fixture
def synth():
    rng = np.random.default_rng(7)
    n = 20000
    features = [f"feature_{i}" for i in range(12)]
    df = pd.DataFrame(rng.choice([0.0, 0.25, 0.5, 0.75, 1.0], (n, 12)), columns=features)
    df["era"] = np.repeat([f"{i:04d}" for i in range(20)], n // 20)
    df["target"] = (df["feature_0"] * 0.2 + rng.normal(0, 0.4, n)).astype(np.float32)
    return df, features


def test_factory_creates_warpgbm():
    model = create_model("warpgbm", n_estimators=5, max_depth=3)
    assert isinstance(model, WarpGBMModel)
    assert model.model_type == "warpgbm"


def test_fit_predict_learns_signal(synth, tmp_path):
    df, features = synth
    model = WarpGBMModel(n_estimators=40, learning_rate=0.1, max_depth=4, min_data_in_leaf=50, max_bin=5)
    info = model.fit(df, features, target_col="target", era_col="era")
    assert info["best_iteration"] == 40
    preds = model.predict(df, features)
    assert len(preds) == len(df)
    assert np.corrcoef(preds, df["target"])[0, 1] > 0.1

    model.save(tmp_path)
    loaded = WarpGBMModel()
    loaded.load(tmp_path)
    reloaded_preds = loaded.predict(df, features)
    np.testing.assert_allclose(preds.values, reloaded_preds.values, rtol=1e-4, atol=1e-5)


def test_int8_features_fast_path(synth):
    df, features = synth
    df[features] = (df[features] * 4).round().astype(np.int8)
    model = WarpGBMModel(n_estimators=10, max_depth=3, min_data_in_leaf=50, max_bin=5)
    model.fit(df, features, target_col="target", era_col="era")
    assert len(model.predict(df, features)) == len(df)


def test_era_buckets_partition():
    eras = pd.Series([f"{i:04d}" for i in range(100)])
    model = WarpGBMModel(era_buckets=4)
    ids = model._era_ids(eras)
    assert set(ids) == {0, 1, 2, 3}
    pooled = WarpGBMModel(era_buckets=1)._era_ids(eras)
    assert set(pooled) == {0}
