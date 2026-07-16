"""XGBoost model with era-aware training for Numerai."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, List, Optional

import numpy as np
import pandas as pd
import xgboost as xgb

from models.base import NumeraiModel


class _EpochCallback(xgb.callback.TrainingCallback):
    """Translate XGBoost evaluation logs to the shared progress contract."""

    def __init__(self, user_callback: Callable[[dict], None], every_n: int = 50):
        self._user_callback = user_callback
        self._every_n = every_n

    def after_iteration(self, model, epoch: int, evals_log: dict) -> bool:
        if epoch % self._every_n:
            return False

        result = {"epoch": epoch}
        dataset_names = {"validation_0": "train", "validation_1": "val"}
        for dataset, metrics in evals_log.items():
            prefix = dataset_names.get(dataset, dataset)
            for metric, values in metrics.items():
                if not values:
                    continue
                value = float(values[-1])
                result[f"{prefix}_{metric}"] = value
                if metric in {"rmse", "mse"}:
                    result[f"{prefix}_loss"] = value
        self._user_callback(result)
        return False


class XGBoostModel(NumeraiModel):
    """Histogram-based XGBoost regressor with era-aware early stopping."""

    def __init__(
        self,
        n_estimators: int = 10000,
        learning_rate: float = 0.005,
        max_depth: int = 8,
        feature_fraction: float = 0.1,
        bagging_fraction: float = 0.5,
        early_stopping_rounds: int = 200,
        **kwargs,
    ):
        self.n_estimators = n_estimators
        self.early_stopping_rounds = early_stopping_rounds
        self.params = {
            "objective": "reg:squarederror",
            "eval_metric": "rmse",
            "n_estimators": n_estimators,
            "learning_rate": learning_rate,
            "max_depth": max(0, max_depth),
            "colsample_bytree": feature_fraction,
            "subsample": bagging_fraction,
            "tree_method": "hist",
            "random_state": 42,
            "n_jobs": -1,
            **kwargs,
        }
        if early_stopping_rounds > 0:
            self.params["early_stopping_rounds"] = early_stopping_rounds
        self._model: Optional[xgb.XGBRegressor] = None
        self._feature_names: List[str] = []

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
        """Train XGBoost with an external or trailing-era validation set."""
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
            w_train = sample_weight[train_mask.to_numpy()] if sample_weight is not None else None
            w_val = sample_weight[val_mask.to_numpy()] if sample_weight is not None else None
            n_train_eras = len(train_eras)
            n_val_eras = len(val_eras)

        callbacks = [_EpochCallback(epoch_callback)] if epoch_callback else None
        self._model = xgb.XGBRegressor(**self.params, callbacks=callbacks)
        fit_kwargs = {
            "sample_weight": w_train,
            "eval_set": [(X_train, y_train), (X_val, y_val)],
            "verbose": False,
        }
        if w_val is not None:
            fit_kwargs["sample_weight_eval_set"] = [w_train, w_val]
        self._model.fit(X_train, y_train, **fit_kwargs)

        best_iteration = getattr(
            self._model,
            "best_iteration",
            self._model.get_booster().num_boosted_rounds() - 1,
        )
        return {
            "best_iteration": best_iteration,
            "best_score": getattr(self._model, "best_score", None),
            "train_eras": n_train_eras,
            "val_eras": n_val_eras,
        }

    def predict(self, df: pd.DataFrame, feature_cols: list[str]) -> pd.Series:
        """Generate predictions using the best early-stopping iteration."""
        if self._model is None:
            raise RuntimeError("Model not trained or loaded")
        predictions = self._model.predict(df[feature_cols])
        return pd.Series(predictions, index=df.index, name="prediction")

    def save(self, path: Path) -> None:
        """Save the booster and adapter metadata."""
        if self._model is None:
            raise RuntimeError("No model to save")
        path.mkdir(parents=True, exist_ok=True)
        self._model.save_model(path / "model.ubj")
        metadata = {
            "model_type": self.model_type,
            "params": self.params,
            "n_estimators": self.n_estimators,
            "early_stopping_rounds": self.early_stopping_rounds,
            "feature_names": self._feature_names,
        }
        with (path / "meta.json").open("w", encoding="utf-8") as handle:
            json.dump(metadata, handle, indent=2)

    def load(self, path: Path) -> None:
        """Load the booster and adapter metadata."""
        self._model = xgb.XGBRegressor()
        self._model.load_model(path / "model.ubj")
        metadata_path = path / "meta.json"
        if metadata_path.exists():
            with metadata_path.open(encoding="utf-8") as handle:
                metadata = json.load(handle)
            self.params = metadata.get("params", self.params)
            self.n_estimators = metadata.get("n_estimators", self.n_estimators)
            self.early_stopping_rounds = metadata.get(
                "early_stopping_rounds", self.early_stopping_rounds
            )
            self._feature_names = metadata.get("feature_names", [])

    @property
    def model_type(self) -> str:
        return "xgboost"
