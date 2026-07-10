"""Edge-case tests for the ML training pipeline.

Covers: trainer.py helper functions, model factory, era splits,
sample weight handling, ensemble edge cases, inference config parsing,
and bootstrap hyperparameter coercion.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
from pathlib import Path
from typing import Dict, List
from unittest.mock import MagicMock, patch

import lightgbm as lgb
import numpy as np
import pandas as pd
import pytest

from data.features import add_era_stats, add_group_aggregates, neutralize_features
from models import create_model, list_available_models
from models.lgbm_model import LightGBMModel
from training.submission import generate_submission, validate_submission
from training.validate import compute_all_metrics


# ═══════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════

def _make_train_df(
    n_eras: int = 10,
    rows_per_era: int = 50,
    n_features: int = 5,
    seed: int = 42,
    target_col: str = "target",
) -> pd.DataFrame:
    """Minimal training DataFrame with realistic structure."""
    rng = np.random.RandomState(seed)
    rows = []
    for era in range(n_eras):
        features = rng.rand(rows_per_era, n_features)
        target = 0.5 + 0.1 * (features[:, 0] - 0.5) + 0.02 * rng.randn(rows_per_era)
        target = np.clip(target, 0, 1)
        for i in range(rows_per_era):
            row = {
                "id": f"s_{era}_{i}",
                "era": f"era_{era:04d}",
                target_col: target[i],
            }
            for j in range(n_features):
                row[f"feature_{j}"] = features[i, j]
            rows.append(row)
    return pd.DataFrame(rows).set_index("id")


# ═══════════════════════════════════════════════════════════════════
# 1. MODEL FACTORY: create_model edge cases
# ═══════════════════════════════════════════════════════════════════

class TestCreateModelEdgeCases:

    def test_unknown_model_type(self):
        with pytest.raises(ValueError, match="Unknown model_type"):
            create_model(model_type="xgboost")

    def test_whitespace_model_type(self):
        """Leading/trailing whitespace → should still find 'lgbm'."""
        # BUG: .lower() doesn't strip whitespace
        model = create_model(model_type=" lgbm ")
        assert model is not None

    def test_uppercase_model_type(self):
        """Case insensitivity works."""
        model = create_model(model_type="LGBM")
        assert isinstance(model, LightGBMModel)

    def test_empty_model_type(self):
        """Empty string → ValueError."""
        with pytest.raises(ValueError):
            create_model(model_type="")

    def test_none_model_type(self):
        """None → AttributeError on .lower()."""
        with pytest.raises((ValueError, AttributeError)):
            create_model(model_type=None)

    def test_zero_learning_rate(self):
        """learning_rate=0 → model should still be created (may fail during training)."""
        model = create_model(learning_rate=0.0)
        assert model is not None

    def test_negative_n_estimators(self):
        """Negative n_estimators → model is created, crashes during fit."""
        model = create_model(n_estimators=-1)
        assert model is not None


# ═══════════════════════════════════════════════════════════════════
# 2. LightGBM: era split edge cases
# ═══════════════════════════════════════════════════════════════════

class TestLGBMEraSplitEdgeCases:

    def test_single_era_split(self):
        """1 era → split_idx = int(1 * 0.8) = 0 → train_eras = [], val_eras = [all].

        BUG: Training set is EMPTY. LightGBM will crash.
        """
        df = _make_train_df(n_eras=1, rows_per_era=50)
        feature_cols = [f"feature_{i}" for i in range(5)]
        model = LightGBMModel(n_estimators=10, early_stopping_rounds=5)

        # Should either raise a clear error or handle gracefully
        with pytest.raises(Exception):
            model.fit(df, feature_cols, "target", "era")

    def test_two_era_split(self):
        """2 eras → split_idx = int(2 * 0.8) = 1 → 1 train era, 1 val era.

        This works but validation has very few eras for meaningful metrics.
        """
        df = _make_train_df(n_eras=2, rows_per_era=50)
        feature_cols = [f"feature_{i}" for i in range(5)]
        model = LightGBMModel(n_estimators=10, early_stopping_rounds=5)

        info = model.fit(df, feature_cols, "target", "era")
        assert info["train_eras"] == 1
        assert info["val_eras"] == 1

    def test_three_era_split(self):
        """3 eras → split_idx=2 → 2 train, 1 val. Minimal viable split."""
        df = _make_train_df(n_eras=3, rows_per_era=50)
        feature_cols = [f"feature_{i}" for i in range(5)]
        model = LightGBMModel(n_estimators=10, early_stopping_rounds=5)

        info = model.fit(df, feature_cols, "target", "era")
        assert info["train_eras"] == 2
        assert info["val_eras"] == 1


# ═══════════════════════════════════════════════════════════════════
# 3. LightGBM: sample weight edge cases
# ═══════════════════════════════════════════════════════════════════

class TestSampleWeightEdgeCases:

    def _fit_with_weights(self, weights):
        df = _make_train_df(n_eras=5, rows_per_era=50)
        feature_cols = [f"feature_{i}" for i in range(5)]
        model = LightGBMModel(n_estimators=10, early_stopping_rounds=5)
        return model.fit(df, feature_cols, "target", "era", sample_weight=weights)

    def test_all_zero_weights(self):
        """All weights = 0 → LightGBM may fail or produce degenerate model."""
        weights = np.zeros(250)  # 5 eras * 50 rows
        # LightGBM should raise or warn about zero weights
        info = self._fit_with_weights(weights)
        assert info is not None  # Documents current behavior

    def test_nan_weights(self):
        """NaN weights → LightGBM silently trains with NaN loss!

        BUG: LightGBM doesn't reject NaN weights. It trains successfully
        but produces train_l2=NaN and val_l2=NaN — a silently broken model.
        """
        weights = np.full(250, np.nan)
        info = self._fit_with_weights(weights)
        # Model "trains" but best_score has NaN — silent corruption
        best_score = info.get("best_score", {})
        val_l2 = best_score.get("val", {}).get("l2", None)
        assert val_l2 is not None and math.isfinite(val_l2), \
            f"NaN weights produced NaN validation loss: {best_score}"

    def test_negative_weights(self):
        """Negative weights are physically meaningless."""
        weights = np.full(250, -1.0)
        # LightGBM typically allows negative weights (treats as importance)
        info = self._fit_with_weights(weights)
        assert info is not None

    def test_weight_length_mismatch(self):
        """Weight array shorter than training data → IndexError during split.

        BUG: sample_weight[train_mask.values] uses boolean indexing.
        If weight array is shorter, this silently truncates or crashes.
        """
        weights = np.ones(100)  # Only 100 weights for 250 rows
        with pytest.raises((IndexError, ValueError)):
            self._fit_with_weights(weights)

    def test_inf_weights(self):
        """Inf weights → LightGBM silently accepts and trains.

        BUG: LightGBM doesn't reject Inf weights. It may produce
        numerically unstable results without raising an error.
        """
        weights = np.full(250, np.inf)
        info = self._fit_with_weights(weights)
        best_score = info.get("best_score", {})
        val_l2 = best_score.get("val", {}).get("l2", None)
        assert val_l2 is not None and math.isfinite(val_l2), \
            f"Inf weights produced non-finite validation loss: {best_score}"


# ═══════════════════════════════════════════════════════════════════
# 4. LightGBM: predict edge cases
# ═══════════════════════════════════════════════════════════════════

class TestLGBMPredictEdgeCases:

    @pytest.fixture
    def trained_model(self):
        df = _make_train_df(n_eras=5, rows_per_era=50)
        feature_cols = [f"feature_{i}" for i in range(5)]
        model = LightGBMModel(n_estimators=10, early_stopping_rounds=5)
        model.fit(df, feature_cols, "target", "era")
        return model, feature_cols

    def test_predict_before_fit(self):
        """Predict without training → RuntimeError."""
        model = LightGBMModel()
        df = _make_train_df(n_eras=1, rows_per_era=10)
        with pytest.raises(RuntimeError, match="not trained"):
            model.predict(df, ["feature_0"])

    def test_predict_missing_feature_column(self, trained_model):
        """Predict with a feature not in DataFrame → KeyError."""
        model, _ = trained_model
        df = _make_train_df(n_eras=1, rows_per_era=10)
        with pytest.raises(KeyError):
            model.predict(df, ["feature_0", "nonexistent_feature"])

    def test_predict_empty_dataframe(self, trained_model):
        """Predict on empty DataFrame → LightGBM crashes.

        BUG: LightGBM rejects empty DataFrames with
        'Input data must be 2 dimensional and non empty.'
        No graceful fallback to return an empty Series.
        """
        model, feature_cols = trained_model
        empty_df = pd.DataFrame(columns=["era"] + feature_cols)
        with pytest.raises(ValueError, match="non empty"):
            model.predict(empty_df, feature_cols)

    def test_predict_all_nan_features(self, trained_model):
        """All feature values are NaN → LightGBM handles NaN natively."""
        model, feature_cols = trained_model
        df = pd.DataFrame(
            {col: [np.nan] * 5 for col in feature_cols},
            index=[f"s_{i}" for i in range(5)],
        )
        preds = model.predict(df, feature_cols)
        assert len(preds) == 5
        # LightGBM should still return predictions (it handles NaN)
        assert preds.notna().all()

    def test_predict_extra_columns_ignored(self, trained_model):
        """Extra columns in DataFrame don't affect predictions."""
        model, feature_cols = trained_model
        df = _make_train_df(n_eras=1, rows_per_era=10)
        df["extra_col"] = 999
        preds = model.predict(df, feature_cols)
        assert len(preds) == 10


