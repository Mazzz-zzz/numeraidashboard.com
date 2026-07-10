"""MLP model with regularization cocktail for Numerai.

Architecture: Input -> GaussianNoise -> [Linear -> BatchNorm -> SiLU -> Dropout] x N -> Linear(out)

Configurable A/B features (all backward-compatible defaults = off/current):
  - dropout:        0.1 (default) -> 0.3 for heavy regularization
  - weight_decay:   1e-4 (default) -> 1e-2 for strong L2
  - mixup_alpha:    0.0 (off) -> 0.4 to enable Mixup augmentation
  - swa:            false (off) -> true for Stochastic Weight Averaging
  - warmup_epochs:  0 (off) -> 5 for linear LR warmup
  - hidden_dims:    [512,512,512] (default) -> [1024,512] for wider/shallower
  - multi_head:     false (off) -> true for multi-target output heads
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np
import pandas as pd

try:
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, TensorDataset
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

from models.base import NumeraiModel
from config.device import resolve_device


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

class _GaussianNoise(nn.Module):
    """Add Gaussian noise during training only."""

    def __init__(self, std: float = 0.05):
        super().__init__()
        self.std = std

    def forward(self, x):
        if self.training and self.std > 0:
            return x + torch.randn_like(x) * self.std
        return x


class _MLPNetwork(nn.Module):
    """MLP with optional multi-head output for multi-target training."""

    def __init__(
        self,
        input_dim: int,
        hidden_dims: List[int] = None,
        dropout: float = 0.1,
        noise_std: float = 0.05,
        n_targets: int = 1,
    ):
        super().__init__()
        if hidden_dims is None:
            hidden_dims = [512, 512, 512]

        self.noise = _GaussianNoise(noise_std)
        self.n_targets = n_targets

        layers = []
        prev_dim = input_dim
        for dim in hidden_dims:
            layers.extend([
                nn.Linear(prev_dim, dim),
                nn.BatchNorm1d(dim),
                nn.SiLU(),
                nn.Dropout(dropout),
            ])
            prev_dim = dim
        self.backbone = nn.Sequential(*layers)

        # Multi-head: one linear output per target
        if n_targets > 1:
            self.heads = nn.ModuleList([nn.Linear(prev_dim, 1) for _ in range(n_targets)])
        else:
            self.head = nn.Linear(prev_dim, 1)

    def forward(self, x, target_idx: Optional[int] = None):
        x = self.noise(x)
        h = self.backbone(x)
        if self.n_targets > 1:
            if target_idx is not None:
                return self.heads[target_idx](h).squeeze(-1)
            # Return all heads stacked: (batch, n_targets)
            return torch.cat([head(h) for head in self.heads], dim=-1)
        return self.head(h).squeeze(-1)


# ---------------------------------------------------------------------------
# NumeraiModel wrapper
# ---------------------------------------------------------------------------

class MLPModel(NumeraiModel):
    """MLP with configurable regularization cocktail for Numerai tournament."""

    def __init__(
        self,
        hidden_dims: List[int] = None,
        dropout: float = 0.1,
        noise_std: float = 0.05,
        learning_rate: float = 1e-3,
        weight_decay: float = 1e-4,
        n_epochs: int = 100,
        batch_size: int = 8192,
        early_stopping_rounds: int = 10,
        # ── A/B testable features ──
        mixup_alpha: float = 0.0,
        swa: bool = False,
        swa_start_frac: float = 0.5,
        warmup_epochs: int = 0,
        multi_head: bool = False,
        **kwargs,
    ):
        if not HAS_TORCH:
            raise RuntimeError("PyTorch not installed. Install with: pip install torch")

        # Parse hidden_dims from comma-separated string if needed (from CLI --extra)
        if isinstance(hidden_dims, str):
            hidden_dims = [int(d) for d in hidden_dims.split(",")]
        self.hidden_dims = hidden_dims or [512, 512, 512]
        self.dropout = float(dropout)
        self.noise_std = float(noise_std)
        self.learning_rate = float(learning_rate)
        self.weight_decay = float(weight_decay)
        self.n_epochs = int(n_epochs)
        self.batch_size = int(batch_size)
        self.early_stopping_rounds = int(early_stopping_rounds)
        # A/B features
        self.mixup_alpha = float(mixup_alpha)
        self.swa = str(swa).lower() in ("true", "1", "yes") if isinstance(swa, str) else bool(swa)
        self.swa_start_frac = float(swa_start_frac)
        self.warmup_epochs = int(warmup_epochs)
        self.multi_head = str(multi_head).lower() in ("true", "1", "yes") if isinstance(multi_head, str) else bool(multi_head)

        self._model: Optional[_MLPNetwork] = None
        self._feature_names: List[str] = []
        self._target_names: List[str] = []
        self._device = resolve_device()

    # ------------------------------------------------------------------
    # Multi-head training: all targets in one model
    # ------------------------------------------------------------------

    def fit_multi_head(
        self,
        train_df: pd.DataFrame,
        feature_cols: List[str],
        target_cols: List[str],
        era_col: str = "era",
        epoch_callback: Optional[Callable[[dict], None]] = None,
        val_df: Optional[pd.DataFrame] = None,
    ) -> dict:
        """Train a single MLP with one output head per target."""
        self._feature_names = feature_cols
        self._target_names = target_cols
        n_targets = len(target_cols)

        self._model = _MLPNetwork(
            input_dim=len(feature_cols),
            hidden_dims=self.hidden_dims,
            dropout=self.dropout,
            noise_std=self.noise_std,
            n_targets=n_targets,
        ).to(self._device)

        n_params = sum(p.numel() for p in self._model.parameters())
        print(f"  [MLP-MH] {n_params:,} params, {n_targets} heads, "
              f"features={len(feature_cols)}, device={self._device}")
        self._print_config()

        # Prepare data — stack all targets into a single tensor
        X_train = torch.tensor(
            train_df[feature_cols].fillna(0).values, dtype=torch.float32,
        )
        y_train = torch.tensor(
            train_df[target_cols].fillna(0).values, dtype=torch.float32,
        )

        if val_df is not None:
            X_val = torch.tensor(
                val_df[feature_cols].fillna(0).values, dtype=torch.float32,
            )
            y_val = torch.tensor(
                val_df[target_cols].fillna(0).values, dtype=torch.float32,
            )
        else:
            eras = sorted(train_df[era_col].unique())
            split_idx = int(len(eras) * 0.8)
            val_eras = set(eras[split_idx:])
            val_mask = train_df[era_col].isin(val_eras).values
            X_val, y_val = X_train[val_mask], y_train[val_mask]
            X_train, y_train = X_train[~val_mask], y_train[~val_mask]

        return self._train_loop(X_train, y_train, X_val, y_val,
                                epoch_callback, train_df, val_df, era_col,
                                multi_target=True)

    # ------------------------------------------------------------------
    # Standard single-target training
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
        """Train MLP with early stopping on validation loss."""
        self._feature_names = feature_cols
        self._target_names = [target_col]
        input_dim = len(feature_cols)

        self._model = _MLPNetwork(
            input_dim=input_dim,
            hidden_dims=self.hidden_dims,
            dropout=self.dropout,
            noise_std=self.noise_std,
            n_targets=1,
        ).to(self._device)

        n_params = sum(p.numel() for p in self._model.parameters())
        print(f"  [MLP] {n_params:,} params, features={input_dim}, device={self._device}")
        self._print_config()

        X_train = torch.tensor(
            train_df[feature_cols].fillna(0).values, dtype=torch.float32,
        )
        y_train = torch.tensor(
            train_df[target_col].fillna(0).values, dtype=torch.float32,
        ).unsqueeze(-1)  # (N, 1) to match multi-target shape

        if val_df is not None:
            X_val = torch.tensor(
                val_df[feature_cols].fillna(0).values, dtype=torch.float32,
            )
            y_val = torch.tensor(
                val_df[target_col].fillna(0).values, dtype=torch.float32,
            ).unsqueeze(-1)
        else:
            eras = sorted(train_df[era_col].unique())
            split_idx = int(len(eras) * 0.8)
            val_eras = set(eras[split_idx:])
            val_mask = train_df[era_col].isin(val_eras).values
            X_val, y_val = X_train[val_mask], y_train[val_mask]
            X_train, y_train = X_train[~val_mask], y_train[~val_mask]

        return self._train_loop(X_train, y_train, X_val, y_val,
                                epoch_callback, train_df, val_df, era_col,
                                multi_target=False)

    # ------------------------------------------------------------------
    # Shared training loop
    # ------------------------------------------------------------------

    def _print_config(self):
        flags = []
        if self.mixup_alpha > 0:
            flags.append(f"mixup={self.mixup_alpha}")
        if self.swa:
            flags.append(f"swa@{self.swa_start_frac:.0%}")
        if self.warmup_epochs > 0:
            flags.append(f"warmup={self.warmup_epochs}ep")
        flags.append(f"dropout={self.dropout}")
        flags.append(f"wd={self.weight_decay}")
        flags.append(f"dims={self.hidden_dims}")
        print(f"  [MLP] Config: {', '.join(flags)}")

    def _train_loop(
        self,
        X_train: "torch.Tensor",
        y_train: "torch.Tensor",
        X_val: "torch.Tensor",
        y_val: "torch.Tensor",
        epoch_callback,
        train_df,
        val_df,
        era_col: str,
        multi_target: bool,
    ) -> dict:
        train_ds = TensorDataset(X_train, y_train)
        train_loader = DataLoader(
            train_ds, batch_size=self.batch_size, shuffle=True, drop_last=True,
        )
        val_ds = TensorDataset(X_val, y_val)
        val_loader = DataLoader(val_ds, batch_size=self.batch_size * 4, shuffle=False)

        # Optimizer
        optimizer = torch.optim.AdamW(
            self._model.parameters(),
            lr=self.learning_rate,
            weight_decay=self.weight_decay,
        )

        # Scheduler: cosine with optional warmup
        if self.warmup_epochs > 0:
            warmup_sched = torch.optim.lr_scheduler.LinearLR(
                optimizer, start_factor=0.01, total_iters=self.warmup_epochs,
            )
            cosine_sched = torch.optim.lr_scheduler.CosineAnnealingLR(
                optimizer, T_max=max(self.n_epochs - self.warmup_epochs, 1),
                eta_min=self.learning_rate * 0.01,
            )
            scheduler = torch.optim.lr_scheduler.SequentialLR(
                optimizer, [warmup_sched, cosine_sched],
                milestones=[self.warmup_epochs],
            )
        else:
            scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
                optimizer, T_max=self.n_epochs, eta_min=self.learning_rate * 0.01,
            )

        # SWA setup
        swa_model = None
        swa_scheduler = None
        swa_start = int(self.n_epochs * self.swa_start_frac)
        if self.swa:
            from torch.optim.swa_utils import AveragedModel, SWALR
            swa_model = AveragedModel(self._model)
            swa_scheduler = SWALR(optimizer, swa_lr=self.learning_rate * 0.5)

        criterion = nn.MSELoss()

        best_val_loss = float("inf")
        best_epoch = 0
        best_state = None
        patience_counter = 0

        for epoch in range(self.n_epochs):
            # ── Train ──
            self._model.train()
            train_losses = []
            for X_batch, y_batch in train_loader:
                X_batch = X_batch.to(self._device)
                y_batch = y_batch.to(self._device)

                # Mixup augmentation
                if self.mixup_alpha > 0:
                    X_batch, y_batch = self._mixup(X_batch, y_batch)

                optimizer.zero_grad()
                if multi_target:
                    preds = self._model(X_batch)  # (batch, n_targets)
                    loss = criterion(preds, y_batch)
                else:
                    preds = self._model(X_batch, target_idx=0)
                    loss = criterion(preds, y_batch.squeeze(-1))
                loss.backward()
                nn.utils.clip_grad_norm_(self._model.parameters(), max_norm=1.0)
                optimizer.step()
                train_losses.append(loss.item())

            # Scheduler step
            if self.swa and epoch >= swa_start:
                swa_model.update_parameters(self._model)
                swa_scheduler.step()
            else:
                scheduler.step()

            # ── Validate ──
            self._model.eval()
            val_loss_sum = 0.0
            val_count = 0
            with torch.no_grad():
                for X_vb, y_vb in val_loader:
                    X_vb = X_vb.to(self._device)
                    y_vb = y_vb.to(self._device)
                    if multi_target:
                        vp = self._model(X_vb)
                        val_loss_sum += criterion(vp, y_vb).item() * len(X_vb)
                    else:
                        vp = self._model(X_vb, target_idx=0)
                        val_loss_sum += criterion(vp, y_vb.squeeze(-1)).item() * len(X_vb)
                    val_count += len(X_vb)
            val_loss = val_loss_sum / val_count
            train_loss = float(np.mean(train_losses))

            # Early stopping (skip during SWA phase — SWA manages its own convergence)
            if not (self.swa and epoch >= swa_start):
                if val_loss < best_val_loss:
                    best_val_loss = val_loss
                    best_epoch = epoch
                    best_state = {k: v.cpu().clone() for k, v in self._model.state_dict().items()}
                    patience_counter = 0
                else:
                    patience_counter += 1

            if epoch_callback:
                epoch_callback({
                    "epoch": epoch,
                    "train_loss": train_loss,
                    "val_loss": val_loss,
                    "train_l2": train_loss,
                    "val_l2": val_loss,
                })

            if epoch % 10 == 0 or epoch == self.n_epochs - 1:
                swa_tag = " [SWA]" if self.swa and epoch >= swa_start else ""
                print(f"  [MLP] Epoch {epoch}: train={train_loss:.6f}, "
                      f"val={val_loss:.6f}, lr={optimizer.param_groups[0]['lr']:.6f}{swa_tag}")

            if patience_counter >= self.early_stopping_rounds:
                print(f"  [MLP] Early stopping at epoch {epoch}, "
                      f"best={best_epoch} (val_loss={best_val_loss:.6f})")
                break

        # Restore best weights (or use SWA averaged model)
        if self.swa and swa_model is not None:
            # Update BN stats for the averaged model
            torch.optim.swa_utils.update_bn(train_loader, swa_model, device=self._device)
            self._model.load_state_dict(
                {k.replace("module.", ""): v for k, v in swa_model.state_dict().items()
                 if k.startswith("module.")},
            )
            print(f"  [MLP] Using SWA averaged weights (avg from epoch {swa_start})")
        elif best_state is not None:
            self._model.load_state_dict(best_state)
        self._model.eval()

        eras_info = self._compute_era_counts(train_df, val_df, era_col)
        return {
            "best_iteration": best_epoch,
            "best_score": {"val": {"mse": best_val_loss}},
            **eras_info,
        }

    def _mixup(self, x: "torch.Tensor", y: "torch.Tensor"):
        """Mixup augmentation: interpolate random pairs within the batch."""
        lam = np.random.beta(self.mixup_alpha, self.mixup_alpha)
        idx = torch.randperm(x.size(0), device=x.device)
        x_mixed = lam * x + (1 - lam) * x[idx]
        y_mixed = lam * y + (1 - lam) * y[idx]
        return x_mixed, y_mixed

    @staticmethod
    def _compute_era_counts(train_df, val_df, era_col):
        if val_df is not None:
            return {
                "train_eras": train_df[era_col].nunique(),
                "val_eras": val_df[era_col].nunique(),
            }
        return {"train_eras": 0, "val_eras": 0}

    # ------------------------------------------------------------------
    # Predict
    # ------------------------------------------------------------------

    def predict(self, df: pd.DataFrame, feature_cols: List[str],
                target_idx: int = 0) -> pd.Series:
        """Generate predictions (uses first head for multi-head models)."""
        if self._model is None:
            raise RuntimeError("Model not trained or loaded")

        self._model.eval()
        X = torch.tensor(
            df[feature_cols].fillna(0).values, dtype=torch.float32,
        )

        batch_size = 32768
        preds = []
        with torch.no_grad():
            for i in range(0, len(X), batch_size):
                batch = X[i:i + batch_size].to(self._device)
                preds.append(self._model(batch, target_idx=target_idx).cpu().numpy())

        return pd.Series(np.concatenate(preds), index=df.index, name="prediction")

    def predict_all_heads(self, df: pd.DataFrame, feature_cols: List[str]) -> Dict[str, pd.Series]:
        """Predict from all heads (multi-head mode). Returns {target_name: predictions}."""
        if self._model is None or self._model.n_targets <= 1:
            raise RuntimeError("Not a multi-head model")

        results = {}
        for i, name in enumerate(self._target_names):
            results[name] = self.predict(df, feature_cols, target_idx=i)
        return results

    # ------------------------------------------------------------------
    # Save / Load
    # ------------------------------------------------------------------

    def save(self, path: Path) -> None:
        if self._model is None:
            raise RuntimeError("No model to save")

        path.mkdir(parents=True, exist_ok=True)
        torch.save(self._model.state_dict(), str(path / "model.pt"))

        meta = {
            "model_type": self.model_type,
            "hidden_dims": self.hidden_dims,
            "dropout": self.dropout,
            "noise_std": self.noise_std,
            "learning_rate": self.learning_rate,
            "weight_decay": self.weight_decay,
            "n_epochs": self.n_epochs,
            "batch_size": self.batch_size,
            "feature_names": self._feature_names,
            "target_names": self._target_names,
            "input_dim": len(self._feature_names),
            "n_targets": self._model.n_targets,
            "mixup_alpha": self.mixup_alpha,
            "swa": self.swa,
            "warmup_epochs": self.warmup_epochs,
            "multi_head": self.multi_head,
        }
        with open(path / "meta.json", "w") as f:
            json.dump(meta, f, indent=2)

    def load(self, path: Path) -> None:
        with open(path / "meta.json") as f:
            meta = json.load(f)

        self._feature_names = meta.get("feature_names", [])
        self._target_names = meta.get("target_names", [])
        self.hidden_dims = meta.get("hidden_dims", self.hidden_dims)
        self.dropout = meta.get("dropout", self.dropout)
        self.noise_std = meta.get("noise_std", self.noise_std)

        input_dim = meta.get("input_dim", len(self._feature_names))
        n_targets = meta.get("n_targets", 1)
        self._model = _MLPNetwork(
            input_dim=input_dim,
            hidden_dims=self.hidden_dims,
            dropout=self.dropout,
            noise_std=self.noise_std,
            n_targets=n_targets,
        ).to(self._device)

        self._model.load_state_dict(
            torch.load(str(path / "model.pt"), map_location=self._device)
        )
        self._model.eval()

    @property
    def model_type(self) -> str:
        return "mlp"
