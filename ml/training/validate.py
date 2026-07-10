"""Numerai-specific validation metrics.

Computes per-era correlation, Sharpe ratio, max drawdown,
and feature exposure — the metrics Numerai uses for scoring.
"""

from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np
import pandas as pd
from scipy import stats


def per_era_correlation(
    df: pd.DataFrame,
    prediction_col: str = "prediction",
    target_col: str = "target",
    era_col: str = "era",
) -> pd.Series:
    """Compute Spearman correlation per era using fast rank-based method."""
    def _corr(group):
        if len(group) < 5:
            return np.nan
        return group[prediction_col].rank().corr(group[target_col].rank())

    return df.groupby(era_col).apply(_corr, include_groups=False)


def mean_correlation(
    df: pd.DataFrame,
    prediction_col: str = "prediction",
    target_col: str = "target",
    era_col: str = "era",
    _era_corrs: Optional[pd.Series] = None,
) -> float:
    """Mean of per-era Spearman correlations."""
    if _era_corrs is None:
        _era_corrs = per_era_correlation(df, prediction_col, target_col, era_col)
    return float(_era_corrs.mean())


def sharpe_ratio(
    df: pd.DataFrame,
    prediction_col: str = "prediction",
    target_col: str = "target",
    era_col: str = "era",
    _era_corrs: Optional[pd.Series] = None,
) -> float:
    """Sharpe ratio of per-era correlations (annualized, ~52 eras/year)."""
    if _era_corrs is None:
        _era_corrs = per_era_correlation(df, prediction_col, target_col, era_col)
    if _era_corrs.std() == 0:
        return 0.0
    return float(_era_corrs.mean() / _era_corrs.std())


def max_drawdown(
    df: pd.DataFrame,
    prediction_col: str = "prediction",
    target_col: str = "target",
    era_col: str = "era",
    _era_corrs: Optional[pd.Series] = None,
) -> float:
    """Maximum drawdown of cumulative per-era correlation."""
    if _era_corrs is None:
        _era_corrs = per_era_correlation(df, prediction_col, target_col, era_col)
    cumulative = _era_corrs.cumsum()
    running_max = cumulative.cummax()
    drawdowns = cumulative - running_max
    return float(drawdowns.min())


def feature_exposure(
    df: pd.DataFrame,
    prediction_col: str = "prediction",
    feature_cols: Optional[List[str]] = None,
    era_col: str = "era",
) -> float:
    """Max per-era feature exposure (correlation of predictions with features).

    Lower is better — high exposure means the model is just betting on
    a single feature rather than finding alpha.
    Uses vectorized rank correlation: rank all columns once per era, then
    compute correlations via a single matrix multiply.
    """
    if feature_cols is None:
        feature_cols = [c for c in df.columns if c.startswith("feature_")]

    if not feature_cols:
        return 0.0

    max_exposures = []
    for era, group in df.groupby(era_col):
        if len(group) < 5:
            continue
        # Rank predictions and all features in one shot
        ranked = group[[prediction_col] + feature_cols].rank()
        # Correlation of prediction ranks with each feature rank
        corrs = ranked[feature_cols].corrwith(ranked[prediction_col])
        max_exposures.append(float(corrs.abs().max()))

    return float(np.mean(max_exposures)) if max_exposures else 0.0


def top_exposure_features(
    df: pd.DataFrame,
    prediction_col: str = "prediction",
    feature_cols: Optional[List[str]] = None,
    era_col: str = "era",
    top_n: int = 50,
) -> List[str]:
    """Return the top-N features by mean absolute per-era exposure.

    These are the features most correlated with predictions — the ones
    that neutralization should target to reduce feature exposure.
    """
    if feature_cols is None:
        feature_cols = [c for c in df.columns if c.startswith("feature_")]

    if not feature_cols:
        return []

    all_exposures = []
    for era, group in df.groupby(era_col):
        if len(group) < 5:
            continue
        ranked = group[[prediction_col] + feature_cols].rank()
        corrs = ranked[feature_cols].corrwith(ranked[prediction_col]).abs()
        all_exposures.append(corrs)

    if not all_exposures:
        return []

    mean_exposure = pd.DataFrame(all_exposures).mean()
    return mean_exposure.nlargest(min(top_n, len(mean_exposure))).index.tolist()


def meta_model_contribution(
    df: pd.DataFrame,
    prediction_col: str = "prediction",
    meta_model_col: str = "numerai_meta_model",
    target_col: str = "target",
    era_col: str = "era",
) -> float:
    """Compute MMC (Meta-Model Contribution) per era, then average.

    MMC measures how much your predictions contribute beyond the meta model.
    It orthogonalizes your predictions against the meta model, then correlates
    the residual with the target.
    """
    def _gaussianize(s):
        """Rank to Gaussian (percentile -> inverse normal CDF)."""
        ranked = stats.rankdata(s)
        return stats.norm.ppf(ranked / (len(ranked) + 1))

    def _mmc_era(group):
        if len(group) < 10:
            return np.nan
        preds = _gaussianize(group[prediction_col].values)
        mm = _gaussianize(group[meta_model_col].values)
        target = _gaussianize(group[target_col].values)

        # Orthogonalize predictions w.r.t. meta model
        dot = np.dot(preds, mm)
        mm_norm = np.dot(mm, mm)
        if mm_norm == 0:
            return np.nan
        preds_ortho = preds - mm * (dot / mm_norm)

        # Correlate orthogonal component with target
        return np.corrcoef(preds_ortho, target)[0, 1]

    era_mmcs = df.groupby(era_col).apply(_mmc_era, include_groups=False)
    return float(era_mmcs.mean())