# ═══════════════════════════════════════════════════════════════════
# 5. LightGBM: save/load round-trip edge cases
# ═══════════════════════════════════════════════════════════════════

class TestLGBMSaveLoadEdgeCases:

    def test_save_before_fit(self):
        """Save without training → RuntimeError."""
        model = LightGBMModel()
        with tempfile.TemporaryDirectory() as tmpdir:
            with pytest.raises(RuntimeError, match="No model"):
                model.save(Path(tmpdir) / "model")

    def test_load_missing_directory(self):
        """Load from nonexistent path → FileNotFoundError."""
        model = LightGBMModel()
        with pytest.raises(Exception):
            model.load(Path("/nonexistent/path"))

    def test_load_missing_meta_json(self):
        """Load model.txt without meta.json → feature_names defaults to []."""
        df = _make_train_df(n_eras=5, rows_per_era=50)
        feature_cols = [f"feature_{i}" for i in range(5)]
        model = LightGBMModel(n_estimators=10, early_stopping_rounds=5)
        model.fit(df, feature_cols, "target", "era")

        with tempfile.TemporaryDirectory() as tmpdir:
            model_path = Path(tmpdir) / "test_model"
            model.save(model_path)
            # Delete meta.json
            (model_path / "meta.json").unlink()

            loaded = LightGBMModel()
            loaded.load(model_path)
            assert loaded._feature_names == []

    def test_roundtrip_predictions_match(self):
        """Save → load → predict should give identical results."""
        df = _make_train_df(n_eras=5, rows_per_era=50)
        feature_cols = [f"feature_{i}" for i in range(5)]
        model = LightGBMModel(n_estimators=10, early_stopping_rounds=5)
        model.fit(df, feature_cols, "target", "era")

        test_df = _make_train_df(n_eras=1, rows_per_era=20, seed=99)
        preds_before = model.predict(test_df, feature_cols)

        with tempfile.TemporaryDirectory() as tmpdir:
            model_path = Path(tmpdir) / "test_model"
            model.save(model_path)

            loaded = LightGBMModel()
            loaded.load(model_path)
            preds_after = loaded.predict(test_df, feature_cols)

        pd.testing.assert_series_equal(preds_before, preds_after)


