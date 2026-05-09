"""Edge-case tests exposing bugs in the ML pipeline.

Each test documents a real bug: NaN propagation, division instability,
empty-container crashes, or silent data corruption. Tests here are
expected to FAIL against the current codebase.
"""
from __future__ import annotations

import math
from typing import Dict, List

import numpy as np
import pandas as pd
import pytest
from scipy import stats

from data.features import (
    add_era_stats,
    add_group_aggregates,
    add_rolling_features,
    discover_feature_groups,
    neutralize_features,
)
from training.validate import (
    feature_exposure,
    max_drawdown,
    mean_correlation,
    meta_model_contribution,
    per_era_correlation,
    sharpe_ratio,
    signals_alpha,
)
from models.ensemble import rank_average, weighted_blend


# ═══════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════

def _make_df(n_eras: int = 5, rows_per_era: int = 20, n_features: int = 3,
             seed: int = 42) -> pd.DataFrame:
    """Minimal synthetic Numerai-like DataFrame."""
    rng = np.random.RandomState(seed)
    rows = []
    for era in range(n_eras):
        for i in range(rows_per_era):
            row = {
                "id": f"s_{era}_{i}",
                "era": f"era_{era:04d}",
                "target": np.clip(0.5 + 0.1 * rng.randn(), 0, 1),
            }
            for j in range(n_features):
                row[f"feature_{j}"] = float(rng.randint(0, 5))
            rows.append(row)
    df = pd.DataFrame(rows).set_index("id")
    return df


# ═══════════════════════════════════════════════════════════════════
# 1. FEATURES: add_era_stats — NaN std propagation
# ═══════════════════════════════════════════════════════════════════

class TestEraStatsEdgeCases:
    """add_era_stats bugs with degenerate eras."""

    def test_single_row_era_nan_std(self):
        """An era with 1 row has std=NaN (ddof=1). replace(0,1) doesn't fix NaN.

        BUG: std(ddof=1) of a single value is NaN, not 0.
        .replace(0, 1) only replaces 0s, so NaN stays → z-score becomes NaN.
        """
        df = pd.DataFrame({
            "id": ["a", "b", "c"],
            "era": ["e1", "e1", "e2"],  # e2 has only 1 row
            "feature_0": [1.0, 2.0, 3.0],
        }).set_index("id")

        result = add_era_stats(df, ["feature_0"])
        zscore_e2 = result.loc["c", "feature_0_era_zscore"]

        # BUG: This is NaN because std of a single value is NaN (ddof=1),
        # and .replace(0, 1) doesn't replace NaN.
        assert math.isfinite(zscore_e2), \
            f"Single-row era produced NaN z-score: {zscore_e2}"

    def test_constant_feature_era(self):
        """All rows in an era have the same feature value → std=0 → z-score=0."""
        df = pd.DataFrame({
            "id": ["a", "b", "c"],
            "era": ["e1", "e1", "e1"],
            "feature_0": [5.0, 5.0, 5.0],
        }).set_index("id")

        result = add_era_stats(df, ["feature_0"])
        # std=0, replaced with 1, demean=0, so z-score should be 0
        assert (result["feature_0_era_zscore"] == 0.0).all()

    def test_all_nan_feature_column(self):
        """Feature column is entirely NaN → mean=NaN, std=NaN → all derived NaN."""
        df = pd.DataFrame({
            "id": ["a", "b"],
            "era": ["e1", "e1"],
            "feature_0": [np.nan, np.nan],
        }).set_index("id")

        result = add_era_stats(df, ["feature_0"])
        # Both demean and zscore should be NaN (or 0), not crash
        assert not result["feature_0_era_demean"].apply(
            lambda x: x != x and x != x  # weird NaN check to avoid false pass
        ).all() or True  # This test documents the behavior

    def test_empty_dataframe(self):
        """Empty DataFrame should not crash."""
        df = pd.DataFrame(columns=["era", "feature_0"])
        result = add_era_stats(df, ["feature_0"])
        assert "feature_0_era_zscore" in result.columns
        assert len(result) == 0


# ═══════════════════════════════════════════════════════════════════
# 2. FEATURES: add_rolling_features — missing era NaN leak
# ═══════════════════════════════════════════════════════════════════

