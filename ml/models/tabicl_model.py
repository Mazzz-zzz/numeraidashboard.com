"""TabICL v2 model for Numerai — open-source tabular foundation model.

TabICL v2 is an in-context learning model that predicts by conditioning on
training data in a single forward pass — no gradient updates needed.  It uses
column-then-row attention to handle up to 500K rows, and is 10x faster than
TabPFN v2.5.

Limits: max ~500K rows, ~100 features per forward pass.
Numerai small (42 features) fits natively; medium/all require feature
subsampling via bagging across multiple TabICL instances.

Key differences from gradient-trained models:
  - No iterative training — context is stored and fed at predict time
  - Do NOT impute NaN — TabICL handles missing values natively
  - Do NOT scale/normalise — TabICL has its own preprocessing
  - Apache 2.0 license — no commercial restrictions

Reference: Qu et al., "TabICL: A Tabular Foundation Model for In-Context
Learning on Large Data", ICML 2025.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, List, Optional

import numpy as np
import pandas as pd

try:
    from tabicl import TabICLRegressor

    HAS_TABICL = True
except ImportError:
    HAS_TABICL = False

from models.base import NumeraiModel
from config.device import resolve_device_str, empty_cache


class TabICLModel(NumeraiModel):
    """TabICL v2 with bagged subsampling for Numerai tournament.

    In-context learning from a different architecture family than TabPFN,
    with 10x faster inference and Apache 2.0 license.
    """

    MAX_FEATURES = 100  # TabICL v2 hard limit
    ALL_NORM_METHODS = ["none", "power", "quantile", "quantile_rtdl", "robust"]

    def __init__(
        self,
        n_bags: int = 12,
        context_rows: int = 50000,
        features_per_bag: int = 42,
        n_recent_eras: int = 48,
        n_estimators_per_bag: int = 16,
        norm_methods: Optional[str] = "all",
        **kwargs,
    ):
        if not HAS_TABICL:
            raise RuntimeError(
                "TabICL not installed. Install with: pip install tabicl"
            )

        self.n_bags = int(n_bags)
        self.context_rows = int(context_rows)
        self.features_per_bag = min(int(features_per_bag), self.MAX_FEATURES)
        self.n_recent_eras = int(n_recent_eras)
        self.n_estimators_per_bag = int(n_estimators_per_bag)

        # norm_methods: "all" for all 5, comma-separated list, or None for default
        if norm_methods == "all":
            self.norm_methods = self.ALL_NORM_METHODS
        elif norm_methods and norm_methods != "default":
            self.norm_methods = [m.strip() for m in str(norm_methods).split(",")]
        else:
            self.norm_methods = None  # TabICL default ["none", "power"]

        # offload_mode: "gpu" keeps embeddings on GPU (fastest), "cpu" offloads,
        # "auto" (TabICL default) often picks CPU and kills performance.
        self.offload_mode = "gpu"

        self._feature_names: List[str] = []
        self._bags: List[dict] = []

        # Shared model state — avoids reloading the frozen transformer per bag
        self._shared_model = None
        self._shared_model_config = None
        self._shared_model_path = None

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
        """Store bagged context windows from recent eras."""
        self._feature_names = feature_cols
        n_features = len(feature_cols)

        # Cap features_per_bag to actual feature count and TabICL limit
        fpb = min(self.features_per_bag, n_features, self.MAX_FEATURES)

        # If features fit within limit, no subsampling needed
        needs_feature_bagging = n_features > self.MAX_FEATURES

        # Select recent eras
        all_eras = sorted(train_df[era_col].unique())
        recent_eras = all_eras[-self.n_recent_eras:]

        recent_df = train_df[train_df[era_col].isin(recent_eras)]
        print(f"  [TabICL] {len(recent_df):,} rows from {len(recent_eras)} recent eras, "
              f"{n_features} features, {self.n_bags} bags, "
              f"{self.n_estimators_per_bag} estimators/bag, "
              f"norm={self.norm_methods}, offload={self.offload_mode}")
        if needs_feature_bagging:
            print(f"  [TabICL] Feature bagging: {fpb} features per bag "
                  f"(total {n_features} > limit {self.MAX_FEATURES})")
        else:
            print(f"  [TabICL] All {n_features} features fit within limit, "
                  f"using era/row bagging only")

        rng = np.random.RandomState(42)
        self._bags = []

        for bag_idx in range(self.n_bags):
            # Subsample eras
            n_eras = min(12, len(recent_eras))
            era_sample = rng.choice(recent_eras, size=n_eras, replace=False)
            ctx = recent_df[recent_df[era_col].isin(era_sample)]

            # Subsample rows
            if len(ctx) > self.context_rows:
                idx = rng.choice(len(ctx), size=self.context_rows, replace=False)
                ctx = ctx.iloc[idx]

            # Subsample features if needed
            if needs_feature_bagging:
                feat_sample = list(rng.choice(feature_cols, size=fpb, replace=False))
            else:
                feat_sample = feature_cols

            # Store context — pass raw values, no fillna (TabICL handles NaN)
            X_ctx = ctx[feat_sample].values.astype(np.float32)
            y_ctx = ctx[target_col].values.astype(np.float32)
            seed = int(rng.randint(0, 2**31))

            self._bags.append({
                "X": X_ctx,
                "y": y_ctx,
                "features": feat_sample,
                "seed": seed,
            })

            # Validate at the last bag — subsample for speed, full predict
            # happens once in the trainer for final metrics
            val_loss = None
            is_last_bag = bag_idx == self.n_bags - 1
            if val_df is not None and is_last_bag:
                try:
                    val_sample = val_df.sample(
                        n=min(50000, len(val_df)), random_state=42,
                    )
                    fast_preds = self.predict(val_sample, feature_cols)
                    val_loss = float(np.mean(
                        (fast_preds.values - val_sample[target_col].values) ** 2
                    ))
                    self._clear_gpu_cache()
                except Exception as e:
                    print(f"  [TabICL] Validation failed: {e}")

            if epoch_callback:
                epoch_callback({
                    "epoch": bag_idx,
                    "train_loss": 0.0,
                    "val_loss": val_loss or 0.0,
                    "train_l2": 0.0,
                    "val_l2": val_loss or 0.0,
                })

            print(f"  [TabICL] Bag {bag_idx}: {len(X_ctx):,} rows, "
                  f"{len(feat_sample)} features"
                  f"{f', val_mse={val_loss:.6f}' if val_loss else ''}")

        return {
            "best_iteration": self.n_bags,
            "best_score": {"val": {"mse": val_loss or 0.0}},
            "train_eras": len(recent_eras),
            "val_eras": val_df[era_col].nunique() if val_df is not None else 0,
        }

    def _get_pred_chunk_size(self) -> int:
        """Auto-tune prediction chunk size based on GPU memory."""
        try:
            import torch
            if torch.cuda.is_available():
                total_mem = torch.cuda.get_device_properties(0).total_memory
                if total_mem > 40e9:   # A100-80GB or similar
                    return 20000
                elif total_mem > 20e9:  # L4-24GB or similar
                    return 10000
        except (ImportError, RuntimeError):
            pass
        return 5000

    def _make_regressor(self, bag: dict, device: str) -> "TabICLRegressor":
        """Create a TabICLRegressor, reusing the shared transformer weights."""
        reg = TabICLRegressor(
            device=device,
            n_estimators=self.n_estimators_per_bag,
            random_state=bag["seed"],
            norm_methods=self.norm_methods,
            offload_mode=self.offload_mode,
            use_amp=True,
            use_fa3=True,
            batch_size=16,
        )

        if self._shared_model is None:
            # First bag: normal fit loads the transformer from disk
            reg.fit(bag["X"], bag["y"])
            self._shared_model = reg.model_
            self._shared_model_config = reg.model_config_
            self._shared_model_path = getattr(reg, "model_path_", None)
        else:
            # Subsequent bags: patch _load_model to skip disk I/O
            _sm, _smc, _smp = (
                self._shared_model, self._shared_model_config, self._shared_model_path,
            )
            def _patched_load(self_reg=reg):
                self_reg.model_ = _sm
                self_reg.model_config_ = _smc
                self_reg.model_path_ = _smp
            original_load = reg._load_model
            reg._load_model = _patched_load
            reg.fit(bag["X"], bag["y"])
            reg._load_model = original_load

        return reg

    def predict(self, df: pd.DataFrame, feature_cols: List[str]) -> pd.Series:
        """Predict by averaging across bagged TabICL instances.

        Loads the frozen transformer once and shares it across all bags.
        Processes test rows in chunks to avoid OOM.
        """
        if not self._bags:
            raise RuntimeError("Model not trained or loaded")

        device = resolve_device_str()
        pred_chunk_size = self._get_pred_chunk_size()
        all_preds = np.zeros(len(df), dtype=np.float64)

        for i, bag in enumerate(self._bags):
            reg = self._make_regressor(bag, device)

            X_test = df[bag["features"]].values.astype(np.float32)

            # Chunked prediction to avoid OOM
            bag_preds = np.empty(len(X_test), dtype=np.float32)
            for start in range(0, len(X_test), pred_chunk_size):
                end = min(start + pred_chunk_size, len(X_test))
                bag_preds[start:end] = reg.predict(X_test[start:end])

            all_preds += bag_preds
            del reg

        # Release shared model after all bags are done
        self._shared_model = None
        self._shared_model_config = None
        self._shared_model_path = None
        self._clear_gpu_cache()

        all_preds /= self.n_bags
        return pd.Series(all_preds, index=df.index, name="prediction")

    def save(self, path: Path) -> None:
        """Save bag contexts and config."""
        if not self._bags:
            raise RuntimeError("No model to save")

        path.mkdir(parents=True, exist_ok=True)

        for i, bag in enumerate(self._bags):
            np.save(str(path / f"bag_{i}_X.npy"), bag["X"])
            np.save(str(path / f"bag_{i}_y.npy"), bag["y"])
            with open(path / f"bag_{i}_features.json", "w") as f:
                json.dump(bag["features"], f)

        meta = {
            "model_type": self.model_type,
            "n_bags": self.n_bags,
            "context_rows": self.context_rows,
            "features_per_bag": self.features_per_bag,
            "n_recent_eras": self.n_recent_eras,
            "n_estimators_per_bag": self.n_estimators_per_bag,
            "norm_methods": self.norm_methods,
            "offload_mode": self.offload_mode,
            "feature_names": self._feature_names,
            "bag_seeds": [b["seed"] for b in self._bags],
        }
        with open(path / "meta.json", "w") as f:
            json.dump(meta, f, indent=2)

    def load(self, path: Path) -> None:
        """Load bag contexts and config from disk."""
        with open(path / "meta.json") as f:
            meta = json.load(f)

        self._feature_names = meta.get("feature_names", [])
        self.n_bags = meta.get("n_bags", self.n_bags)
        self.context_rows = meta.get("context_rows", self.context_rows)
        self.features_per_bag = meta.get("features_per_bag", self.features_per_bag)
        self.n_recent_eras = meta.get("n_recent_eras", self.n_recent_eras)
        self.n_estimators_per_bag = meta.get("n_estimators_per_bag", self.n_estimators_per_bag)
        self.norm_methods = meta.get("norm_methods", self.norm_methods)
        self.offload_mode = meta.get("offload_mode", self.offload_mode)
        seeds = meta.get("bag_seeds", [])

        self._bags = []
        for i in range(self.n_bags):
            X = np.load(str(path / f"bag_{i}_X.npy"))
            y = np.load(str(path / f"bag_{i}_y.npy"))
            with open(path / f"bag_{i}_features.json") as f:
                features = json.load(f)
            self._bags.append({
                "X": X,
                "y": y,
                "features": features,
                "seed": seeds[i] if i < len(seeds) else 42,
            })

    @staticmethod
    def _clear_gpu_cache() -> None:
        empty_cache()

    @property
    def model_type(self) -> str:
        return "tabicl"
