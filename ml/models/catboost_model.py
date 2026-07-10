"""CatBoost model with era-aware training for Numerai."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np
import pandas as pd

try:
    import catboost as cb
except ImportError:
    cb = None

from models.base import NumeraiModel


class CatBoostModel(NumeraiModel):
    """CatBoost with era-based cross-validation and early stopping."""

    def __init__(
        self,
        iterations: int = 10000,
        learning_rate: float = 0.005,
        depth: int = 8,
        l2_leaf_reg: float = 3.0,
        random_strength: float = 1.0,
        bagging_temperature: float = 0.5,
        border_count: int = 128,
        early_stopping_rounds: int = 200,
        **kwargs,
    ):
        self.n_estimators = iterations
        self.params = {
            "loss_function": "RMSE",
            "eval_metric": "RMSE",
            "iterations": iterations,
            "learning_rate": learning_rate,
            "depth": depth,
            "l2_leaf_reg": l2_leaf_reg,
            "random_strength": random_strength,
            "bagging_temperature": bagging_temperature,
            "border_count": border_count,
            "verbose": False,
            "random_seed": 42,
            "thread_count": -1,  # Use all cores
            **kwargs,
        }
        self.early_stopping_rounds = early_stopping_rounds
        self._model: Optional[cb.CatBoostRegressor] = None
        self._feature_names: List[str] = []

    @staticmethod
    def _make_epoch_callback(
        user_cb: Callable[[dict], None],
        every_n: int = 100,
    ):
        """Create a CatBoost callback that reports metrics every N iterations."""
        class EpochCallback:
            def after_iteration(self, info):
                iteration = info.iteration
                if iteration % every_n == 0:
                    result = {"epoch": iteration}
                    # CatBoost passes metrics differently
                    if hasattr(info, 'metrics'):
                        for metric_name, values in info.metrics.items():
                            if values:  # List of values per dataset
                                result[f"val_{metric_name}"] = values[-1]
                    user_cb(result)
                return True  # Continue training
        return EpochCallback()

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
        """Train CatBoost with external or era-aware train/val split."""
        if cb is None:
            raise RuntimeError("CatBoost not installed. Install with: pip install catboost")

        self._feature_names = feature_cols

        if val_df is not None:
            X_train = train_df[feature_cols]
            y_train = train_df[target_col]
            X_val = val_df[feature_cols]
            y_val = val_df[target_col]
            w_train = sample_weight
            w_val = None
            n_train_eras = train_df[era_col].nunique()
            n_val_eras = val_df[era_col].nunique()
        else:
            # Fallback: era-aware split (last 20% of eras)
            eras = sorted(train_df[era_col].unique())
            split_idx = int(len(eras) * 0.8)
            train_eras = set(eras[:split_idx])
            val_eras = set(eras[split_idx:])

            train_mask = train_df[era_col].isin(train_eras)
            val_mask = train_df[era_col].isin(val_eras)

            X_train = train_df.loc[train_mask, feature_cols]
            y_train = train_df.loc[train_mask, target_col]
            X_val = train_df.loc[val_mask, feature_cols]
            y_val = train_df.loc[val_mask, target_col]

            w_train = None
            w_val = None
            if sample_weight is not None:
                w_train = sample_weight[train_mask.values]
                w_val = sample_weight[val_mask.values]
            n_train_eras = len(train_eras)
            n_val_eras = len(val_eras)

        # Create pools
        train_pool = cb.Pool(X_train, y_train, weight=w_train)
        val_pool = cb.Pool(X_val, y_val, weight=w_val)

        # Initialize model
        self._model = cb.CatBoostRegressor(**self.params)

        # Prepare callbacks
        callbacks = []
        if epoch_callback:
            callbacks.append(self._make_epoch_callback(epoch_callback, every_n=50))

        # Train with early stopping
        self._model.fit(
            train_pool,
            eval_set=val_pool,
            early_stopping_rounds=self.early_stopping_rounds,
            verbose=False,
            callbacks=callbacks,
        )

        # Get best iteration info
        best_iteration = self._model.get_best_iteration()
        best_score = self._model.get_best_score()

        return {
            "best_iteration": best_iteration if best_iteration is not None else self._model.tree_count_,
            "best_score": best_score,
            "train_eras": n_train_eras,
            "val_eras": n_val_eras,
        }

    def predict(self, df: pd.DataFrame, feature_cols: list[str]) -> pd.Series:
        """Generate predictions."""
        if self._model is None:
            raise RuntimeError("Model not trained or loaded")

        preds = self._model.predict(df[feature_cols])
        return pd.Series(preds, index=df.index, name="prediction")

    def save(self, path: Path) -> None:
        """Save model and metadata."""
        if self._model is None:
            raise RuntimeError("No model to save")

        path.mkdir(parents=True, exist_ok=True)
        model_file = path / "model.cbm"
        self._model.save_model(str(model_file))

        meta = {
            "model_type": self.model_type,
            "params": self.params,
            "n_estimators": self.n_estimators,
            "feature_names": self._feature_names,
            "best_iteration": self._model.get_best_iteration(),
        }
        with open(path / "meta.json", "w") as f:
            json.dump(meta, f, indent=2)

    def load(self, path: Path) -> None:
        """Load model from disk."""
        if cb is None:
            raise RuntimeError("CatBoost not installed. Install with: pip install catboost")
        
        model_file = path / "model.cbm"
        self._model = cb.CatBoostRegressor()
        self._model.load_model(str(model_file))

        meta_path = path / "meta.json"
        if meta_path.exists():
            with open(meta_path) as f:
                meta = json.load(f)
            self._feature_names = meta.get("feature_names", [])
            self.params = meta.get("params", self.params)
            self.n_estimators = meta.get("n_estimators", self.n_estimators)

    @property
    def model_type(self) -> str:
        return "catboost"