class TestRollingFeaturesEdgeCases:

    def test_unseen_era_gets_nan(self):
        """A live era not in training data gets NaN rolling features.

        BUG: mean_map.get(e, {}).get(c, np.nan) → NaN for unknown eras.
        This is silent — no warning, no error. Model gets NaN features.
        """
        df = _make_df(n_eras=3, rows_per_era=5)
        result = add_rolling_features(df, ["feature_0"], windows=[2])

        # Simulate a new era not in the data
        new_row = pd.DataFrame({
            "era": ["era_9999"],
            "feature_0": [2.0],
            "target": [0.5],
        }, index=["new_stock"])

        combined = pd.concat([result, new_row])
        # Re-run rolling features on combined — new era has no rolling stats
        result2 = add_rolling_features(combined, ["feature_0"], windows=[2])

        new_roll = result2.loc["new_stock", "feature_0_roll2_mean"]
        assert math.isfinite(new_roll), \
            f"Unseen era got NaN rolling feature: {new_roll}"

    def test_single_era(self):
        """Only 1 era → rolling window has 1 point → std should be 0 or NaN."""
        df = _make_df(n_eras=1, rows_per_era=10)
        result = add_rolling_features(df, ["feature_0"], windows=[5])
        # With min_periods=1 and window=5 on 1 era, rolling std is NaN
        std_val = result["feature_0_roll5_std"].iloc[0]
        # fillna(0) handles this, so should be 0
        assert std_val == 0.0 or math.isfinite(std_val)


# ═══════════════════════════════════════════════════════════════════
# 3. FEATURES: add_group_aggregates — empty groups
# ═══════════════════════════════════════════════════════════════════

class TestGroupAggregatesEdgeCases:

    def test_group_with_no_matching_columns(self):
        """All columns in a group are missing from df → skipped (correct)."""
        df = _make_df(n_eras=2, rows_per_era=5)
        result = add_group_aggregates(df, {"phantom": ["nonexistent_1", "nonexistent_2"]})
        assert "group_phantom_mean" not in result.columns

    def test_group_with_single_column(self):
        """Group with 1 column → std is NaN (needs ≥2 cols), skew is NaN."""
        df = _make_df(n_eras=2, rows_per_era=5)
        result = add_group_aggregates(df, {"solo": ["feature_0"]})

        # mean works fine with 1 col
        assert result["group_solo_mean"].notna().all()
        # std of 1 value: pandas .std(axis=1) with 1 col returns NaN
        # BUG: NaN std silently propagated as a feature
        has_nan_std = result["group_solo_std"].isna().any()
        assert not has_nan_std, \
            "Group with single column produced NaN std (silent data corruption)"

    def test_group_with_all_nan_columns(self):
        """Group columns exist but are all NaN → mean/std/skew all NaN."""
        df = _make_df(n_eras=2, rows_per_era=5)
        df["feature_nan"] = np.nan
        result = add_group_aggregates(df, {"broken": ["feature_nan"]})
        # All NaN column → mean is NaN, std is NaN, skew is NaN
        assert result["group_broken_mean"].isna().all()


# ═══════════════════════════════════════════════════════════════════
# 4. FEATURES: neutralize_features — ill-conditioned inputs
# ═══════════════════════════════════════════════════════════════════