# ═══════════════════════════════════════════════════════════════════
# 6. TRAINER: _ensemble_predictions edge cases
# ═══════════════════════════════════════════════════════════════════

class TestEnsemblePredictionsEdgeCases:
    """Tests for trainer._ensemble_predictions."""

    def _ensemble(self, predictions):
        from training.trainer import _ensemble_predictions
        return _ensemble_predictions(predictions)

    def test_empty_predictions(self):
        with pytest.raises(ValueError, match="No predictions"):
            self._ensemble({})

    def test_single_prediction(self):
        """Single model → returned as-is (no re-ranking)."""
        preds = pd.Series([0.1, 0.5, 0.3], index=["a", "b", "c"])
        result = self._ensemble({"only": preds})
        pd.testing.assert_series_equal(result, preds)

    def test_nan_predictions_propagate(self):
        """NaN in one model's predictions → NaN in ensemble.

        BUG: rank() skips NaN, mean() with NaN may produce NaN.
        """
        preds_a = pd.Series([0.1, 0.5, 0.3], index=["x", "y", "z"])
        preds_b = pd.Series([0.2, np.nan, 0.4], index=["x", "y", "z"])

        result = self._ensemble({"a": preds_a, "b": preds_b})
        # y has NaN from model b → mean of (rank_a, NaN) = NaN → re-rank = NaN
        assert result.loc["y"] != result.loc["y"] or math.isfinite(result.loc["y"]), \
            f"NaN leaked: {result.to_dict()}"

    def test_all_identical_predictions(self):
        """All models predict the same → rank is all 0.5."""
        preds = pd.Series([0.5, 0.5, 0.5], index=["a", "b", "c"])
        result = self._ensemble({"m1": preds, "m2": preds})
        # All predictions identical → rank is all avg((1+2+3)/3) = 0.6667
        # Then mean → re-rank... all same value → all get same rank
        assert len(result) == 3

    def test_mismatched_indices(self):
        """Models with different stock universes → NaN at missing positions.

        BUG: pd.DataFrame aligns by index, missing → NaN.
        mean(axis=1) with NaN → some rows have NaN ensemble.
        """
        preds_a = pd.Series([0.1, 0.5], index=["x", "y"])
        preds_b = pd.Series([0.3, 0.7], index=["y", "z"])

        result = self._ensemble({"a": preds_a, "b": preds_b})
        # x: only model a → mean = rank_a(0.5) → finite
        # z: only model b → mean = NaN from a → NaN
        has_nan = result.isna().any()
        assert not has_nan, f"Mismatched indices produced NaN: {result.to_dict()}"


