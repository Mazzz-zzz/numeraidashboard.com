"""Tests for LightGBM model with synthetic data."""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from models.lgbm_model import LightGBMModel
from training.validate import (
    compute_all_metrics,
    mean_correlation,
    max_drawdown,
    per_era_correlation,
    sharpe_ratio,
)


class TestLightGBMModel:
    def test_fit_and_predict(self, synthetic_data, feature_cols):
        model = LightGBMModel(
            num_leaves=8,
            n_estimators=50,
            learning_rate=0.1,
            early_stopping_rounds=10,
        )

        info = model.fit(synthetic_data, feature_cols)
        assert "best_iteration" in info
        assert info["train_eras"] > 0
        assert info["val_eras"] > 0

        preds = model.predict(synthetic_data, feature_cols)
        assert len(preds) == len(synthetic_data)
        assert not preds.isna().any()

    def test_save_and_load(self, synthetic_data, feature_cols, tmp_path):
        model = LightGBMModel(
            num_leaves=8, n_estimators=20, learning_rate=0.1, early_stopping_rounds=5
        )
        model.fit(synthetic_data, feature_cols)
        preds_before = model.predict(synthetic_data, feature_cols)

        model.save(tmp_path / "test_model")

        loaded = LightGBMModel()
        loaded.load(tmp_path / "test_model")
        preds_after = loaded.predict(synthetic_data, feature_cols)

        np.testing.assert_allclose(preds_before.values, preds_after.values, atol=1e-10)

    def test_model_type(self):
        model = LightGBMModel()
        assert model.model_type == "lgbm"


class TestValidationMetrics:
    @pytest.fixture(autouse=True)
    def _setup(self, synthetic_data, feature_cols):
        model = LightGBMModel(
            num_leaves=8, n_estimators=50, learning_rate=0.1, early_stopping_rounds=10
        )
        model.fit(synthetic_data, feature_cols)
        synthetic_data["prediction"] = model.predict(synthetic_data, feature_cols)
        self.df = synthetic_data
        self.feature_cols = feature_cols

    def test_per_era_correlation(self):
        era_corrs = per_era_correlation(self.df)
        assert len(era_corrs) == self.df["era"].nunique()
        assert not era_corrs.isna().all()

    def test_mean_correlation_positive(self):
        corr = mean_correlation(self.df)
        # With synthetic data where target correlates with feature_0,
        # LightGBM should find some signal
        assert corr > 0

    def test_sharpe_ratio(self):
        sr = sharpe_ratio(self.df)
        assert isinstance(sr, float)

    def test_max_drawdown_negative(self):
        dd = max_drawdown(self.df)
        assert dd <= 0

    def test_compute_all_metrics(self):
        metrics = compute_all_metrics(self.df, feature_cols=self.feature_cols)
        assert "correlation" in metrics
        assert "sharpe" in metrics
        assert "max_drawdown" in metrics
        assert "feature_exposure" in metrics
        assert metrics["max_drawdown"] <= 0