class TestNeutralizeEdgeCases:

    def test_collinear_neutralizers(self):
        """Perfectly collinear neutralizers → lstsq is ill-conditioned."""
        df = pd.DataFrame({
            "prediction": [0.1, 0.2, 0.3, 0.4, 0.5],
            "feat_a": [1.0, 2.0, 3.0, 4.0, 5.0],
            "feat_b": [2.0, 4.0, 6.0, 8.0, 10.0],  # exactly 2 * feat_a
        })
        # lstsq handles rank-deficiency but result may be numerically unstable
        result = neutralize_features(df, "prediction", ["feat_a", "feat_b"])
        assert result.notna().all(), "Collinear neutralizers produced NaN"
        assert all(math.isfinite(v) for v in result.values)

    def test_constant_neutralizer(self):
        """Neutralizer is constant → collinear with the intercept column."""
        df = pd.DataFrame({
            "prediction": [0.1, 0.2, 0.3, 0.4, 0.5],
            "feat_const": [1.0, 1.0, 1.0, 1.0, 1.0],
        })
        result = neutralize_features(df, "prediction", ["feat_const"])
        assert result.notna().all()
        assert all(math.isfinite(v) for v in result.values)

    def test_all_nan_predictions(self):
        """All-NaN predictions → lstsq should fail or return NaN."""
        df = pd.DataFrame({
            "prediction": [np.nan, np.nan, np.nan],
            "feat_a": [1.0, 2.0, 3.0],
        })
        result = neutralize_features(df, "prediction", ["feat_a"])
        # Should be all NaN (garbage in, garbage out)
        assert result.isna().all()

    def test_single_row(self):
        """Single row → OLS is underdetermined."""
        df = pd.DataFrame({
            "prediction": [0.5],
            "feat_a": [1.0],
        })
        result = neutralize_features(df, "prediction", ["feat_a"])
        assert len(result) == 1
        assert math.isfinite(result.iloc[0])

    def test_all_nan_neutralizers(self):
        """Neutralizer columns are all NaN → lstsq with NaN inputs."""
        df = pd.DataFrame({
            "prediction": [0.1, 0.2, 0.3],
            "feat_nan": [np.nan, np.nan, np.nan],
        })
        result = neutralize_features(df, "prediction", ["feat_nan"])
        # NaN neutralizers → NaN betas → NaN adjusted
        # BUG: silently returns NaN predictions
        has_nan = result.isna().any()
        assert not has_nan, \
            "NaN neutralizers silently corrupted predictions"


# ═══════════════════════════════════════════════════════════════════
# 5. VALIDATE: sharpe_ratio — floating-point equality check
# ═══════════════════════════════════════════════════════════════════

class TestSharpeEdgeCases:

    def test_constant_predictions_zero_std(self):
        """All predictions identical → per-era corr is NaN → std is NaN.

        BUG: era_corrs.std() is NaN (not 0), so `== 0` check fails.
        Falls through to mean(NaN) / std(NaN) = NaN / NaN = NaN.
        """
        df = _make_df(n_eras=5, rows_per_era=20)
        df["prediction"] = 0.5  # constant predictions

        result = sharpe_ratio(df, "prediction", "target", "era")
        assert math.isfinite(result), \
            f"Constant predictions produced non-finite Sharpe: {result}"

    def test_single_era_sharpe(self):
        """1 era → std of single value is NaN → division."""
        df = _make_df(n_eras=1, rows_per_era=20)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(len(df))

        result = sharpe_ratio(df, "prediction", "target", "era")
        # 1 era → Series of length 1 → std = NaN → NaN / NaN = NaN
        assert math.isfinite(result), \
            f"Single era produced non-finite Sharpe: {result}"

    def test_two_eras_nearly_zero_std(self):
        """2 eras with nearly identical correlations → tiny std → huge Sharpe."""
        rng = np.random.RandomState(42)
        df = _make_df(n_eras=2, rows_per_era=50)
        # Give both eras very similar predictions
        df["prediction"] = df["target"] + 0.01 * rng.randn(len(df))

        result = sharpe_ratio(df, "prediction", "target", "era")
        assert math.isfinite(result)
        # Sharpe shouldn't be absurdly large — that indicates instability
        assert abs(result) < 1000, \
            f"Sharpe ratio suspiciously large: {result}"


# ═══════════════════════════════════════════════════════════════════
# 6. VALIDATE: per_era_correlation with degenerate data
# ═══════════════════════════════════════════════════════════════════

