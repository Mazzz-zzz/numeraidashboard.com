"""LightGBM model with era-aware training for Numerai."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Dict, List, Optional

import lightgbm as lgb
import numpy as np
import pandas as pd

from models.base import NumeraiModel


class LightGBMModel(NumeraiModel):
    """LightGBM with era-based cross-validation and early stopping."""

    def __init__(
        self,
        num_leaves: int = 512,
        max_depth: int = 8,
        learning_rate: float = 0.005,
        n_estimators: int = 10000,
        feature_fraction: float = 0.1,
        bagging_fraction: float = 0.5,
        bagging_freq: int = 1,
        early_stopping_rounds: int = 200,
        **kwargs,
    ):
        self.n_estimators = n_estimators
        self.params = {
            "objective": "regression",
            "metric": "mse",
            "num_leaves": num_leaves,
            "max_depth": max_depth,
            "learning_rate": learning_rate,
            "feature_fraction": feature_fraction,
            "bagging_fraction": bagging_fraction,
            "bagging_freq": bagging_freq,
            "verbose": -1,
            **kwargs,
        }
        self.early_stopping_rounds = early_stopping_rounds
        self._model: Optional[lgb.Booster] = None
        self._feature_names: List[str] = []

    @staticmethod
    def _make_epoch_callback(
        user_cb: Callable[[dict], None],
        every_n: int = 100,
    ):
        """Create a LightGBM callback that reports metrics every N rounds."""
        def callback(env):
            if env.iteration % every_n == 0:
                result = {"epoch": env.iteration}
                for name, metric_name, value, _ in env.evaluation_result_list:
                    result[f"{name}_{metric_name}"] = value
                # Map to standard names
                if "train_l2" in result:
                    result["train_loss"] = result["train_l2"]
                if "val_l2" in result:
                    result["val_loss"] = result["val_l2"]
                if "train_mse" in result:
                    result["train_loss"] = result["train_mse"]
                if "val_mse" in result:
                    result["val_loss"] = result["val_mse"]
                user_cb(result)
        callback.order = 50
        return callback

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
        """Train LightGBM with external or era-aware train/val split.

        If val_df is provided, all of train_df is used for training and
        val_df is the early-stopping eval set.  Otherwise falls back to
        an 80/20 era-based split of train_df.
        """
        self._feature_names = feature_cols

        if val_df is not None:
            # Use all training data; external val for early stopping
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

        # LightGBM promotes pandas input to float64 while building a Dataset —
        # up to 8x the frame size on wide int8 data (79GB on the full v5.3
        # all-features train set). Convert to float32 numpy ourselves and bin
        # one matrix at a time so only a single raw copy is ever alive.
        import gc
        skip_val = self.early_stopping_rounds >= self.n_estimators
        # Binning parameters (max_bin etc.) must be present at construction —
        # lgb.train cannot change them on an already-constructed Dataset.
        dtrain = lgb.Dataset(
            X_train.to_numpy(dtype=np.float32),
            label=y_train.to_numpy(dtype=np.float32),
            weight=w_train,
            params=self.params,
            free_raw_data=True,
        )
        dtrain.construct()
        gc.collect()

        dval = None
        if not skip_val:
            dval = lgb.Dataset(
                X_val.to_numpy(dtype=np.float32),
                label=y_val.to_numpy(dtype=np.float32),
                weight=w_val,
                reference=dtrain,
                params=self.params,
                free_raw_data=True,
            )
            dval.construct()
        del X_train, y_train, X_val, y_val, w_train, w_val
        gc.collect()

        # With the patience >= the tree budget, early stopping can never fire;
        # skip the val Dataset entirely — on full-history data it costs more
        # memory than training itself.
        callbacks = [lgb.log_evaluation(100)]
        if dval is not None:
            callbacks.insert(0, lgb.early_stopping(self.early_stopping_rounds))

        if epoch_callback:
            callbacks.append(self._make_epoch_callback(epoch_callback, every_n=50))

        self._model = lgb.train(
            self.params,
            dtrain,
            num_boost_round=self.n_estimators,
            valid_sets=[dtrain, dval] if dval is not None else [dtrain],
            valid_names=["train", "val"] if dval is not None else ["train"],
            callbacks=callbacks,
        )

        return {
            "best_iteration": self._model.best_iteration or self.n_estimators,
            "best_score": self._model.best_score,
            "train_eras": n_train_eras,
            "val_eras": n_val_eras,
        }

    def predict(self, df: pd.DataFrame, feature_cols: list[str]) -> pd.Series:
        """Generate predictions."""
        if self._model is None:
            raise RuntimeError("Model not trained or loaded")

        # Predict in row chunks: converting the whole frame to LightGBM's
        # float64 input at once needs ~30x the int8 frame size on wide data.
        X = df[feature_cols]
        chunk = 200_000
        parts = [
            self._model.predict(X.iloc[start:start + chunk].to_numpy(dtype=np.float32))
            for start in range(0, len(X), chunk)
        ]
        preds = np.concatenate(parts) if parts else np.empty(0)
        return pd.Series(preds, index=df.index, name="prediction")

    def save(self, path: Path) -> None:
        """Save model and metadata."""
        if self._model is None:
            raise RuntimeError("No model to save")

        path.mkdir(parents=True, exist_ok=True)
        self._model.save_model(str(path / "model.txt"))

        meta = {
            "model_type": self.model_type,
            "params": self.params,
            "n_estimators": self.n_estimators,
            "feature_names": self._feature_names,
            "best_iteration": self._model.best_iteration,
        }
        with open(path / "meta.json", "w") as f:
            json.dump(meta, f, indent=2)

    def load(self, path: Path) -> None:
        """Load model from disk."""
        self._model = lgb.Booster(model_file=str(path / "model.txt"))

        meta_path = path / "meta.json"
        if meta_path.exists():
            with open(meta_path) as f:
                meta = json.load(f)
            self._feature_names = meta.get("feature_names", [])
            self.params = meta.get("params", self.params)
            self.n_estimators = meta.get("n_estimators", self.n_estimators)

    @property
    def model_type(self) -> str:
        return "lgbm"
