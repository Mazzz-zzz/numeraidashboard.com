"""WarpGBM model for Numerai — GPU-native gradient boosting.

WarpGBM (https://github.com/jefferythewind/warpgbm, GPL) runs gradient
boosting's hot loops as tensor ops. Upstream is CUDA-only; we install the
Mazzz-zzz/warpgbm@mps-support fork, which adds a pure-PyTorch kernel fallback
so the same code runs on Apple Silicon (MPS) or CPU. Install with:

    pip install "git+https://github.com/Mazzz-zzz/warpgbm.git@mps-support"

The wrapper defaults to pooled training (era_buckets=1). WarpGBM's
Directional Era-Splitting activates when era_buckets > 1; in our v5.3
benchmarks it reduced correlation at every granularity tested, so it is
opt-in for experimentation rather than a default.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, List, Optional

import numpy as np
import pandas as pd

from models.base import NumeraiModel


class WarpGBMModel(NumeraiModel):
    """WarpGBM regression with optional era-bucketed invariant splitting."""

    PREDICT_CHUNK = 500_000

    def __init__(
        self,
        n_estimators: int = 2000,
        learning_rate: float = 0.01,
        max_depth: int = 6,
        min_data_in_leaf: int = 10000,
        feature_fraction: float = 0.5,
        max_bin: int = 8,
        min_split_gain: float = 0.0,
        l2_reg: float = 1e-6,
        era_buckets: int = 1,
        device: Optional[str] = None,
        **kwargs,
    ):
        self.n_estimators = n_estimators
        self.params = {
            "n_estimators": n_estimators,
            "learning_rate": learning_rate,
            "max_depth": max_depth,
            # For MSE the hessian is a row count, so LightGBM's
            # min_data_in_leaf and WarpGBM's min_child_weight coincide.
            "min_child_weight": int(min_data_in_leaf),
            "colsample_bytree": feature_fraction,
            # bin indices are int8 in WarpGBM's kernels
            "num_bins": int(min(max(max_bin, 2), 127)),
            "min_split_gain": min_split_gain,
            "L2_reg": l2_reg,
        }
        self.era_buckets = max(1, int(era_buckets))
        self.device = device
        self._model = None
        self._feature_names: List[str] = []

    def _features_to_numpy(self, df: pd.DataFrame, feature_cols: List[str]) -> np.ndarray:
        X = df[feature_cols]
        if all(X.dtypes == np.int8):
            # Pre-binned (feature_dtype=int8 loader) — WarpGBM's fast path.
            return X.to_numpy()
        return X.to_numpy(dtype=np.float32)

    def _era_ids(self, eras: pd.Series) -> np.ndarray:
        if self.era_buckets <= 1:
            return np.zeros(len(eras), dtype=np.int32)
        codes = pd.Categorical(eras).codes.astype(np.int64)
        n = int(codes.max()) + 1
        return (codes * self.era_buckets // n).astype(np.int32)

    def fit(
        self,
        train_df: pd.DataFrame,
        feature_cols: List[str],
        target_col: str = "target",
        era_col: str = "era",
        epoch_callback: Optional[Callable[[dict], None]] = None,
        sample_weight: Optional[np.ndarray] = None,
        val_df: Optional[pd.DataFrame] = None,
    ) -> dict:
        from warpgbm import WarpGBM

        self._feature_names = list(feature_cols)
        X = self._features_to_numpy(train_df, feature_cols)
        y = train_df[target_col].to_numpy(dtype=np.float32)
        era_id = self._era_ids(train_df[era_col])

        self._model = WarpGBM(device=self.device, objective="regression", random_state=7, **self.params)
        self._model.fit(X, y, era_id=era_id)

        if epoch_callback:
            epoch_callback({"epoch": self.n_estimators, "train_loss": float("nan")})
        return {
            "best_iteration": self.n_estimators,
            "train_eras": int(train_df[era_col].nunique()),
            "val_eras": int(val_df[era_col].nunique()) if val_df is not None else 0,
            "era_buckets": self.era_buckets,
            "device": self._model.device,
        }

    def predict(self, df: pd.DataFrame, feature_cols: list[str]) -> pd.Series:
        if self._model is None:
            raise RuntimeError("Model not trained or loaded")
        X = self._features_to_numpy(df, feature_cols)
        parts = [
            self._model.predict(X[start:start + self.PREDICT_CHUNK])
            for start in range(0, len(X), self.PREDICT_CHUNK)
        ]
        preds = np.concatenate(parts) if parts else np.empty(0)
        return pd.Series(preds, index=df.index, name="prediction")

    def save(self, path: Path) -> None:
        if self._model is None:
            raise RuntimeError("No model to save")
        import torch

        path.mkdir(parents=True, exist_ok=True)
        # Tensors may live on MPS; land them on CPU so any machine can load.
        forest = [
            {k: (v.cpu() if isinstance(v, torch.Tensor) else v) for k, v in tree.items()}
            if isinstance(tree, dict) else tree
            for tree in getattr(self._model, "forest", [])
        ]
        torch.save({"model": self._model, "forest_cpu": forest}, path / "warpgbm_model.pt")
        with open(path / "meta.json", "w") as f:
            json.dump(
                {
                    "model_type": self.model_type,
                    "params": self.params,
                    "era_buckets": self.era_buckets,
                    "feature_names": self._feature_names,
                },
                f,
                indent=2,
            )

    def load(self, path: Path) -> None:
        import torch

        payload = torch.load(path / "warpgbm_model.pt", map_location="cpu", weights_only=False)
        self._model = payload["model"]
        # Move the model's working device to whatever this machine has.
        self._model.device = self.device or (
            "cuda" if torch.cuda.is_available()
            else "mps" if torch.backends.mps.is_available()
            else "cpu"
        )
        meta_path = path / "meta.json"
        if meta_path.exists():
            with open(meta_path) as f:
                meta = json.load(f)
            self._feature_names = meta.get("feature_names", [])
            self.params = meta.get("params", self.params)
            self.era_buckets = meta.get("era_buckets", self.era_buckets)

    @property
    def model_type(self) -> str:
        return "warpgbm"