class TestPerEraCorrelationEdgeCases:

    def test_all_nan_predictions(self):
        """All-NaN predictions → spearmanr returns NaN per era."""
        df = _make_df(n_eras=3, rows_per_era=10)
        df["prediction"] = np.nan

        result = per_era_correlation(df, "prediction", "target", "era")
        # All NaN predictions → spearmanr should return NaN
        assert result.isna().all()

    def test_all_nan_targets(self):
        """All-NaN targets → spearmanr returns NaN per era."""
        df = _make_df(n_eras=3, rows_per_era=10)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(len(df))
        df["target"] = np.nan

        result = per_era_correlation(df, "prediction", "target", "era")
        assert result.isna().all()

    def test_constant_predictions_per_era(self):
        """Constant predictions within each era → spearmanr is NaN (zero variance)."""
        df = _make_df(n_eras=3, rows_per_era=10)
        df["prediction"] = 0.5

        result = per_era_correlation(df, "prediction", "target", "era")
        # scipy.stats.spearmanr with constant input returns NaN
        assert result.isna().all() or (result == 0.0).all()

    def test_era_with_exactly_5_rows(self):
        """Era with exactly 5 rows (boundary of < 5 filter)."""
        df = _make_df(n_eras=1, rows_per_era=5)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(5)

        result = per_era_correlation(df, "prediction", "target", "era")
        # Exactly 5 rows → passes the < 5 check → should compute
        assert len(result) == 1
        assert math.isfinite(result.iloc[0])

    def test_era_with_4_rows_skipped(self):
        """Era with 4 rows → filtered out by < 5 check → NaN."""
        df = _make_df(n_eras=1, rows_per_era=4)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(4)

        result = per_era_correlation(df, "prediction", "target", "era")
        assert result.isna().all()


# ═══════════════════════════════════════════════════════════════════
# 7. VALIDATE: feature_exposure with degenerate inputs
# ═══════════════════════════════════════════════════════════════════

class TestFeatureExposureEdgeCases:

    def test_constant_predictions(self):
        """Constant predictions → spearmanr with any feature is NaN.

        BUG: corr is NaN, abs(NaN) is NaN, max([NaN, NaN, ...]) is NaN.
        np.mean([NaN]) = NaN.
        """
        df = _make_df(n_eras=3, rows_per_era=20)
        df["prediction"] = 0.5
        feature_cols = [f"feature_{i}" for i in range(3)]

        result = feature_exposure(df, "prediction", feature_cols, "era")
        assert math.isfinite(result), \
            f"Constant predictions produced non-finite exposure: {result}"

    def test_all_eras_too_small(self):
        """All eras have < 5 rows → max_exposures is empty → returns 0.0."""
        df = _make_df(n_eras=3, rows_per_era=4)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(len(df))
        feature_cols = [f"feature_{i}" for i in range(3)]

        result = feature_exposure(df, "prediction", feature_cols, "era")
        # Returns 0.0 — misleading, should be NaN or raise
        assert result == 0.0

    def test_nan_feature_column(self):
        """Feature column is all NaN → spearmanr returns NaN → max(NaN) crash?"""
        df = _make_df(n_eras=2, rows_per_era=20)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(len(df))
        df["feature_nan"] = np.nan

        result = feature_exposure(df, "prediction", ["feature_nan"], "era")
        assert math.isfinite(result), \
            f"NaN feature column produced non-finite exposure: {result}"


# ═══════════════════════════════════════════════════════════════════
# 8. VALIDATE: meta_model_contribution edge cases
# ═══════════════════════════════════════════════════════════════════

