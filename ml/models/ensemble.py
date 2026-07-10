"""Ensemble methods for combining Numerai model predictions."""

from __future__ import annotations

from typing import Dict, List

import numpy as np
import pandas as pd
from scipy import stats

from data.features import neutralize_features


def rank_average(predictions: Dict[str, pd.Series]) -> pd.Series:
    """Rank-average ensemble: rank each model's predictions, then average ranks.

    This is the standard Numerai ensemble approach — it's robust to
    different prediction scales across models.
    """
    if not predictions:
        raise ValueError("No predictions to ensemble")

    ranked = {}
    for name, preds in predictions.items():
        ranked[name] = preds.rank(pct=True)

    combined = pd.DataFrame(ranked).mean(axis=1)
    # Re-rank the average for uniform distribution
    return combined.rank(pct=True)


def weighted_blend(
    predictions: Dict[str, pd.Series],
    weights: Dict[str, float],
) -> pd.Series:
    """Weighted average of ranked predictions."""
    if not predictions:
        raise ValueError("No predictions to ensemble")

    total_weight = sum(weights.get(name, 1.0) for name in predictions)
    ranked = {}
    for name, preds in predictions.items():
        w = weights.get(name, 1.0) / total_weight
        ranked[name] = preds.rank(pct=True) * w

    combined = pd.DataFrame(ranked).sum(axis=1)
    return combined.rank(pct=True)


def ensemble_with_neutralization(
    predictions: Dict[str, pd.Series],
    df: pd.DataFrame,
    neutralizers: List[str],
    proportion: float = 0.5,
) -> pd.Series:
    """Rank-average ensemble followed by feature neutralization."""
    combined = rank_average(predictions)

    # Add to dataframe for neutralization
    df = df.copy()
    df["ensemble_pred"] = combined

    neutralized = neutralize_features(
        df, "ensemble_pred", neutralizers, proportion
    )

    return neutralized.rank(pct=True)
