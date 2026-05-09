"""Feature engineering for Numerai tournament data.

Computes era-level statistics, rolling windows, and group aggregates
on top of raw Numerai features.
"""

from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np
import pandas as pd


def add_era_stats(df: pd.DataFrame, feature_cols: List[str], era_col: str = "era") -> pd.DataFrame:
    """Add per-era mean and std for each feature group."""
    era_means = df.groupby(era_col)[feature_cols].transform("mean")
    era_stds = df.groupby(era_col)[feature_cols].transform("std")

    for col in feature_cols:
        df[f"{col}_era_demean"] = df[col] - era_means[col]
        std = era_stds[col].replace(0, 1)
        df[f"{col}_era_zscore"] = (df[col] - era_means[col]) / std

    return df


def add_rolling_features(
    df: pd.DataFrame,
    feature_cols: List[str],
    era_col: str = "era",
    windows: Optional[List[int]] = None,
) -> pd.DataFrame:
    """Add rolling mean/std over eras for selected features.

    Eras must be sortable (numeric or lexicographic).
    """
    if windows is None:
        windows = [5, 10, 20]

    era_medians = df.groupby(era_col)[feature_cols].median().sort_index()

    for window in windows:
        rolling_mean = era_medians.rolling(window, min_periods=1).mean()
        rolling_std = era_medians.rolling(window, min_periods=1).std().fillna(0)

        mean_map = rolling_mean.to_dict(orient="index")
        std_map = rolling_std.to_dict(orient="index")

        for col in feature_cols:
            df[f"{col}_roll{window}_mean"] = df[era_col].map(
                lambda e, c=col: mean_map.get(e, {}).get(c, np.nan)
            )
            df[f"{col}_roll{window}_std"] = df[era_col].map(
                lambda e, c=col: std_map.get(e, {}).get(c, np.nan)
            )

    return df


def add_group_aggregates(
    df: pd.DataFrame,
    feature_groups: Dict[str, List[str]],
) -> pd.DataFrame:
    """Add mean/std across feature groups (cross-feature aggregation)."""
    for group_name, cols in feature_groups.items():
        valid_cols = [c for c in cols if c in df.columns]
        if not valid_cols:
            continue
        df[f"group_{group_name}_mean"] = df[valid_cols].mean(axis=1)
        df[f"group_{group_name}_std"] = df[valid_cols].std(axis=1)
        df[f"group_{group_name}_skew"] = df[valid_cols].skew(axis=1)

    return df


def get_feature_columns(df: pd.DataFrame, prefix: str = "feature_") -> List[str]:
    """Extract feature column names from a DataFrame."""
    return [c for c in df.columns if c.startswith(prefix)]


def discover_feature_groups(
    metadata: dict,
    active_features: List[str],
) -> Dict[str, List[str]]:
    """Build feature group dict from Numerai features.json metadata.

    Each feature in features.json has a 'group' field (e.g. 'intelligence',
    'charisma', 'strength'). This function groups active features by that field.

    Args:
        metadata: Parsed features.json dict.
        active_features: List of feature column names currently in use.

    Returns:
        Dict mapping group name to list of feature column names.
    """
    active_set = set(active_features)
    groups: Dict[str, List[str]] = {}

    feature_stats = metadata.get("feature_stats", {})
    for feature_name, stats in feature_stats.items():
        if feature_name not in active_set:
            continue
        group = stats.get("group")
        if group:
            groups.setdefault(group, []).append(feature_name)

    return groups


def _neutralize_chunk(predictions: np.ndarray, exposures: np.ndarray, proportion: float) -> np.ndarray:
    """Neutralize a single chunk of predictions via OLS residuals."""
    # Drop zero-variance columns to avoid NaN in lstsq
    col_std = exposures.std(axis=0)
    good = col_std > 0
    if not good.any():
        return predictions
    exposures_clean = exposures[:, good] if not good.all() else exposures
    exposures_with_const = np.column_stack([exposures_clean, np.ones(len(exposures_clean))])
    beta, _, _, _ = np.linalg.lstsq(exposures_with_const, predictions, rcond=None)
    return predictions - proportion * (exposures_with_const @ beta - beta[-1])


def neutralize_features(
    df: pd.DataFrame,
    prediction_col: str,
    neutralizers: List[str],
    proportion: float = 1.0,
    era_col: Optional[str] = None,
) -> pd.Series:
    """Neutralize predictions against specified features.

    This reduces feature exposure at the cost of some correlation.

    Args:
        era_col: If provided, neutralize within each era separately.
            This matches Numerai's per-era scoring and avoids
            cross-era information leakage in the OLS fit.
    """
    if era_col is None or era_col not in df.columns:
        # Global neutralization (backward compatible)
        adjusted = _neutralize_chunk(
            df[prediction_col].values, df[neutralizers].values, proportion
        )
        return pd.Series(adjusted, index=df.index, name=prediction_col)

    # Per-era neutralization
    result = df[prediction_col].copy()
    min_rows = len(neutralizers) + 2  # need more rows than features for OLS

    for era, group in df.groupby(era_col):
        if len(group) < min_rows:
            continue  # skip tiny eras — keep predictions unchanged
        idx = group.index
        adjusted = _neutralize_chunk(
            group[prediction_col].values, group[neutralizers].values, proportion
        )
        result.loc[idx] = adjusted.astype(result.dtype)

    return result
