"""TabM model for Numerai — MLP with BatchEnsemble (ICLR 2025).

TabM uses a standard MLP backbone but replaces each Linear layer with a
BatchEnsemble layer: K ensemble members share one weight matrix W, but each
member k has cheap per-element scaling vectors r_k (input-side) and s_k
(output-side).  The forward pass for member k is:

    output_k = (r_k * input) @ W^T * s_k + b

All K members are processed in parallel via broadcasting.  At prediction time
the K outputs are averaged, giving ensemble-quality predictions at a fraction
of the memory/compute cost of K independent models.

Reference: Gorishniy et al., "TabM: Advancing Tabular Deep Learning with
Parameter-Efficient Ensembling", ICLR 2025.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, List, Optional

import numpy as np
import pandas as pd

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import DataLoader, TensorDataset

    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

from models.base import NumeraiModel
from config.device import resolve_device


# ---------------------------------------------------------------------------
# Network components
# ---------------------------------------------------------------------------

class _GaussianNoise(nn.Module):
    """Add Gaussian noise during training only."""

    def __init__(self, std: float = 0.05):
        super().__init__()
        self.std = std

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.training and self.std > 0:
            return x + torch.randn_like(x) * self.std
        return x


class _BatchEnsembleLinear(nn.Module):
    """Linear layer with BatchEnsemble scaling vectors.

    Stores a single shared weight matrix W (out_features, in_features) plus
    per-member scaling vectors r (K, in_features) and s (K, out_features).

    Supports two input shapes:
      - 2D (batch, in_features): first layer, broadcasts across K members
      - 3D (batch, K, in_features): subsequent layers, member-wise application

    In both cases, output is (batch, K, out_features).
    """

    def __init__(self, in_features: int, out_features: int, n_ensemble: int):
        super().__init__()
        self.in_features = in_features
        self.out_features = out_features
        self.n_ensemble = n_ensemble

        # Shared weight and bias (standard Linear parameters)
        self.weight = nn.Parameter(torch.empty(out_features, in_features))
        self.bias = nn.Parameter(torch.zeros(out_features))

        # Per-member scaling vectors
        self.r = nn.Parameter(torch.empty(n_ensemble, in_features))
        self.s = nn.Parameter(torch.empty(n_ensemble, out_features))

        self._reset_parameters()

    def _reset_parameters(self):
        # Kaiming init for shared weight (same as nn.Linear default)
        nn.init.kaiming_uniform_(self.weight, a=5 ** 0.5)
        # r and s: ones + small noise so members start near-identical
        nn.init.normal_(self.r, mean=1.0, std=0.1)
        nn.init.normal_(self.s, mean=1.0, std=0.1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Forward pass.

        Args:
            x: (batch, in_features) for first layer, or
               (batch, K, in_features) for subsequent layers

        Returns:
            (batch, K, out_features)
        """
        if x.dim() == 2:
            # First layer: x is (batch, in_features)
            # Expand to (K, batch, in_features) and apply per-member input scaling
            x_scaled = x.unsqueeze(0) * self.r.unsqueeze(1)
        else:
            # Subsequent layers: x is (batch, K, in_features)
            # Permute to (K, batch, in_features) for per-member scaling
            x_scaled = x.permute(1, 0, 2) * self.r.unsqueeze(1)

        # Shared linear: (K, batch, in_features) @ (in_features, out_features) -> (K, batch, out_features)
        out = F.linear(x_scaled, self.weight, self.bias)

        # Per-member output scaling: (K, batch, out_features)
        out = out * self.s.unsqueeze(1)

        # Permute to (batch, K, out_features)
        return out.permute(1, 0, 2)