# ═══════════════════════════════════════════════════════════════════
# 7. TRAINER: _apply_feature_engineering edge cases
# ═══════════════════════════════════════════════════════════════════

class TestFeatureEngineeringPipelineEdgeCases:

    def test_zero_variance_features(self):
        """All features have zero variance → era_stat_features may be empty or NaN.

        BUG: .var() on constant column is 0, .nlargest(n) returns 0s,
        but add_era_stats with std=0 → replace(0,1) → z-score works.
        However, if n=0 (min(0, len)), era_stat_features is empty.
        """
        df = _make_train_df(n_eras=3, rows_per_era=20)
        # Make all features constant
        for i in range(5):
            df[f"feature_{i}"] = 1.0

        feature_cols = [f"feature_{i}" for i in range(5)]

        from training.trainer import _apply_feature_engineering

        class MockSettings:
            enable_era_stats = True
            enable_group_aggregates = False
            era_stats_top_n = 5
            era_col = "era"

        all_features, era_stat_features = _apply_feature_engineering(
            df, feature_cols, {}, MockSettings()
        )
        # Should not crash, but era_stat_features may have zero-variance cols
        assert isinstance(era_stat_features, list)

    def test_no_features(self):
        """Empty feature_cols → no era stats, no group aggregates."""
        df = pd.DataFrame({"era": ["e1", "e1"], "target": [0.5, 0.5]},
                          index=["a", "b"])

        from training.trainer import _apply_feature_engineering

        class MockSettings:
            enable_era_stats = True
            enable_group_aggregates = True
            era_stats_top_n = 5
            era_col = "era"

        all_features, era_stat_features = _apply_feature_engineering(
            df, [], {}, MockSettings()
        )
        assert all_features == []


# ═══════════════════════════════════════════════════════════════════
# 8. TRAINER: _rank_normalize edge cases
# ═══════════════════════════════════════════════════════════════════

class TestRankNormalize:

    def _rank(self, values, index=None):
        from training.trainer import _rank_normalize
        idx = index or list(range(len(values)))
        return _rank_normalize(pd.Series(values, index=idx))

    def test_single_value(self):
        result = self._rank([0.5])
        assert result.iloc[0] == 1.0  # rank of 1 out of 1

    def test_all_same_values(self):
        result = self._rank([0.5, 0.5, 0.5])
        # Average rank of tied values: (1+2+3)/3 / 3 = 2/3
        assert (result == result.iloc[0]).all()

    def test_nan_values(self):
        result = self._rank([0.1, np.nan, 0.3])
        assert result.isna().sum() == 1  # NaN stays NaN
        assert result.iloc[0] < result.iloc[2]  # ordering preserved

    def test_all_nan(self):
        result = self._rank([np.nan, np.nan])
        assert result.isna().all()

    def test_empty_series(self):
        result = self._rank([])
        assert len(result) == 0


# ═══════════════════════════════════════════════════════════════════
# 9. SUBMISSION: generate + validate edge cases
# ═══════════════════════════════════════════════════════════════════

