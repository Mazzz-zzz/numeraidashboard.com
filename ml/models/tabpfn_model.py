"""TabPFN v2.5 model for Numerai via bagged subsampling.

TabPFN is a pre-trained transformer that performs in-context learning for
tabular data.  It takes training rows as "context" and predicts new rows
by pattern-matching — no gradient updates needed at inference time.

Limits: max ~50K context rows, ~2K features.
Numerai has ~2.4M rows x 2376 features, so we use bagged subsampling:
  - Select recent eras (last n_recent_eras)
  - Create n_bags bags, each with a random subset of eras + features
  - Subsample rows within each bag to context_rows
  - At predict time, average predictions across all bags

Key differences from other models:
  - No iterative training — context is stored and fed at predict time
  - Do NOT impute NaN — TabPFN handles missing values natively
  - Do NOT scale/normalise — TabPFN has its own preprocessing
  - Each predict() creates fresh TabPFNRegressor instances (lightweight)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np
import pandas as pd

try:
    from tabpfn import TabPFNRegressor

    HAS_TABPFN = True
except ImportError:
    HAS_TABPFN = False

from models.base import NumeraiModel
from config.device import resolve_device_str


class TabPFNModel(NumeraiModel):
    """TabPFN v2.5 with bagged subsampling for Numerai tournament.

    In-context learning produces predictions from an entirely different
    inductive bias than tree or MLP models, yielding orthogonal signal
    for MMC optimisation.
    """

    def __init__(
        self,
        n_bags: int = 8,
        context_rows: int = 10000,
        features_per_bag: int = 500,
        n_recent_eras: int = 24,
        n_estimators_per_bag: int = 4,
        device: str = "auto",
        **kwargs,
    ):
        if not HAS_TABPFN:
            raise RuntimeError(
                "TabPFN not installed. "
                "Install with: pip install tabpfn"
            )

        self.n_bags = int(n_bags)
        self.context_rows = int(context_rows)
        self.features_per_bag = int(features_per_bag)
        self.n_recent_eras = int(n_recent_eras)
        self.n_estimators_per_bag = int(n_estimators_per_bag)

        # Resolve device: honour an explicit choice, else auto-pick
        # cuda -> mps (Apple Silicon) -> cpu. TabPFN itself supports MPS.
        self._device = resolve_device_str(None if device == "auto" else device)

        # Bag storage — populated by fit(), persisted by save()
        self._bags: List[Dict] = []  # each: {X, y, feature_names, seed}
        self._feature_names: List[str] = []

    # ------------------------------------------------------------------
    # fit
    # ------------------------------------------------------------------

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
        """Build bagged context sets from recent eras.

        No gradient training happens here — we just select and store
        the context data that TabPFN will use at predict time.
        """
        self._feature_names = list(feature_cols)

        # ── Select recent eras ──
        all_eras = sorted(train_df[era_col].unique())
        recent_eras = all_eras[-self.n_recent_eras :]
        recent_df = train_df[train_df[era_col].isin(recent_eras)]

        n_features = len(feature_cols)
        feat_per_bag = min(self.features_per_bag, n_features)
        eras_per_bag = min(len(recent_eras), max(len(recent_eras) // 2, 1))

        print(f"  [TabPFN] Building {self.n_bags} bags from "
              f"{len(recent_eras)} recent eras ({len(recent_df):,} rows)")
        print(f"  [TabPFN] {feat_per_bag} features/bag, "
              f"{self.context_rows} context rows/bag, "
              f"{self.n_estimators_per_bag} estimators/bag, "
              f"device={self._device}")

        self._bags = []
        rng = np.random.RandomState(42)

        for bag_idx in range(self.n_bags):
            seed = rng.randint(0, 2**31)
            bag_rng = np.random.RandomState(seed)

            # Random subset of eras
            bag_eras = bag_rng.choice(
                recent_eras, size=eras_per_bag, replace=False,
            )
            bag_df = recent_df[recent_df[era_col].isin(bag_eras)]

            # Random subset of features
            bag_feature_idx = bag_rng.choice(
                n_features, size=feat_per_bag, replace=False,
            )
            bag_feature_idx.sort()
            bag_feature_names = [feature_cols[i] for i in bag_feature_idx]

            # Subsample rows if needed
            if len(bag_df) > self.context_rows:
                bag_df = bag_df.sample(
                    n=self.context_rows, random_state=bag_rng,
                )

            # Extract context — DO NOT fillna (TabPFN handles NaN natively)
            X_context = bag_df[bag_feature_names].values.astype(np.float32)
            y_context = bag_df[target_col].values.astype(np.float32)

            self._bags.append({
                "X": X_context,
                "y": y_context,
                "feature_names": bag_feature_names,
                "seed": seed,
            })

            # ── Validation metric for this bag ──
            train_loss = float(np.var(y_context))
            val_loss = train_loss  # default if no val_df

            if val_df is not None and len(val_df) > 0:
                try:
                    reg = TabPFNRegressor(
                        device=self._device,
                        inference_precision="autocast",
                        fit_mode="low_memory",
                        memory_saving_mode=16,
                        random_state=seed,
                        n_estimators=self.n_estimators_per_bag,
                        ignore_pretraining_limits=True,
                    )
                    reg.fit(X_context, y_context)
                    X_val = val_df[bag_feature_names].values.astype(np.float32)
                    y_val = val_df[target_col].values.astype(np.float32)
                    preds = reg.predict(X_val)
                    val_loss = float(np.mean((preds - y_val) ** 2))
                    del reg
                    self._clear_gpu_cache()
                except Exception as e:
                    print(f"  [TabPFN] Bag {bag_idx} val failed: {e}")

            print(f"  [TabPFN] Bag {bag_idx}/{self.n_bags}: "
                  f"{len(X_context):,} rows, {len(bag_feature_names)} features, "
                  f"val_mse={val_loss:.6f}")

            if epoch_callback:
                epoch_callback({
                    "epoch": bag_idx,
                    "train_loss": train_loss,
                    "val_loss": val_loss,
                    "train_l2": train_loss,
                    "val_l2": val_loss,
                })

        print(f"  [TabPFN] All {self.n_bags} bags built")

        return {
            "best_iteration": self.n_bags,
            "best_score": {"val": {"mse": val_loss}},
            "train_eras": len(recent_eras),
            "val_eras": val_df[era_col].nunique() if val_df is not None else 0,
        }

    # ------------------------------------------------------------------
    # predict
    # ------------------------------------------------------------------

    def predict(self, df: pd.DataFrame, feature_cols: List[str]) -> pd.Series:
        """Average predictions across all bags.

        Each bag creates a fresh TabPFNRegressor, fits it on the stored
        context, predicts the test data, then frees memory.  Bags are
        processed sequentially to manage VRAM.
        """
        if not self._bags:
            raise RuntimeError("Model not trained or loaded")

        n_rows = len(df)
        all_preds = np.zeros(n_rows, dtype=np.float64)

        for bag_idx, bag in enumerate(self._bags):
            print(f"  [TabPFN] Predicting bag {bag_idx}/{len(self._bags)} "
                  f"({len(bag['feature_names'])} features, "
                  f"{len(bag['X']):,} context rows)")

            reg = TabPFNRegressor(
                device=self._device,
                inference_precision="autocast",
                fit_mode="low_memory",
                memory_saving_mode=16,
                random_state=bag["seed"],
                n_estimators=self.n_estimators_per_bag,
                ignore_pretraining_limits=True,
            )

            # Fit on stored context
            reg.fit(bag["X"], bag["y"])

            # Predict — DO NOT fillna (TabPFN handles NaN natively)
            X_test = df[bag["feature_names"]].values.astype(np.float32)
            preds = reg.predict(X_test)
            all_preds += preds

            # Free memory
            del reg
            self._clear_gpu_cache()

        # Average across bags
        all_preds /= len(self._bags)

        return pd.Series(
            all_preds.astype(np.float32), index=df.index, name="prediction",
        )

    # ------------------------------------------------------------------
    # save / load
    # ------------------------------------------------------------------

    def save(self, path: Path) -> None:
        """Save bag contexts as numpy arrays + meta.json."""
        if not self._bags:
            raise RuntimeError("No model to save")

        path.mkdir(parents=True, exist_ok=True)

        meta = {
            "model_type": self.model_type,
            "n_bags": self.n_bags,
            "context_rows": self.context_rows,
            "features_per_bag": self.features_per_bag,
            "n_recent_eras": self.n_recent_eras,
            "n_estimators_per_bag": self.n_estimators_per_bag,
            "device": self._device,
            "feature_names": self._feature_names,
            "actual_bags": len(self._bags),
        }
        with open(path / "meta.json", "w") as f:
            json.dump(meta, f, indent=2)

        for i, bag in enumerate(self._bags):
            np.save(str(path / f"bag_{i}_X.npy"), bag["X"])
            np.save(str(path / f"bag_{i}_y.npy"), bag["y"])
            with open(path / f"bag_{i}_features.json", "w") as f:
                json.dump(bag["feature_names"], f)

    def load(self, path: Path) -> None:
        """Load bag contexts from disk."""
        with open(path / "meta.json") as f:
            meta = json.load(f)

        self._feature_names = meta.get("feature_names", [])
        self.n_bags = meta.get("n_bags", self.n_bags)
        self.context_rows = meta.get("context_rows", self.context_rows)
        self.features_per_bag = meta.get("features_per_bag", self.features_per_bag)
        self.n_recent_eras = meta.get("n_recent_eras", self.n_recent_eras)
        self.n_estimators_per_bag = meta.get("n_estimators_per_bag", self.n_estimators_per_bag)
        # Allow device override on load (e.g. trained on GPU, loaded on CPU)
        # Keep current self._device if meta doesn't specify

        actual_bags = meta.get("actual_bags", self.n_bags)
        self._bags = []

        for i in range(actual_bags):
            X = np.load(str(path / f"bag_{i}_X.npy"))
            y = np.load(str(path / f"bag_{i}_y.npy"))
            with open(path / f"bag_{i}_features.json") as f:
                feature_names = json.load(f)

            # Read seed from the original bag — reconstruct from index
            # (seeds are deterministic from bag index via RNG seeded with 42)
            rng = np.random.RandomState(42)
            for _ in range(i + 1):
                seed = rng.randint(0, 2**31)

            self._bags.append({
                "X": X,
                "y": y,
                "feature_names": feature_names,
                "seed": seed,
            })

        print(f"  [TabPFN] Loaded {len(self._bags)} bags from {path}")

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    def _clear_gpu_cache(self) -> None:
        """Free GPU memory if CUDA is available."""
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass

    @property
    def model_type(self) -> str:
        return "tabpfn"
