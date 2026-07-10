"""GARCH(1,1) conditional volatility features.

Fits GARCH models to era-level return proxies to capture
volatility clustering patterns.
"""

from __future__ import annotations

from typing import List

import numpy as np
import pandas as pd


def fit_garch_features(
    df: pd.DataFrame,
    return_cols: List[str],
    era_col: str = "era",
) -> pd.DataFrame:
    """Add GARCH(1,1) conditional volatility features.

    For each return-proxy column, fits a GARCH model on era-level
    median returns and maps conditional vol back to rows.
    """
    try:
        from arch import arch_model
    except ImportError:
        # arch not installed — skip GARCH features
        return df

    era_returns = df.groupby(era_col)[return_cols].median().sort_index()

    for col in return_cols:
        series = era_returns[col].dropna()
        if len(series) < 20:
            continue

        # Scale to percentage returns for numerical stability
        scaled = series * 100

        try:
            model = arch_model(scaled, vol="Garch", p=1, q=1, mean="Zero", rescale=False)
            result = model.fit(disp="off", show_warning=False)
            cond_vol = result.conditional_volatility / 100  # scale back

            vol_map = cond_vol.to_dict()
            df[f"{col}_garch_vol"] = df[era_col].map(vol_map)

            # Volatility regime: high/low relative to median
            median_vol = cond_vol.median()
            regime_map = {
                era: 1.0 if v > median_vol else 0.0
                for era, v in vol_map.items()
            }
            df[f"{col}_garch_regime"] = df[era_col].map(regime_map)

        except Exception:
            # GARCH fit can fail on some data — skip gracefully
            continue

    return df