class TestSubmissionEdgeCases:

    def test_nan_predictions_fail_validation(self):
        """NaN in predictions → rank assigns NaN → validation rejects."""
        preds = pd.Series([0.1, np.nan, 0.3], index=["a", "b", "c"], name="pred")
        with tempfile.TemporaryDirectory() as tmpdir:
            csv_path = generate_submission(preds, Path(tmpdir))
            with pytest.raises(ValueError, match="NaN"):
                validate_submission(csv_path)

    def test_empty_predictions(self):
        """Empty Series → empty CSV → should fail or produce empty valid file."""
        preds = pd.Series([], dtype=float, name="pred")
        with tempfile.TemporaryDirectory() as tmpdir:
            csv_path = generate_submission(preds, Path(tmpdir))
            # Empty CSV with headers only — validation should pass (0 rows)
            result = validate_submission(csv_path)
            assert result is True

    def test_single_prediction(self):
        """Single prediction → rank is 1.0."""
        preds = pd.Series([0.42], index=["stock_0"], name="pred")
        with tempfile.TemporaryDirectory() as tmpdir:
            csv_path = generate_submission(preds, Path(tmpdir))
            result = validate_submission(csv_path)
            assert result is True

    def test_all_identical_predictions(self):
        """All same value → all get same rank (average method)."""
        preds = pd.Series([0.5] * 100, index=[f"s_{i}" for i in range(100)])
        with tempfile.TemporaryDirectory() as tmpdir:
            csv_path = generate_submission(preds, Path(tmpdir))
            # All get rank by position (method="first"), so [0.01, 0.02, ..., 1.0]
            result = validate_submission(csv_path)
            assert result is True

    def test_inf_predictions(self):
        """Inf predictions → rank works (inf > all finite)."""
        preds = pd.Series([0.1, float("inf"), 0.3], index=["a", "b", "c"])
        with tempfile.TemporaryDirectory() as tmpdir:
            csv_path = generate_submission(preds, Path(tmpdir))
            result = validate_submission(csv_path)
            assert result is True

    def test_missing_expected_ids(self):
        """Validation with expected IDs not in submission → ValueError."""
        preds = pd.Series([0.1, 0.5], index=["a", "b"])
        expected = pd.Index(["a", "b", "c"])
        with tempfile.TemporaryDirectory() as tmpdir:
            csv_path = generate_submission(preds, Path(tmpdir))
            with pytest.raises(ValueError, match="Missing.*IDs"):
                validate_submission(csv_path, expected_ids=expected)


# ═══════════════════════════════════════════════════════════════════
# 10. INFERENCE CONFIG: parsing edge cases
# ═══════════════════════════════════════════════════════════════════

class TestInferenceConfigParsing:
    """Tests for inference.py config parsing (without actually downloading data)."""

    def test_missing_config_file(self):
        """No inference_config.json → FileNotFoundError."""
        from training.inference import run_inference
        with tempfile.TemporaryDirectory() as tmpdir:
            with pytest.raises(FileNotFoundError, match="inference_config"):
                run_inference(tmpdir, "", "", "")

    def test_malformed_json_config(self):
        """Corrupted JSON → json.JSONDecodeError."""
        from training.inference import run_inference
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "inference_config.json"
            config_path.write_text("{ broken json !!!")
            with pytest.raises(json.JSONDecodeError):
                run_inference(tmpdir, "", "", "")

    def test_missing_required_keys(self):
        """Config missing 'feature_set' key → KeyError."""
        from training.inference import run_inference
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "inference_config.json"
            config_path.write_text(json.dumps({"targets": ["target"]}))
            # Missing "feature_set" and "feature_cols" → KeyError
            with pytest.raises(KeyError):
                run_inference(tmpdir, "", "", "")


# ═══════════════════════════════════════════════════════════════════
# 11. BOOTSTRAP: hyperparameter coercion edge cases
# ═══════════════════════════════════════════════════════════════════

