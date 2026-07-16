"""Contracts for the local XGBoost model adapter."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from models import create_model, list_available_models
from models.xgboost_model import XGBoostModel


@pytest.fixture
def xgboost_data() -> tuple[pd.DataFrame, list[str]]:
    rng = np.random.default_rng(42)
    feature_cols = [f"feature_{index}" for index in range(4)]
    frames = []
    for era in range(12):
        features = rng.normal(size=(30, len(feature_cols))).astype(np.float32)
        frame = pd.DataFrame(features, columns=feature_cols)
        frame["era"] = f"era_{era:03d}"
        frame["target"] = 0.5 + 0.2 * features[:, 0] + rng.normal(0, 0.03, len(frame))
        frames.append(frame)
    return pd.concat(frames, ignore_index=True), feature_cols


@pytest.fixture
def trained_xgboost(xgboost_data):
    data, feature_cols = xgboost_data
    progress = []
    model = create_model(
        "xgboost",
        n_estimators=30,
        learning_rate=0.1,
        max_depth=3,
        feature_fraction=0.8,
        bagging_fraction=0.8,
        early_stopping_rounds=5,
    )
    info = model.fit(
        data,
        feature_cols,
        epoch_callback=progress.append,
        sample_weight=np.ones(len(data), dtype=np.float32),
    )
    return model, data, feature_cols, info, progress


def test_factory_trains_and_reports_progress(trained_xgboost):
    model, data, feature_cols, info, progress = trained_xgboost

    assert isinstance(model, XGBoostModel)
    assert model.model_type == "xgboost"
    assert "xgboost" in list_available_models()
    assert info["train_eras"] == 9
    assert info["val_eras"] == 3
    assert info["best_iteration"] >= 0
    assert progress
    assert {"epoch", "train_loss", "val_loss"} <= progress[0].keys()

    predictions = model.predict(data, feature_cols)
    assert predictions.index.equals(data.index)
    assert np.isfinite(predictions).all()
    assert predictions.std() > 0


def test_model_round_trips_predictions(trained_xgboost, tmp_path):
    model, data, feature_cols, _, _ = trained_xgboost
    predictions = model.predict(data, feature_cols)
    model_path = tmp_path / "xgboost-model"
    model.save(model_path)

    restored = XGBoostModel()
    restored.load(model_path)
    restored_predictions = restored.predict(data, feature_cols)

    assert (model_path / "model.ubj").is_file()
    assert (model_path / "meta.json").is_file()
    np.testing.assert_allclose(predictions, restored_predictions, rtol=1e-6, atol=1e-6)