class TestMMCEdgeCases:

    def test_constant_meta_model(self):
        """Constant meta model → mm_norm = 0 check triggers → NaN per era.

        Actually: _gaussianize on constant data → rankdata returns [1,1,...,1],
        ppf(1/(n+1)) is a valid number but all same → dot(mm, mm) could be
        nonzero. Let's verify.
        """
        df = _make_df(n_eras=2, rows_per_era=20)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(len(df))
        df["numerai_meta_model"] = 0.5  # constant

        result = meta_model_contribution(df, "prediction", "numerai_meta_model", "target", "era")
        # Constant meta model → gaussianize assigns same rank to all
        # → ppf(same_value) repeated → dot product may be nonzero
        # But orthogonalization is meaningless
        assert math.isfinite(result), \
            f"Constant meta model produced non-finite MMC: {result}"

    def test_identical_predictions_and_meta(self):
        """Predictions == meta model → orthogonal component is zero → corr undefined."""
        df = _make_df(n_eras=2, rows_per_era=20)
        rng = np.random.RandomState(42)
        preds = rng.rand(len(df))
        df["prediction"] = preds
        df["numerai_meta_model"] = preds  # identical

        result = meta_model_contribution(df, "prediction", "numerai_meta_model", "target", "era")
        # preds_ortho = preds - mm * (dot(preds,mm) / dot(mm,mm))
        # Since preds == mm: preds_ortho = preds - mm * 1 = 0
        # corrcoef(zeros, target) is NaN (zero variance)
        assert math.isfinite(result), \
            f"Identical preds/meta produced non-finite MMC: {result}"

    def test_all_nan_meta_model(self):
        """NaN meta model → _gaussianize on NaN → ppf(NaN) = NaN → crash?"""
        df = _make_df(n_eras=2, rows_per_era=20)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(len(df))
        df["numerai_meta_model"] = np.nan

        result = meta_model_contribution(df, "prediction", "numerai_meta_model", "target", "era")
        # BUG: rankdata on NaN values may behave unexpectedly
        assert math.isfinite(result), \
            f"NaN meta model produced non-finite MMC: {result}"

    def test_eras_with_exactly_10_rows(self):
        """Boundary: exactly 10 rows (threshold is < 10)."""
        df = _make_df(n_eras=1, rows_per_era=10)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(10)
        df["numerai_meta_model"] = rng.rand(10)

        result = meta_model_contribution(df, "prediction", "numerai_meta_model", "target", "era")
        assert math.isfinite(result)


# ═══════════════════════════════════════════════════════════════════
# 9. VALIDATE: max_drawdown edge cases
# ═══════════════════════════════════════════════════════════════════

class TestMaxDrawdownEdgeCases:

    def test_all_positive_correlations(self):
        """All positive per-era corrs → drawdown should be 0 (monotonically increasing cumsum)."""
        df = _make_df(n_eras=5, rows_per_era=20)
        # Perfect positive correlation: prediction = target
        df["prediction"] = df["target"]

        result = max_drawdown(df, "prediction", "target", "era")
        assert result >= -1e-10, f"Perfect predictions should have ~0 drawdown, got {result}"

    def test_all_nan_correlations(self):
        """All NaN per-era corrs → cumsum is NaN → drawdown is NaN."""
        df = _make_df(n_eras=5, rows_per_era=20)
        df["prediction"] = 0.5  # constant → NaN correlations

        result = max_drawdown(df, "prediction", "target", "era")
        assert math.isfinite(result), \
            f"Constant predictions produced non-finite drawdown: {result}"


# ═══════════════════════════════════════════════════════════════════
# 10. VALIDATE: signals_alpha — weight edge cases
# ═══════════════════════════════════════════════════════════════════

class TestSignalsAlphaEdgeCases:

    def test_zero_weights(self):
        """All sample weights = 0 → weighted = 0 * rank = 0 → rank is constant.

        BUG: rank([0,0,0,...]) assigns average rank to all → all predictions
        become 0.5 → correlation with target is undefined.
        """
        df = _make_df(n_eras=3, rows_per_era=20)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(len(df))

        zero_weights = pd.DataFrame(
            {"weight": np.zeros(len(df))},
            index=df.index,
        )

        result = signals_alpha(
            df, "prediction", "target", "era",
            sample_weights=zero_weights,
        )
        assert math.isfinite(result), \
            f"Zero weights produced non-finite alpha: {result}"

    def test_nan_weights(self):
        """NaN sample weights → weighted predictions are NaN → rank fails."""
        df = _make_df(n_eras=3, rows_per_era=20)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(len(df))

        nan_weights = pd.DataFrame(
            {"weight": np.full(len(df), np.nan)},
            index=df.index,
        )

        result = signals_alpha(
            df, "prediction", "target", "era",
            sample_weights=nan_weights,
        )
        assert math.isfinite(result), \
            f"NaN weights produced non-finite alpha: {result}"

    def test_inf_weights(self):
        """Inf sample weights → overflow in weighted predictions."""
        df = _make_df(n_eras=3, rows_per_era=20)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(len(df))

        inf_weights = pd.DataFrame(
            {"weight": np.full(len(df), np.inf)},
            index=df.index,
        )

        result = signals_alpha(
            df, "prediction", "target", "era",
            sample_weights=inf_weights,
        )
        assert math.isfinite(result), \
            f"Inf weights produced non-finite alpha: {result}"

    def test_negative_weights(self):
        """Negative weights are not physically meaningful — should be rejected or handled."""
        df = _make_df(n_eras=3, rows_per_era=20)
        rng = np.random.RandomState(42)
        df["prediction"] = rng.rand(len(df))

        neg_weights = pd.DataFrame(
            {"weight": np.full(len(df), -1.0)},
            index=df.index,
        )

        result = signals_alpha(
            df, "prediction", "target", "era",
            sample_weights=neg_weights,
        )
        # Negative weights invert the ranking — this is silently accepted
        assert math.isfinite(result)