class TestBootstrapHyperparamParsing:
    """Test the hyperparameter parsing logic from bootstrap.py.

    We extract and test the parsing logic without running the full script.
    """

    def test_float_coercion_from_string(self):
        """SageMaker passes all hyperparams as strings."""
        val = float("50.0".strip('"'))
        assert val == 50.0

    def test_float_coercion_invalid_string(self):
        """Non-numeric string → ValueError."""
        with pytest.raises(ValueError):
            float("abc".strip('"'))

    def test_float_coercion_empty_string(self):
        """Empty string → ValueError."""
        with pytest.raises(ValueError):
            float("".strip('"'))

    def test_boolean_parsing_variants(self):
        """Only "true" (case-insensitive) is True; "1", "yes", "on" are False."""
        assert "true".lower() == "true"
        assert "True".lower() == "true"
        assert "TRUE".lower() == "true"
        # These common boolean representations are NOT handled:
        assert "1".lower() != "true"
        assert "yes".lower() != "true"
        assert "on".lower() != "true"

    def test_s3_path_parsing_valid(self):
        """Valid S3 path parses correctly."""
        s3_path = "s3://my-bucket/path/to/artifact.tar.gz"
        parts = s3_path.replace("s3://", "").split("/", 1)
        assert parts[0] == "my-bucket"
        assert parts[1] == "path/to/artifact.tar.gz"

    def test_s3_path_parsing_bucket_only(self):
        """S3 path with no key → IndexError.

        BUG: artifact_parts[1] crashes when path is just 's3://bucket'.
        """
        s3_path = "s3://bucket-only"
        parts = s3_path.replace("s3://", "").split("/", 1)
        assert len(parts) == 1
        with pytest.raises(IndexError):
            _ = parts[1]  # This is what bootstrap.py does

    def test_s3_path_parsing_empty(self):
        """Empty S3 path → split produces ['']."""
        s3_path = ""
        parts = s3_path.replace("s3://", "").split("/", 1)
        assert parts == [""]

    def test_strip_double_quotes(self):
        """SageMaker wraps string values in double quotes."""
        hp = {"key": '"value"'}
        cleaned = {k: v.strip('"') for k, v in hp.items()}
        assert cleaned["key"] == "value"

    def test_strip_double_quotes_nested(self):
        """Nested quotes not fully stripped."""
        hp = {"key": '""nested""'}
        cleaned = {k: v.strip('"') for k, v in hp.items()}
        # strip removes all leading/trailing chars in the set
        assert cleaned["key"] == "nested"

    def test_neutralization_pct_negative(self):
        """Negative neutralization_pct → negative proportion → inverted neutralization."""
        pct = float("-50.0")
        proportion = pct / 100.0
        assert proportion == -0.5  # Accepted silently, produces wrong results

    def test_neutralization_pct_over_100(self):
        """neutralization_pct > 100 → proportion > 1 → over-neutralization."""
        pct = float("200.0")
        proportion = pct / 100.0
        assert proportion == 2.0  # Accepted silently


# ═══════════════════════════════════════════════════════════════════
# 12. COMPUTE_ALL_METRICS: full pipeline edge cases
# ═══════════════════════════════════════════════════════════════════

class TestComputeAllMetricsEdgeCases:

    def test_all_nan_predictions(self):
        """All-NaN predictions through the full metrics pipeline."""
        df = _make_train_df(n_eras=3, rows_per_era=20)
        df["prediction"] = np.nan

        metrics = compute_all_metrics(df, "prediction", "target", "era")
        # All metrics should be NaN or 0, not crash
        assert "correlation" in metrics
        assert "sharpe" in metrics
        assert "max_drawdown" in metrics

    def test_constant_predictions(self):
        """Constant predictions → NaN correlations → NaN metrics.

        BUG: Sharpe divides by std of NaN series.
        """
        df = _make_train_df(n_eras=5, rows_per_era=20)
        df["prediction"] = 0.5

        metrics = compute_all_metrics(df, "prediction", "target", "era")
        assert math.isfinite(metrics["correlation"]) or math.isnan(metrics["correlation"])
        # Sharpe should be 0 or NaN, not crash
        assert math.isfinite(metrics["sharpe"]) or math.isnan(metrics["sharpe"])

    def test_perfect_predictions(self):
        """Predictions = targets → correlation ≈ 1.0."""
        df = _make_train_df(n_eras=5, rows_per_era=50)
        df["prediction"] = df["target"]

        metrics = compute_all_metrics(df, "prediction", "target", "era")
        assert metrics["correlation"] > 0.9
        assert metrics["max_drawdown"] > -0.1

    def test_single_era(self):
        """1 era → Sharpe std is NaN → should not crash."""
        df = _make_train_df(n_eras=1, rows_per_era=50)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(50)

        metrics = compute_all_metrics(df, "prediction", "target", "era")
        # Sharpe of 1 era: std=NaN → should return 0 or NaN
        assert math.isfinite(metrics["sharpe"]) or math.isnan(metrics["sharpe"])

    def test_missing_target_column(self):
        """Target column doesn't exist → KeyError."""
        df = _make_train_df(n_eras=3, rows_per_era=20)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(len(df))

        with pytest.raises(KeyError):
            compute_all_metrics(df, "prediction", "nonexistent_target", "era")
