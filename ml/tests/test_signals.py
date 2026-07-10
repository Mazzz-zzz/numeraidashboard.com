"""Tests for Signals-specific features: sample weights, Alpha metric, example benchmarking."""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from models.lgbm_model import LightGBMModel
from training.validate import (
    compute_all_metrics,
    example_predictions_comparison,
    signals_alpha,
)


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def sample_weights(synthetic_data):
    """Create sample weights (some rows more important than others)."""
    rng = np.random.RandomState(99)
    weights = rng.uniform(0.5, 2.0, size=len(synthetic_data))
    return pd.DataFrame(
        {"weight": weights},
        index=synthetic_data.index,
    )


@pytest.fixture
def neutralizer(synthetic_data):
    """Create a synthetic neutralizer matrix (2 neutralizer columns)."""
    rng = np.random.RandomState(77)
    return pd.DataFrame(
        {
            "neut_0": rng.randn(len(synthetic_data)),
            "neut_1": rng.randn(len(synthetic_data)),
        },
        index=synthetic_data.index,
    )


@pytest.fixture
def example_preds(synthetic_data):
    """Create example predictions (simulating Numerai's baseline)."""
    rng = np.random.RandomState(55)
    # Weakly correlated with target (like a mediocre baseline)
    preds = synthetic_data["target"] * 0.3 + rng.randn(len(synthetic_data)) * 0.1
    preds = preds.rank(pct=True)
    return pd.DataFrame({"prediction": preds}, index=synthetic_data.index)


@pytest.fixture
def trained_df(synthetic_data, feature_cols):
    """Synthetic data with a trained model's predictions added."""
    model = LightGBMModel(
        num_leaves=8, n_estimators=50, learning_rate=0.1, early_stopping_rounds=10,
    )
    model.fit(synthetic_data, feature_cols)
    synthetic_data["prediction"] = model.predict(synthetic_data, feature_cols)
    return synthetic_data


# ── Sample weight tests ──────────────────────────────────────────────


class TestSampleWeights:
    def test_lgbm_accepts_sample_weight(self, synthetic_data, feature_cols, sample_weights):
        """LightGBM should train without error when sample weights are provided."""
        model = LightGBMModel(
            num_leaves=8, n_estimators=50, learning_rate=0.1, early_stopping_rounds=10,
        )
        info = model.fit(
            synthetic_data, feature_cols,
            sample_weight=sample_weights["weight"].values,
        )
        assert "best_iteration" in info
        assert info["best_iteration"] > 0

        preds = model.predict(synthetic_data, feature_cols)
        assert len(preds) == len(synthetic_data)
        assert not preds.isna().any()

    def test_sample_weight_changes_predictions(self, synthetic_data, feature_cols, sample_weights):
        """Training with vs without sample weights should produce different predictions."""
        model_no_weight = LightGBMModel(
            num_leaves=8, n_estimators=50, learning_rate=0.1, early_stopping_rounds=10,
        )
        model_no_weight.fit(synthetic_data, feature_cols)
        preds_no_weight = model_no_weight.predict(synthetic_data, feature_cols)

        model_weighted = LightGBMModel(
            num_leaves=8, n_estimators=50, learning_rate=0.1, early_stopping_rounds=10,
        )
        model_weighted.fit(
            synthetic_data, feature_cols,
            sample_weight=sample_weights["weight"].values,
        )
        preds_weighted = model_weighted.predict(synthetic_data, feature_cols)

        # Predictions should differ (not identical)
        assert not np.allclose(preds_no_weight.values, preds_weighted.values, atol=1e-6)

    def test_uniform_weights_match_no_weights(self, synthetic_data, feature_cols):
        """Uniform weights of 1.0 should produce same results as no weights."""
        model_no_weight = LightGBMModel(
            num_leaves=8, n_estimators=30, learning_rate=0.1, early_stopping_rounds=5,
        )
        model_no_weight.fit(synthetic_data, feature_cols)
        preds_no = model_no_weight.predict(synthetic_data, feature_cols)

        uniform = np.ones(len(synthetic_data))
        model_uniform = LightGBMModel(
            num_leaves=8, n_estimators=30, learning_rate=0.1, early_stopping_rounds=5,
        )
        model_uniform.fit(synthetic_data, feature_cols, sample_weight=uniform)
        preds_uni = model_uniform.predict(synthetic_data, feature_cols)

        np.testing.assert_allclose(preds_no.values, preds_uni.values, atol=1e-6)