def benchmark_comparison(
    df: pd.DataFrame,
    prediction_col: str = "prediction",
    benchmark_cols: List[str] = None,
    target_col: str = "target",
    era_col: str = "era",
) -> Dict[str, Dict[str, float]]:
    """Compare our model against Numerai benchmark models.

    Returns a dict of {benchmark_name: {correlation, sharpe}} so we can
    see where we stand relative to Numerai's own models.
    """
    if not benchmark_cols:
        return {}

    results = {}
    for bm_col in benchmark_cols:
        if bm_col not in df.columns:
            continue
        bm_corrs = per_era_correlation(df, bm_col, target_col, era_col)
        bm_corr = mean_correlation(df, bm_col, target_col, era_col, _era_corrs=bm_corrs)
        bm_sharpe = sharpe_ratio(df, bm_col, target_col, era_col, _era_corrs=bm_corrs)
        results[bm_col] = {"correlation": bm_corr, "sharpe": bm_sharpe}

    return results


def signals_alpha(
    df: pd.DataFrame,
    prediction_col: str = "prediction",
    target_col: str = "target",
    era_col: str = "era",
    neutralizer: Optional[pd.DataFrame] = None,
    sample_weights: Optional[pd.DataFrame] = None,
    neutralization_proportion: float = 1.0,
) -> float:
    """Compute Signals Alpha: the metric Numerai actually scores you on.

    Pipeline: neutralize predictions → apply sample weights → per-era correlation.
    This replicates what Numerai's scoring system does so validation metrics
    match live performance.

    Args:
        neutralizer: DataFrame with neutralizer columns, same index as df.
        sample_weights: DataFrame with a single weight column, same index as df.
        neutralization_proportion: How much to neutralize (0-1).
    """
    from data.features import neutralize_features

    work = df.copy()

    # Step 1: Neutralize using the Signals neutralizer matrix
    if neutralizer is not None and neutralization_proportion > 0:
        common = work.index.intersection(neutralizer.index)
        if len(common) > 0:
            neut_cols = neutralizer.columns.tolist()
            for col in neut_cols:
                work.loc[common, col] = neutralizer.loc[common, col]
            work.loc[common, prediction_col] = neutralize_features(
                work.loc[common], prediction_col, neut_cols,
                proportion=neutralization_proportion,
            )

    # Step 2: Apply sample weights (weight the predictions before correlation)
    if sample_weights is not None:
        common = work.index.intersection(sample_weights.index)
        if len(common) > 0:
            w_col = sample_weights.columns[0]
            weights = sample_weights.loc[common, w_col]
            # Weight by multiplying prediction rank by weight, then re-rank
            preds = work.loc[common, prediction_col]
            ranked = preds.rank(pct=True, method="average")
            weighted = ranked * weights
            work.loc[common, prediction_col] = weighted.rank(pct=True, method="average")

    # Step 3: Per-era correlation → mean
    return mean_correlation(work, prediction_col, target_col, era_col)


def example_predictions_comparison(
    df: pd.DataFrame,
    example_preds: pd.DataFrame,
    target_col: str = "target",
    era_col: str = "era",
) -> Dict[str, float]:
    """Compare our predictions against Numerai's example predictions.

    Returns dict with our correlation, example correlation, and the delta.
    """
    common = df.index.intersection(example_preds.index)
    if len(common) == 0:
        return {}

    work = df.loc[common].copy()
    example_col = example_preds.columns[0]
    work["_example_pred"] = example_preds.loc[common, example_col]

    our_corr = mean_correlation(work, "prediction", target_col, era_col)
    example_corr = mean_correlation(work, "_example_pred", target_col, era_col)

    return {
        "our_correlation": our_corr,
        "example_correlation": example_corr,
        "delta": our_corr - example_corr,
    }


def compute_all_metrics(
    df: pd.DataFrame,
    prediction_col: str = "prediction",
    target_col: str = "target",
    era_col: str = "era",
    feature_cols: Optional[List[str]] = None,
    meta_model_col: Optional[str] = None,
    benchmark_cols: Optional[List[str]] = None,
    neutralizer: Optional[pd.DataFrame] = None,
    sample_weights: Optional[pd.DataFrame] = None,
    example_preds: Optional[pd.DataFrame] = None,
) -> dict:
    """Compute all Numerai validation metrics."""
    # Compute per-era correlations once, reuse across metrics
    era_corrs = per_era_correlation(df, prediction_col, target_col, era_col)
    metrics = {
        "correlation": mean_correlation(df, prediction_col, target_col, era_col, _era_corrs=era_corrs),
        "sharpe": sharpe_ratio(df, prediction_col, target_col, era_col, _era_corrs=era_corrs),
        "max_drawdown": max_drawdown(df, prediction_col, target_col, era_col, _era_corrs=era_corrs),
        "feature_exposure": feature_exposure(df, prediction_col, feature_cols, era_col),
    }

    # MMC if meta model is available
    if meta_model_col and meta_model_col in df.columns:
        metrics["mmc"] = meta_model_contribution(
            df, prediction_col, meta_model_col, target_col, era_col,
        )

    # Benchmark comparison
    if benchmark_cols:
        metrics["vs_benchmarks"] = benchmark_comparison(
            df, prediction_col, benchmark_cols, target_col, era_col,
        )

    # Signals Alpha (neutralized + weighted correlation)
    if neutralizer is not None or sample_weights is not None:
        metrics["signals_alpha"] = signals_alpha(
            df, prediction_col, target_col, era_col,
            neutralizer=neutralizer,
            sample_weights=sample_weights,
        )

    # Example predictions benchmark
    if example_preds is not None:
        metrics["vs_example"] = example_predictions_comparison(
            df, example_preds, target_col, era_col,
        )

    return metrics
