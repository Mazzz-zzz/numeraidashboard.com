"""Tests for feature engineering."""

import numpy as np
import pandas as pd
import pytest

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from data.features import (
    add_era_stats,
    add_group_aggregates,
    discover_feature_groups,
    get_feature_columns,
    neutralize_features,
)


class TestEraStats:
    def test_adds_demean_and_zscore(self, synthetic_data, feature_cols):
        result = add_era_stats(synthetic_data, feature_cols[:3])
        for col in feature_cols[:3]:
            assert f"{col}_era_demean" in result.columns
            assert f"{col}_era_zscore" in result.columns

    def test_demean_sums_to_zero_per_era(self, synthetic_data, feature_cols):
        result = add_era_stats(synthetic_data, feature_cols[:1])
        col = feature_cols[0]
        era_sums = result.groupby("era")[f"{col}_era_demean"].sum()
        np.testing.assert_allclose(era_sums.values, 0, atol=1e-10)


class TestGroupAggregates:
    def test_adds_group_stats(self, synthetic_data, feature_cols):
        groups = {"test_group": feature_cols[:5]}
        result = add_group_aggregates(synthetic_data, groups)
        assert "group_test_group_mean" in result.columns
        assert "group_test_group_std" in result.columns
        assert "group_test_group_skew" in result.columns

    def test_handles_missing_cols(self, synthetic_data):
        groups = {"bad_group": ["nonexistent_col1", "nonexistent_col2"]}
        result = add_group_aggregates(synthetic_data, groups)
        assert "group_bad_group_mean" not in result.columns


class TestGetFeatureCols:
    def test_extracts_feature_columns(self, synthetic_data):
        cols = get_feature_columns(synthetic_data)
        assert len(cols) == 10
        assert all(c.startswith("feature_") for c in cols)

    def test_custom_prefix(self, synthetic_data):
        cols = get_feature_columns(synthetic_data, prefix="nonexistent_")
        assert len(cols) == 0


class TestDiscoverFeatureGroups:
    def test_discovers_groups_from_metadata(self, feature_cols, feature_metadata):
        groups = discover_feature_groups(feature_metadata, feature_cols)
        assert len(groups) > 0
        # All returned features should be in active_features
        for group_name, cols in groups.items():
            for col in cols:
                assert col in feature_cols

    def test_filters_to_active_features(self, feature_metadata):
        active = ["feature_0", "feature_1"]
        groups = discover_feature_groups(feature_metadata, active)
        all_features = [c for cols in groups.values() for c in cols]
        assert set(all_features).issubset(set(active))

    def test_empty_active_features(self, feature_metadata):
        groups = discover_feature_groups(feature_metadata, [])
        assert len(groups) == 0


class TestNeutralize:
    def test_reduces_correlation(self, synthetic_data, feature_cols):
        # Create predictions correlated with feature_0
        synthetic_data["prediction"] = synthetic_data["feature_0"] * 0.5 + 0.5

        neutralized = neutralize_features(
            synthetic_data, "prediction", feature_cols[:1], proportion=1.0
        )

        # After neutralization, correlation with feature_0 should decrease
        orig_corr = abs(synthetic_data["prediction"].corr(synthetic_data["feature_0"]))
        new_corr = abs(neutralized.corr(synthetic_data["feature_0"]))
        assert new_corr < orig_corr
