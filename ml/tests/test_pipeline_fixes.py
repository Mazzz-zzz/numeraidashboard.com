"""Tests for pipeline fixes: per-era neutralization, exposure-based selection,
weak target filtering, and updated defaults."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from config.settings import MlSettings
from data.features import neutralize_features, _neutralize_chunk
from training.validate import (
    per_era_correlation,
    top_exposure_features,
    feature_exposure,
)


# ── Fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture
def multi_era_df():
    """Synthetic DataFrame with 3 eras, 5 features, and a target."""
    np.random.seed(42)
    n_per_era = 200
    eras = []
    for era_id in ["era_001", "era_002", "era_003"]:
        rows = pd.DataFrame({
            "era": era_id,
            "feature_0": np.random.randn(n_per_era),
            "feature_1": np.random.randn(n_per_era),
            "feature_2": np.random.randn(n_per_era),
            "feature_3": np.random.randn(n_per_era),
            "feature_4": np.random.randn(n_per_era),
            "target": np.random.randn(n_per_era),
        })
        eras.append(rows)
    df = pd.concat(eras, ignore_index=True)
    # Make feature_0 highly correlated with predictions
    df["prediction"] = 0.8 * df["feature_0"] + 0.2 * np.random.randn(len(df))
    return df


@pytest.fixture
def feature_cols():
    return ["feature_0", "feature_1", "feature_2", "feature_3", "feature_4"]


# ── Fix 4: Per-era neutralization ─────────────────────────────────────────


class TestPerEraNeutralization:
    def test_per_era_reduces_exposure_better_than_global(self, multi_era_df, feature_cols):
        """Per-era neutralization should reduce per-era exposure more effectively."""
        df = multi_era_df.copy()

        global_result = neutralize_features(
            df, "prediction", feature_cols, proportion=0.5,
        )
        per_era_result = neutralize_features(
            df, "prediction", feature_cols, proportion=0.5, era_col="era",
        )

        # Measure per-era exposure for both
        df_global = df.copy()
        df_global["prediction"] = global_result
        exp_global = feature_exposure(df_global, "prediction", feature_cols, "era")

        df_per_era = df.copy()
        df_per_era["prediction"] = per_era_result
        exp_per_era = feature_exposure(df_per_era, "prediction", feature_cols, "era")

        assert exp_per_era <= exp_global + 0.01  # per-era should be at least as good

    def test_single_era_matches_global(self, feature_cols):
        """With one era, per-era and global should give identical results."""
        np.random.seed(42)
        n = 200
        df = pd.DataFrame({
            "era": "era_001",
            "prediction": np.random.randn(n),
            **{f: np.random.randn(n) for f in feature_cols},
        })

        global_result = neutralize_features(df, "prediction", feature_cols, proportion=0.5)
        per_era_result = neutralize_features(
            df, "prediction", feature_cols, proportion=0.5, era_col="era",
        )
        pd.testing.assert_series_equal(global_result, per_era_result, atol=1e-10)

    def test_preserves_index(self, multi_era_df, feature_cols):
        """Returned Series should have the same index as input."""
        result = neutralize_features(
            multi_era_df, "prediction", feature_cols, proportion=0.5, era_col="era",
        )
        assert list(result.index) == list(multi_era_df.index)

    def test_skips_small_eras(self, feature_cols):
        """Eras with too few rows should keep predictions unchanged."""
        np.random.seed(42)
        # 2 rows in era_tiny — fewer than len(features) + 2 = 7
        tiny = pd.DataFrame({
            "era": "era_tiny",
            "prediction": [1.0, 2.0],
            **{f: np.random.randn(2) for f in feature_cols},
        })
        big = pd.DataFrame({
            "era": "era_big",
            "prediction": np.random.randn(100),
            **{f: np.random.randn(100) for f in feature_cols},
        })
        df = pd.concat([tiny, big], ignore_index=True)

        result = neutralize_features(
            df, "prediction", feature_cols, proportion=1.0, era_col="era",
        )
        # Tiny era predictions should be unchanged
        np.testing.assert_array_equal(result.iloc[:2].values, [1.0, 2.0])

    def test_without_era_col_backward_compat(self, multi_era_df, feature_cols):
        """Calling without era_col should work identically to old behavior."""
        result = neutralize_features(
            multi_era_df, "prediction", feature_cols, proportion=0.5,
        )
        assert isinstance(result, pd.Series)
        assert len(result) == len(multi_era_df)

    def test_neutralize_chunk_basic(self):
        """_neutralize_chunk should reduce correlation with exposure."""
        np.random.seed(42)
        n = 200
        exposure = np.random.randn(n)
        predictions = 0.8 * exposure + 0.2 * np.random.randn(n)
        exposures = exposure.reshape(-1, 1)

        adjusted = _neutralize_chunk(predictions, exposures, proportion=1.0)

        # Correlation should be reduced
        orig_corr = abs(np.corrcoef(predictions, exposure)[0, 1])
        adj_corr = abs(np.corrcoef(adjusted, exposure)[0, 1])
        assert adj_corr < orig_corr


# ── Fix 1: Exposure-based neutralizer selection ───────────────────────────


class TestTopExposureFeatures:
    def test_selects_correlated_features(self, multi_era_df, feature_cols):
        """feature_0 is highly correlated with predictions, should be selected first."""
        result = top_exposure_features(
            multi_era_df, "prediction", feature_cols, "era", top_n=2,
        )
        assert "feature_0" in result
        assert len(result) == 2

    def test_returns_correct_count(self, multi_era_df, feature_cols):
        result = top_exposure_features(
            multi_era_df, "prediction", feature_cols, "era", top_n=3,
        )
        assert len(result) == 3

    def test_returns_all_if_top_n_exceeds(self, multi_era_df, feature_cols):
        result = top_exposure_features(
            multi_era_df, "prediction", feature_cols, "era", top_n=100,
        )
        assert len(result) == len(feature_cols)

    def test_empty_features_returns_empty(self, multi_era_df):
        result = top_exposure_features(
            multi_era_df, "prediction", [], "era", top_n=5,
        )
        assert result == []

    def test_all_small_eras_returns_empty(self, feature_cols):
        """If all eras have fewer than 5 rows, return empty."""
        df = pd.DataFrame({
            "era": ["a", "a", "b", "b"],
            "prediction": [1, 2, 3, 4],
            **{f: np.random.randn(4) for f in feature_cols},
        })
        result = top_exposure_features(df, "prediction", feature_cols, "era", top_n=3)
        assert result == []

    def test_ordered_by_exposure(self, feature_cols):
        """Features should be ordered from highest to lowest exposure."""
        np.random.seed(42)
        n = 500
        df = pd.DataFrame({
            "era": np.repeat(["era_1", "era_2"], n // 2),
            "feature_0": np.random.randn(n),
            "feature_1": np.random.randn(n),
            "feature_2": np.random.randn(n),
            "feature_3": np.random.randn(n),
            "feature_4": np.random.randn(n),
        })
        # Make feature_2 strongly correlated, feature_4 moderately
        df["prediction"] = 0.9 * df["feature_2"] + 0.3 * df["feature_4"] + 0.1 * np.random.randn(n)

        result = top_exposure_features(df, "prediction", feature_cols, "era", top_n=5)
        assert result[0] == "feature_2"  # highest exposure


# ── Fix 3: Weak target filtering ─────────────────────────────────────────


class TestWeakTargetFiltering:
    def test_random_target_has_low_correlation(self):
        """Random predictions should have near-zero per-era correlation."""
        np.random.seed(42)
        n = 1000
        df = pd.DataFrame({
            "era": np.repeat([f"era_{i}" for i in range(10)], n // 10),
            "target": np.random.randn(n),
            "prediction": np.random.randn(n),  # random = no signal
        })
        corrs = per_era_correlation(df, "prediction", "target", "era")
        mean_corr = abs(corrs.mean())
        assert mean_corr < 0.10  # should be near zero (with 10 eras, noise can be ~0.06)

    def test_correlated_predictions_have_high_correlation(self):
        """Predictions correlated with target should have positive per-era correlation."""
        np.random.seed(42)
        n = 1000
        target = np.random.randn(n)
        df = pd.DataFrame({
            "era": np.repeat([f"era_{i}" for i in range(10)], n // 10),
            "target": target,
            "prediction": target + 0.3 * np.random.randn(n),
        })
        corrs = per_era_correlation(df, "prediction", "target", "era")
        assert corrs.mean() > 0.5  # strong signal should survive

    def test_min_target_correlation_setting(self):
        """Default min_target_correlation should be 0.01."""
        settings = MlSettings()
        assert settings.min_target_correlation == 0.01


# ── Fix 2: Default settings ──────────────────────────────────────────────


class TestDefaultSettings:
    def test_s3_bucket_has_no_operator_default(self, monkeypatch):
        monkeypatch.delenv("ML_S3_BUCKET", raising=False)
        settings = MlSettings()
        assert settings.s3_bucket == ""

    def test_neutralization_default_is_025(self):
        settings = MlSettings()
        assert settings.neutralization_proportion == 0.25

    def test_neutralization_top_n_default(self):
        settings = MlSettings()
        assert settings.neutralization_top_n == 50

    def test_min_target_correlation_exists(self):
        settings = MlSettings()
        assert hasattr(settings, "min_target_correlation")


# ── Phase 1: Regularization params & single-target mode ──────────────────


class TestRegularizationParams:
    def test_reg_params_exist_in_settings(self):
        settings = MlSettings()
        assert hasattr(settings, "default_reg_alpha")
        assert hasattr(settings, "default_reg_lambda")
        assert hasattr(settings, "default_min_split_gain")
        assert hasattr(settings, "default_path_smooth")
        assert hasattr(settings, "default_max_bin")

    def test_reg_params_defaults_are_zero(self):
        """Default reg params should be zero (no regularization) for backward compat."""
        settings = MlSettings()
        assert settings.default_reg_alpha == 0.0
        assert settings.default_reg_lambda == 0.0
        assert settings.default_min_split_gain == 0.0
        assert settings.default_path_smooth == 0.0
        assert settings.default_max_bin == 255

    def test_reg_params_pass_through_to_lgbm(self):
        """Kwargs should flow through create_model to LightGBMModel.params."""
        from models import create_model
        model = create_model(
            model_type="lgbm",
            reg_alpha=0.1,
            reg_lambda=1.0,
            min_split_gain=0.01,
            path_smooth=10.0,
            max_bin=127,
        )
        assert model.params["reg_alpha"] == 0.1
        assert model.params["reg_lambda"] == 1.0
        assert model.params["min_split_gain"] == 0.01
        assert model.params["path_smooth"] == 10.0
        assert model.params["max_bin"] == 127


class TestSingleTargetMode:
    def test_single_target_mode_default_off(self):
        settings = MlSettings()
        assert settings.single_target_mode is False

    def test_single_target_mode_setting(self):
        import os
        os.environ["ML_SINGLE_TARGET_MODE"] = "true"
        try:
            settings = MlSettings()
            assert settings.single_target_mode is True
        finally:
            del os.environ["ML_SINGLE_TARGET_MODE"]

    def test_target_col_configurable(self):
        import os
        os.environ["ML_TARGET_COL"] = "target_ender_20"
        try:
            settings = MlSettings()
            assert settings.target_col == "target_ender_20"
        finally:
            del os.environ["ML_TARGET_COL"]
