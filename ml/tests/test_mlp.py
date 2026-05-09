"""Tests for MLP model implementation."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

pytestmark = pytest.mark.skipif(not HAS_TORCH, reason="PyTorch not installed")


@pytest.fixture
def synthetic_data():
    """Small synthetic dataset for MLP testing."""
    np.random.seed(42)
    n_eras = 10
    rows_per_era = 100
    n_features = 20

    rows = []
    for i in range(n_eras):
        era = f"era_{i:03d}"
        features = np.random.randn(rows_per_era, n_features).astype(np.float32)
        target = (features[:, 0] * 0.3 + np.random.randn(rows_per_era) * 0.5).astype(np.float32)
        df = pd.DataFrame(features, columns=[f"feature_{j}" for j in range(n_features)])
        df["era"] = era
        df["target"] = target
        rows.append(df)

    return pd.concat(rows, ignore_index=True)


@pytest.fixture
def feature_cols():
    return [f"feature_{j}" for j in range(20)]


@pytest.fixture
def val_data():
    """Separate validation dataset."""
    np.random.seed(123)
    n_eras = 3
    rows_per_era = 100
    n_features = 20

    rows = []
    for i in range(n_eras):
        era = f"era_val_{i:03d}"
        features = np.random.randn(rows_per_era, n_features).astype(np.float32)
        target = (features[:, 0] * 0.3 + np.random.randn(rows_per_era) * 0.5).astype(np.float32)
        df = pd.DataFrame(features, columns=[f"feature_{j}" for j in range(n_features)])
        df["era"] = era
        df["target"] = target
        rows.append(df)

    return pd.concat(rows, ignore_index=True)


class TestMLPModel:
    def test_fit_and_predict(self, synthetic_data, feature_cols, val_data):
        from models.mlp_model import MLPModel

        model = MLPModel(
            hidden_dims=[32, 32],
            n_epochs=5,
            batch_size=128,
            early_stopping_rounds=3,
            learning_rate=0.01,
        )
        info = model.fit(
            synthetic_data, feature_cols, "target", "era",
            val_df=val_data,
        )

        assert "best_iteration" in info
        assert "best_score" in info

        preds = model.predict(synthetic_data, feature_cols)
        assert len(preds) == len(synthetic_data)
        assert preds.isna().sum() == 0
        assert isinstance(preds, pd.Series)

    def test_fit_without_val_df(self, synthetic_data, feature_cols):
        """Should fall back to era-based split."""
        from models.mlp_model import MLPModel

        model = MLPModel(
            hidden_dims=[16],
            n_epochs=3,
            batch_size=128,
            early_stopping_rounds=2,
        )
        info = model.fit(synthetic_data, feature_cols, "target", "era")
        assert info["best_iteration"] >= 0

    def test_save_and_load(self, synthetic_data, feature_cols, val_data, tmp_path):
        from models.mlp_model import MLPModel

        model = MLPModel(
            hidden_dims=[32, 32],
            n_epochs=5,
            batch_size=128,
            early_stopping_rounds=3,
        )
        model.fit(synthetic_data, feature_cols, "target", "era", val_df=val_data)
        preds_before = model.predict(synthetic_data, feature_cols)

        save_path = tmp_path / "mlp_model"
        model.save(save_path)

        # Load into fresh model
        model2 = MLPModel()
        model2.load(save_path)
        preds_after = model2.predict(synthetic_data, feature_cols)

        np.testing.assert_allclose(
            preds_before.values, preds_after.values, rtol=1e-5,
        )

    def test_model_type(self):
        from models.mlp_model import MLPModel
        model = MLPModel(hidden_dims=[16])
        assert model.model_type == "mlp"

    def test_epoch_callback(self, synthetic_data, feature_cols, val_data):
        from models.mlp_model import MLPModel

        callbacks = []
        model = MLPModel(
            hidden_dims=[16],
            n_epochs=5,
            batch_size=128,
            early_stopping_rounds=3,
        )
        model.fit(
            synthetic_data, feature_cols, "target", "era",
            epoch_callback=lambda info: callbacks.append(info),
            val_df=val_data,
        )

        assert len(callbacks) > 0
        assert "epoch" in callbacks[0]
        assert "train_loss" in callbacks[0]
        assert "val_loss" in callbacks[0]

    def test_predictions_differ_from_constant(self, synthetic_data, feature_cols, val_data):
        """MLP should produce non-constant predictions (actually learning)."""
        from models.mlp_model import MLPModel

        model = MLPModel(
            hidden_dims=[64, 64],
            n_epochs=20,
            batch_size=128,
            early_stopping_rounds=10,
            learning_rate=0.01,
        )
        model.fit(synthetic_data, feature_cols, "target", "era", val_df=val_data)
        preds = model.predict(synthetic_data, feature_cols)

        assert preds.std() > 0.01, "Predictions should not be near-constant"

    def test_handles_nan_features(self, feature_cols, val_data):
        """NaN features should be handled (filled with 0)."""
        from models.mlp_model import MLPModel

        np.random.seed(42)
        df = pd.DataFrame(
            np.random.randn(200, 20).astype(np.float32),
            columns=feature_cols,
        )
        df["era"] = "era_001"
        df["target"] = np.random.randn(200).astype(np.float32)
        # Inject NaNs
        df.iloc[0, 0] = np.nan
        df.iloc[5, 3] = np.nan

        model = MLPModel(hidden_dims=[16], n_epochs=3, batch_size=64, early_stopping_rounds=2)
        model.fit(df, feature_cols, "target", "era", val_df=val_data)
        preds = model.predict(df, feature_cols)
        assert preds.isna().sum() == 0


class TestMLPFactory:
    def test_create_mlp_via_factory(self):
        from models import create_model
        model = create_model(model_type="mlp", hidden_dims=[32])
        assert model.model_type == "mlp"

    def test_mlp_in_available_models(self):
        from models import list_available_models
        assert "mlp" in list_available_models()