class _TabMNetwork(nn.Module):
    """TabM: MLP backbone with BatchEnsemble layers.

    Architecture:
        Input -> GaussianNoise -> [BatchEnsembleLinear -> BatchNorm -> SiLU -> Dropout] x N
              -> BatchEnsembleLinear(out=1)

    Forward returns shape (batch, K) with K ensemble member predictions.
    """

    def __init__(
        self,
        input_dim: int,
        n_ensemble: int = 16,
        hidden_dims: Optional[List[int]] = None,
        dropout: float = 0.1,
        noise_std: float = 0.05,
    ):
        super().__init__()
        if hidden_dims is None:
            hidden_dims = [512, 512, 512]

        self.n_ensemble = n_ensemble
        self.noise = _GaussianNoise(noise_std)

        # Build BatchEnsemble MLP layers
        self.be_layers = nn.ModuleList()
        self.bn_layers = nn.ModuleList()
        self.dropouts = nn.ModuleList()

        prev_dim = input_dim
        for dim in hidden_dims:
            self.be_layers.append(
                _BatchEnsembleLinear(prev_dim, dim, n_ensemble)
            )
            self.bn_layers.append(nn.BatchNorm1d(dim))
            self.dropouts.append(nn.Dropout(dropout))
            prev_dim = dim

        # Final projection: each ensemble member -> scalar
        self.head = _BatchEnsembleLinear(prev_dim, 1, n_ensemble)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Forward pass.

        Args:
            x: (batch, input_dim)

        Returns:
            (batch, K) — one prediction per ensemble member
        """
        batch_size = x.size(0)
        K = self.n_ensemble
        x = self.noise(x)

        # x starts as (batch, input_dim) — 2D
        # After first BE layer it becomes (batch, K, hidden_dim) — 3D
        # Subsequent BE layers accept 3D input and produce 3D output
        for be_layer, bn_layer, dropout in zip(
            self.be_layers, self.bn_layers, self.dropouts
        ):
            x = be_layer(x)  # (batch, K, hidden_dim)
            hidden_dim = x.size(2)

            # BatchNorm expects (N, C): reshape (batch, K, C) -> (batch*K, C)
            x = x.reshape(batch_size * K, hidden_dim)
            x = bn_layer(x)
            x = x.reshape(batch_size, K, hidden_dim)

            x = F.silu(x)
            x = dropout(x)

        # Final head: (batch, K, hidden_dim) -> (batch, K, 1) -> (batch, K)
        out = self.head(x)  # (batch, K, 1)
        return out.squeeze(-1)


# ---------------------------------------------------------------------------
# NumeraiModel wrapper
# ---------------------------------------------------------------------------

class TabMModel(NumeraiModel):
    """TabM (MLP + BatchEnsemble) for Numerai tournament.

    BatchEnsemble provides parameter-efficient ensembling: K sub-models share
    one weight matrix but have independent cheap scaling vectors. This yields
    ensemble diversity for MMC orthogonality at ~1x the cost of a single MLP.
    """

    def __init__(
        self,
        n_ensemble: int = 16,
        hidden_dims: Optional[List[int]] = None,
        dropout: float = 0.1,
        noise_std: float = 0.05,
        learning_rate: float = 1e-3,
        weight_decay: float = 1e-4,
        n_epochs: int = 100,
        batch_size: int = 8192,
        early_stopping_rounds: int = 25,
        **kwargs,
    ):
        if not HAS_TORCH:
            raise RuntimeError("PyTorch not installed. Install with: pip install torch")

        self.n_ensemble = int(n_ensemble)
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

        self._model: Optional[_TabMNetwork] = None
        self._feature_names: List[str] = []
        self._device = resolve_device()

    # ------------------------------------------------------------------
    # Training
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
        """Train TabM with early stopping on per-era correlation."""
        self._feature_names = feature_cols
        input_dim = len(feature_cols)

        self._model = _TabMNetwork(
            input_dim=input_dim,
            n_ensemble=self.n_ensemble,
            hidden_dims=self.hidden_dims,
            dropout=self.dropout,
            noise_std=self.noise_std,
        ).to(self._device)

        n_params = sum(p.numel() for p in self._model.parameters())
        print(f"  [TabM] {n_params:,} params, K={self.n_ensemble} members, "
              f"features={input_dim}, device={self._device}")
        self._print_config()

        # ── Prepare data ──
        X_train = torch.tensor(
            train_df[feature_cols].fillna(0).values, dtype=torch.float32,
        )
        y_train = torch.tensor(
            train_df[target_col].fillna(0).values, dtype=torch.float32,
        )

        if val_df is not None:
            X_val = torch.tensor(
                val_df[feature_cols].fillna(0).values, dtype=torch.float32,
            )
            y_val = torch.tensor(
                val_df[target_col].fillna(0).values, dtype=torch.float32,
            )
            val_eras_arr = val_df[era_col].values
            val_targets_arr = val_df[target_col].fillna(0).values
        else:
            eras = sorted(train_df[era_col].unique())
            split_idx = int(len(eras) * 0.8)
            val_eras = set(eras[split_idx:])
            val_mask = train_df[era_col].isin(val_eras).values
            val_eras_arr = train_df[era_col].values[val_mask]
            val_targets_arr = train_df[target_col].fillna(0).values[val_mask]
            X_val, y_val = X_train[val_mask], y_train[val_mask]
            X_train, y_train = X_train[~val_mask], y_train[~val_mask]

        train_loader = DataLoader(
            TensorDataset(X_train, y_train),
            batch_size=self.batch_size,
            shuffle=True,
            drop_last=True,
        )
        val_loader = DataLoader(
            TensorDataset(X_val, y_val),
            batch_size=self.batch_size * 4,
            shuffle=False,
        )

        # ── Optimizer ──
        optimizer = torch.optim.AdamW(
            self._model.parameters(),
            lr=self.learning_rate,
            weight_decay=self.weight_decay,
        )
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
            optimizer, T_max=self.n_epochs, eta_min=self.learning_rate * 0.01,
        )
        criterion = nn.MSELoss()

        # ── Helper: compute per-era Spearman correlation on val set ──
        def _val_era_corr() -> float:
            """Fast per-era correlation using GPU predictions + pandas groupby."""
            self._model.eval()
            all_preds = []
            with torch.no_grad():
                for i in range(0, len(X_val), 32768):
                    batch = X_val[i:i + 32768].to(self._device)
                    out = self._model(batch).mean(dim=1).cpu().numpy()
                    all_preds.append(out)
            preds_np = np.concatenate(all_preds)
            tmp = pd.DataFrame({
                "era": val_eras_arr,
                "pred": preds_np,
                "target": val_targets_arr,
            })
            def _corr(g):
                if len(g) < 5:
                    return np.nan
                return g["pred"].rank().corr(g["target"].rank())
            era_corrs = tmp.groupby("era").apply(_corr, include_groups=False)
            return float(era_corrs.mean())

        # ── Training loop ──
        best_val_corr = -float("inf")
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

                optimizer.zero_grad()
                # Forward: (batch, K) predictions from K ensemble members
                preds = self._model(X_batch)  # (batch, K)
                # Train each ensemble member independently against the target
                # Expand target to match: (batch,) -> (batch, K)
                y_expanded = y_batch.unsqueeze(1).expand_as(preds)
                loss = criterion(preds, y_expanded)
                loss.backward()
                nn.utils.clip_grad_norm_(self._model.parameters(), max_norm=1.0)
                optimizer.step()
                train_losses.append(loss.item())

            scheduler.step()

            # ── Validate (MSE for logging) ──
            self._model.eval()
            val_loss_sum = 0.0
            val_count = 0
            with torch.no_grad():
                for X_vb, y_vb in val_loader:
                    X_vb = X_vb.to(self._device)
                    y_vb = y_vb.to(self._device)
                    vp = self._model(X_vb)  # (batch, K)
                    vp_mean = vp.mean(dim=1)  # (batch,)
                    val_loss_sum += criterion(vp_mean, y_vb).item() * len(X_vb)
                    val_count += len(X_vb)
            val_loss = val_loss_sum / val_count
            train_loss = float(np.mean(train_losses))

            # ── Per-era correlation (early stopping criterion) ──
            val_corr = _val_era_corr()

            if val_corr > best_val_corr:
                best_val_corr = val_corr
                best_epoch = epoch
                best_state = {
                    k: v.cpu().clone()
                    for k, v in self._model.state_dict().items()
                }
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
                    "val_corr": val_corr,
                })

            if epoch % 10 == 0 or epoch == self.n_epochs - 1:
                print(f"  [TabM] Epoch {epoch}: train={train_loss:.6f}, "
                      f"val={val_loss:.6f}, corr={val_corr:.6f}, "
                      f"lr={optimizer.param_groups[0]['lr']:.6f}")

            if patience_counter >= self.early_stopping_rounds:
                print(f"  [TabM] Early stopping at epoch {epoch}, "
                      f"best={best_epoch} (val_corr={best_val_corr:.6f})")
                break

        # Restore best weights
        if best_state is not None:
            self._model.load_state_dict(best_state)
        self._model.eval()

        return {
            "best_iteration": best_epoch,
            "best_score": {"val": {"corr": best_val_corr}},
            "train_eras": train_df[era_col].nunique() if val_df is not None else int(len(eras) * 0.8),
            "val_eras": val_df[era_col].nunique() if val_df is not None else len(eras) - int(len(eras) * 0.8),
        }

    def _print_config(self):
        print(f"  [TabM] Config: K={self.n_ensemble}, dims={self.hidden_dims}, "
              f"dropout={self.dropout}, wd={self.weight_decay}, "
              f"noise={self.noise_std}, bs={self.batch_size}")

    # ------------------------------------------------------------------
    # Predict
    # ------------------------------------------------------------------

    def predict(self, df: pd.DataFrame, feature_cols: List[str]) -> pd.Series:
        """Generate predictions by averaging across K ensemble members."""
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
                # Average across K ensemble members
                out = self._model(batch)  # (batch, K)
                preds.append(out.mean(dim=1).cpu().numpy())

        return pd.Series(np.concatenate(preds), index=df.index, name="prediction")

    # ------------------------------------------------------------------
    # Save / Load
    # ------------------------------------------------------------------

    def save(self, path: Path) -> None:
        """Save model weights and config."""
        if self._model is None:
            raise RuntimeError("No model to save")

        path.mkdir(parents=True, exist_ok=True)
        torch.save(self._model.state_dict(), str(path / "model.pt"))

        meta = {
            "model_type": self.model_type,
            "n_ensemble": self.n_ensemble,
            "hidden_dims": self.hidden_dims,
            "dropout": self.dropout,
            "noise_std": self.noise_std,
            "learning_rate": self.learning_rate,
            "weight_decay": self.weight_decay,
            "n_epochs": self.n_epochs,
            "batch_size": self.batch_size,
            "early_stopping_rounds": self.early_stopping_rounds,
            "feature_names": self._feature_names,
            "input_dim": len(self._feature_names),
        }
        with open(path / "meta.json", "w") as f:
            json.dump(meta, f, indent=2)

    def load(self, path: Path) -> None:
        """Load model from disk."""
        with open(path / "meta.json") as f:
            meta = json.load(f)

        self._feature_names = meta.get("feature_names", [])
        self.n_ensemble = meta.get("n_ensemble", self.n_ensemble)
        self.hidden_dims = meta.get("hidden_dims", self.hidden_dims)
        self.dropout = meta.get("dropout", self.dropout)
        self.noise_std = meta.get("noise_std", self.noise_std)

        input_dim = meta.get("input_dim", len(self._feature_names))
        self._model = _TabMNetwork(
            input_dim=input_dim,
            n_ensemble=self.n_ensemble,
            hidden_dims=self.hidden_dims,
            dropout=self.dropout,
            noise_std=self.noise_std,
        ).to(self._device)

        self._model.load_state_dict(
            torch.load(str(path / "model.pt"), map_location=self._device)
        )
        self._model.eval()

    @property
    def model_type(self) -> str:
        return "tabm"
