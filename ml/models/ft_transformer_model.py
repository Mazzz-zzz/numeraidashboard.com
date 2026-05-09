"""FT-Transformer model for Numerai.

Feature Tokenizer + Transformer (Gorishniy et al., 2021) tokenizes each numerical
feature into an embedding, prepends a [CLS] token, and applies standard Transformer
self-attention.  On tabular benchmarks it consistently outranks other DL methods
(average rank 1.8 vs TabNet 7.5, NODE 3.9).

For Numerai MMC specifically, attention over features produces decision boundaries
fundamentally different from the tree-dominated meta model, giving inherently
orthogonal predictions.

Implementation is self-contained (no rtdl dependency) so it runs in the Modal
container with only torch installed.
"""

from __future__ import annotations

import json
import math
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


# ---------------------------------------------------------------------------
# Network components
# ---------------------------------------------------------------------------

class _GaussianNoise(nn.Module):
    """Additive Gaussian noise during training only."""

    def __init__(self, std: float = 0.05):
        super().__init__()
        self.std = std

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.training and self.std > 0:
            return x + torch.randn_like(x) * self.std
        return x


class _NumericalTokenizer(nn.Module):
    """Project each scalar feature into a d-dimensional embedding."""

    def __init__(self, n_features: int, d_token: int):
        super().__init__()
        self.weight = nn.Parameter(torch.empty(n_features, d_token))
        self.bias = nn.Parameter(torch.empty(n_features, d_token))
        nn.init.kaiming_uniform_(self.weight, a=math.sqrt(5))
        nn.init.zeros_(self.bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, n_features) -> (batch, n_features, d_token)
        return x.unsqueeze(-1) * self.weight + self.bias