# ── Signals Alpha metric tests ───────────────────────────────────────


class TestSignalsAlpha:
    def test_alpha_returns_float(self, trained_df):
        alpha = signals_alpha(trained_df)
        assert isinstance(alpha, float)

    def test_alpha_with_neutralizer(self, trained_df, neutralizer):
        """Alpha with neutralizer should differ from raw correlation."""
        raw = signals_alpha(trained_df)
        neutralized = signals_alpha(trained_df, neutralizer=neutralizer)
        # Should be different (neutralization changes the signal)
        assert raw != neutralized

    def test_alpha_with_sample_weights(self, trained_df, sample_weights):
        """Alpha with sample weights should differ from raw correlation."""
        raw = signals_alpha(trained_df)
        weighted = signals_alpha(trained_df, sample_weights=sample_weights)
        assert raw != weighted

    def test_alpha_with_both(self, trained_df, neutralizer, sample_weights):
        """Alpha with both neutralizer and weights should work."""
        alpha = signals_alpha(
            trained_df,
            neutralizer=neutralizer,
            sample_weights=sample_weights,
        )
        assert isinstance(alpha, float)
        assert not np.isnan(alpha)

    def test_alpha_no_extras_matches_mean_corr(self, trained_df):
        """Without neutralizer or weights, alpha equals mean correlation."""
        from training.validate import mean_correlation
        alpha = signals_alpha(trained_df)
        corr = mean_correlation(trained_df)
        assert abs(alpha - corr) < 1e-10


# ── Example predictions comparison tests ─────────────────────────────


class TestExampleComparison:
    def test_returns_metrics(self, trained_df, example_preds):
        result = example_predictions_comparison(trained_df, example_preds)
        assert "our_correlation" in result
        assert "example_correlation" in result
        assert "delta" in result

    def test_delta_is_difference(self, trained_df, example_preds):
        result = example_predictions_comparison(trained_df, example_preds)
        assert abs(result["delta"] - (result["our_correlation"] - result["example_correlation"])) < 1e-10

    def test_empty_overlap_returns_empty(self, trained_df):
        """No overlapping indices → empty result."""
        bad_preds = pd.DataFrame(
            {"prediction": [0.5]},
            index=pd.Index(["nonexistent_id"]),
        )
        result = example_predictions_comparison(trained_df, bad_preds)
        assert result == {}


# ── compute_all_metrics integration tests ────────────────────────────


class TestComputeAllMetricsSignals:
    def test_includes_alpha_when_neutralizer_provided(self, trained_df, neutralizer):
        metrics = compute_all_metrics(
            trained_df, neutralizer=neutralizer,
        )
        assert "signals_alpha" in metrics
        assert isinstance(metrics["signals_alpha"], float)

    def test_includes_alpha_when_weights_provided(self, trained_df, sample_weights):
        metrics = compute_all_metrics(
            trained_df, sample_weights=sample_weights,
        )
        assert "signals_alpha" in metrics

    def test_includes_vs_example(self, trained_df, example_preds):
        metrics = compute_all_metrics(
            trained_df, example_preds=example_preds,
        )
        assert "vs_example" in metrics
        assert "delta" in metrics["vs_example"]

    def test_no_extras_omits_alpha(self, trained_df):
        """Without neutralizer/weights, signals_alpha is not in output."""
        metrics = compute_all_metrics(trained_df)
        assert "signals_alpha" not in metrics
        assert "vs_example" not in metrics

    def test_full_signals_metrics(self, trained_df, feature_cols, neutralizer, sample_weights, example_preds):
        """Full Signals metric suite: all keys present."""
        metrics = compute_all_metrics(
            trained_df,
            feature_cols=feature_cols,
            neutralizer=neutralizer,
            sample_weights=sample_weights,
            example_preds=example_preds,
        )
        assert "correlation" in metrics
        assert "sharpe" in metrics
        assert "max_drawdown" in metrics
        assert "feature_exposure" in metrics
        assert "signals_alpha" in metrics
        assert "vs_example" in metrics