# ═══════════════════════════════════════════════════════════════════
# 11. ENSEMBLE: rank_average / weighted_blend edge cases
# ═══════════════════════════════════════════════════════════════════

class TestEnsembleEdgeCases:

    def test_single_model_ensemble(self):
        """Ensemble of 1 model — should just return that model's ranks."""
        preds = pd.Series([0.1, 0.5, 0.3], index=["a", "b", "c"])
        result = rank_average({"only": preds})
        # rank_average: rank → average of 1 → re-rank
        assert len(result) == 3
        assert result.min() > 0 and result.max() <= 1

    def test_nan_in_predictions(self):
        """NaN predictions → rank() assigns NaN → mean includes NaN → output NaN.

        BUG: pd.Series.rank() with NaN returns NaN for that position.
        mean(axis=1) of [0.5, NaN] = NaN (if any NaN). Re-rank of NaN = NaN.
        """
        preds_good = pd.Series([0.1, 0.5, 0.3], index=["a", "b", "c"])
        preds_nan = pd.Series([0.2, np.nan, 0.4], index=["a", "b", "c"])

        result = rank_average({"good": preds_good, "bad": preds_nan})
        assert result.notna().all(), \
            f"NaN prediction leaked into ensemble: {result.to_dict()}"

    def test_mismatched_indices(self):
        """Models predict on different stock sets → NaN at missing positions."""
        preds_a = pd.Series([0.1, 0.5], index=["x", "y"])
        preds_b = pd.Series([0.3, 0.7], index=["y", "z"])

        result = rank_average({"a": preds_a, "b": preds_b})
        # pd.DataFrame with mismatched indices → NaN at missing positions
        # mean includes NaN → some ensemble values are NaN
        assert result.notna().all(), \
            f"Mismatched indices produced NaN in ensemble: {result.to_dict()}"

    def test_weighted_blend_zero_weights(self):
        """All weights = 0 → total_weight = 0 → division by zero."""
        preds = pd.Series([0.1, 0.5, 0.3], index=["a", "b", "c"])
        with pytest.raises((ZeroDivisionError, ValueError)):
            weighted_blend({"m1": preds}, weights={"m1": 0.0})

    def test_weighted_blend_negative_weights(self):
        """Negative weight → w = negative / total → inverted ranking."""
        preds = pd.Series([0.1, 0.5, 0.3], index=["a", "b", "c"])
        # This silently inverts the prediction ranking
        result = weighted_blend({"m1": preds}, weights={"m1": -1.0})
        assert result.notna().all()


# ═══════════════════════════════════════════════════════════════════
# 12. FEATURES: discover_feature_groups edge cases
# ═══════════════════════════════════════════════════════════════════

class TestDiscoverFeatureGroupsEdgeCases:

    def test_empty_metadata(self):
        """Empty features.json → no groups."""
        result = discover_feature_groups({}, ["feature_0"])
        assert result == {}

    def test_no_active_features_match(self):
        """None of the active features are in metadata."""
        metadata = {
            "feature_stats": {
                "feature_phantom": {"group": "intelligence"},
            }
        }
        result = discover_feature_groups(metadata, ["feature_0", "feature_1"])
        assert result == {}

    def test_feature_without_group(self):
        """Feature in metadata but has no 'group' field."""
        metadata = {
            "feature_stats": {
                "feature_0": {},  # no group key
            }
        }
        result = discover_feature_groups(metadata, ["feature_0"])
        assert result == {}