class _FTTransformerBlock(nn.Module):
    """Pre-norm Transformer encoder block with memory-efficient attention."""

    def __init__(self, d_model: int, n_heads: int, d_ff: int,
                 attn_dropout: float, ff_dropout: float):
        super().__init__()
        self.n_heads = n_heads
        self.d_head = d_model // n_heads
        self.norm1 = nn.LayerNorm(d_model)
        self.qkv = nn.Linear(d_model, 3 * d_model)
        self.attn_out = nn.Linear(d_model, d_model)
        self.attn_dropout = attn_dropout
        self.norm2 = nn.LayerNorm(d_model)
        self.ff = nn.Sequential(
            nn.Linear(d_model, d_ff),
            nn.GELU(),
            nn.Dropout(ff_dropout),
            nn.Linear(d_ff, d_model),
            nn.Dropout(ff_dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, S, D = x.shape
        # Self-attention with pre-norm — uses F.scaled_dot_product_attention
        # which dispatches to Flash Attention on CUDA (O(N) memory vs O(N^2))
        h = self.norm1(x)
        qkv = self.qkv(h).reshape(B, S, 3, self.n_heads, self.d_head)
        q, k, v = qkv.permute(2, 0, 3, 1, 4).unbind(0)  # each: (B, heads, S, d_head)
        drop_p = self.attn_dropout if self.training else 0.0
        attn = F.scaled_dot_product_attention(q, k, v, dropout_p=drop_p)
        attn = attn.transpose(1, 2).reshape(B, S, D)
        x = x + self.attn_out(attn)
        # Feed-forward with pre-norm
        x = x + self.ff(self.norm2(x))
        return x


class _FTTransformerNetwork(nn.Module):
    """Full FT-Transformer: tokenize -> [CLS] + features -> Transformer -> head."""

    def __init__(
        self,
        n_features: int,
        d_token: int = 192,
        n_blocks: int = 3,
        n_heads: int = 8,
        d_ff_multiplier: float = 4 / 3,
        attn_dropout: float = 0.2,
        ff_dropout: float = 0.1,
        residual_dropout: float = 0.0,
        noise_std: float = 0.05,
    ):
        super().__init__()
        self.noise = _GaussianNoise(noise_std)

        # Feature tokenizer
        self.tokenizer = _NumericalTokenizer(n_features, d_token)

        # Learnable [CLS] token
        self.cls_token = nn.Parameter(torch.empty(1, 1, d_token))
        nn.init.normal_(self.cls_token, std=0.02)

        # Transformer blocks
        d_ff = int(d_token * d_ff_multiplier)
        # Round d_ff up to nearest multiple of 8 for GPU efficiency
        d_ff = ((d_ff + 7) // 8) * 8
        self.blocks = nn.ModuleList([
            _FTTransformerBlock(d_token, n_heads, d_ff, attn_dropout, ff_dropout)
            for _ in range(n_blocks)
        ])

        self.final_norm = nn.LayerNorm(d_token)
        self.head = nn.Linear(d_token, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, n_features)
        x = self.noise(x)

        # Tokenize: (batch, n_features) -> (batch, n_features, d_token)
        tokens = self.tokenizer(x)

        # Prepend [CLS]: (batch, 1 + n_features, d_token)
        cls = self.cls_token.expand(tokens.size(0), -1, -1)
        tokens = torch.cat([cls, tokens], dim=1)

        # Transformer blocks
        for block in self.blocks:
            tokens = block(tokens)

        # Extract [CLS] representation
        cls_out = self.final_norm(tokens[:, 0])
        return self.head(cls_out).squeeze(-1)


# ---------------------------------------------------------------------------
# NumeraiModel wrapper
# ---------------------------------------------------------------------------

class FTTransformerModel(NumeraiModel):
    """FT-Transformer for Numerai tournament.

    Self-attention over feature embeddings captures cross-feature interactions
    that tree models miss, producing orthogonal predictions for MMC.
    """

    def __init__(
        self,
        d_token: int = 192,
        n_blocks: int = 3,
        n_heads: int = 8,
        attn_dropout: float = 0.2,
        ff_dropout: float = 0.1,
        noise_std: float = 0.05,
        learning_rate: float = 1e-4,
        weight_decay: float = 1e-3,
        n_epochs: int = 100,
        batch_size: int = 1024,
        early_stopping_rounds: int = 15,
        **kwargs,
    ):
        if not HAS_TORCH:
            raise RuntimeError("PyTorch not installed. Install with: pip install torch")

        self.d_token = d_token
        self.n_blocks = n_blocks
        self.n_heads = n_heads
        self.attn_dropout = attn_dropout
        self.ff_dropout = ff_dropout
        self.noise_std = noise_std
        self.learning_rate = learning_rate
        self.weight_decay = weight_decay
        self.n_epochs = n_epochs
        self.batch_size = batch_size
        self.early_stopping_rounds = early_stopping_rounds
        self._model: Optional[_FTTransformerNetwork] = None
        self._feature_names: List[str] = []
        self._device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

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
        """Train FT-Transformer with early stopping on validation loss."""
        self._feature_names = feature_cols
        n_features = len(feature_cols)

        self._model = _FTTransformerNetwork(
            n_features=n_features,
            d_token=self.d_token,
            n_blocks=self.n_blocks,
            n_heads=self.n_heads,
            attn_dropout=self.attn_dropout,
            ff_dropout=self.ff_dropout,
            noise_std=self.noise_std,
        ).to(self._device)

        n_params = sum(p.numel() for p in self._model.parameters())
        print(f"  [FT-T] {n_params:,} parameters, {n_features} features, "
              f"d_token={self.d_token}, blocks={self.n_blocks}, device={self._device}")

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
        else:
            eras = sorted(train_df[era_col].unique())
            split_idx = int(len(eras) * 0.8)
            val_eras = set(eras[split_idx:])
            val_mask = train_df[era_col].isin(val_eras)
            train_mask = ~val_mask
            X_val = X_train[val_mask.values]
            y_val = y_train[val_mask.values]
            X_train = X_train[train_mask.values]
            y_train = y_train[train_mask.values]

        train_loader = DataLoader(
            TensorDataset(X_train, y_train),
            batch_size=self.batch_size,
            shuffle=True,
            drop_last=True,
        )
        val_loader = DataLoader(
            TensorDataset(X_val, y_val),
            batch_size=self.batch_size * 2,
            shuffle=False,
        )

        # ── Optimizer ──
        # Separate weight-decay groups: no decay for biases & layer norms
        no_decay = {"bias", "LayerNorm.weight", "LayerNorm.bias",
                     "final_norm.weight", "final_norm.bias"}
        param_groups = [
            {
                "params": [p for n, p in self._model.named_parameters()
                           if not any(nd in n for nd in no_decay)],
                "weight_decay": self.weight_decay,
            },
            {
                "params": [p for n, p in self._model.named_parameters()
                           if any(nd in n for nd in no_decay)],
                "weight_decay": 0.0,
            },
        ]
        optimizer = torch.optim.AdamW(param_groups, lr=self.learning_rate)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
            optimizer, T_max=self.n_epochs, eta_min=self.learning_rate * 0.01,
        )
        criterion = nn.MSELoss()

        # ── Training loop ──
        best_val_loss = float("inf")
        best_epoch = 0
        best_state = None
        patience_counter = 0

        for epoch in range(self.n_epochs):
            self._model.train()
            train_losses = []
            for X_b, y_b in train_loader:
                X_b = X_b.to(self._device)
                y_b = y_b.to(self._device)
                optimizer.zero_grad()
                preds = self._model(X_b)
                loss = criterion(preds, y_b)
                loss.backward()
                # Gradient clipping for transformer stability
                nn.utils.clip_grad_norm_(self._model.parameters(), max_norm=1.0)
                optimizer.step()
                train_losses.append(loss.item())

            scheduler.step()

            # Validate
            self._model.eval()
            val_loss_sum = 0.0
            val_count = 0
            with torch.no_grad():
                for X_vb, y_vb in val_loader:
                    X_vb = X_vb.to(self._device)
                    y_vb = y_vb.to(self._device)
                    vp = self._model(X_vb)
                    val_loss_sum += criterion(vp, y_vb).item() * len(X_vb)
                    val_count += len(X_vb)
            val_loss = val_loss_sum / val_count
            train_loss = float(np.mean(train_losses))

            # Early stopping
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

            if epoch % 5 == 0:
                print(f"  [FT-T] Epoch {epoch}: train={train_loss:.6f}, "
                      f"val={val_loss:.6f}, lr={scheduler.get_last_lr()[0]:.2e}")

            if patience_counter >= self.early_stopping_rounds:
                print(f"  [FT-T] Early stopping at epoch {epoch}, "
                      f"best={best_epoch} (val_loss={best_val_loss:.6f})")
                break

        # Restore best
        if best_state is not None:
            self._model.load_state_dict(best_state)
        self._model.eval()

        return {
            "best_iteration": best_epoch,
            "best_score": {"val": {"mse": best_val_loss}},
            "train_eras": train_df[era_col].nunique() if val_df is not None else int(len(eras) * 0.8),
            "val_eras": val_df[era_col].nunique() if val_df is not None else len(eras) - int(len(eras) * 0.8),
        }

    def predict(self, df: pd.DataFrame, feature_cols: List[str]) -> pd.Series:
        """Generate predictions in batches."""
        if self._model is None:
            raise RuntimeError("Model not trained or loaded")

        self._model.eval()
        X = torch.tensor(
            df[feature_cols].fillna(0).values, dtype=torch.float32,
        )

        batch_size = 16384
        preds = []
        with torch.no_grad():
            for i in range(0, len(X), batch_size):
                batch = X[i:i + batch_size].to(self._device)
                preds.append(self._model(batch).cpu().numpy())

        return pd.Series(np.concatenate(preds), index=df.index, name="prediction")

    def save(self, path: Path) -> None:
        """Save model weights and config."""
        if self._model is None:
            raise RuntimeError("No model to save")

        path.mkdir(parents=True, exist_ok=True)
        torch.save(self._model.state_dict(), str(path / "model.pt"))

        meta = {
            "model_type": self.model_type,
            "d_token": self.d_token,
            "n_blocks": self.n_blocks,
            "n_heads": self.n_heads,
            "attn_dropout": self.attn_dropout,
            "ff_dropout": self.ff_dropout,
            "noise_std": self.noise_std,
            "learning_rate": self.learning_rate,
            "weight_decay": self.weight_decay,
            "n_epochs": self.n_epochs,
            "batch_size": self.batch_size,
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
        self.d_token = meta.get("d_token", self.d_token)
        self.n_blocks = meta.get("n_blocks", self.n_blocks)
        self.n_heads = meta.get("n_heads", self.n_heads)
        self.attn_dropout = meta.get("attn_dropout", self.attn_dropout)
        self.ff_dropout = meta.get("ff_dropout", self.ff_dropout)
        self.noise_std = meta.get("noise_std", self.noise_std)

        n_features = meta.get("input_dim", len(self._feature_names))
        self._model = _FTTransformerNetwork(
            n_features=n_features,
            d_token=self.d_token,
            n_blocks=self.n_blocks,
            n_heads=self.n_heads,
            attn_dropout=self.attn_dropout,
            ff_dropout=self.ff_dropout,
            noise_std=self.noise_std,
        ).to(self._device)

        self._model.load_state_dict(
            torch.load(str(path / "model.pt"), map_location=self._device)
        )
        self._model.eval()

    @property
    def model_type(self) -> str:
        return "ft_transformer"
