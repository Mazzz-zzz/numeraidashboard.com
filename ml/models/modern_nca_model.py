"""ModernNCA (ICLR 2025) retrieval-based model for Numerai.

ModernNCA learns a deep embedding space and predicts by distance-weighted
averaging of neighbor labels -- a differentiable KNN.  During training it uses
in-batch neighbors (O(batch^2) distances), and at prediction time it retrieves
the K nearest neighbors from a stored reference set of training embeddings.

Architecture:
    Input -> GaussianNoise -> [Linear -> BatchNorm -> SiLU -> Dropout] x N
          -> Linear(d_embedding)

The retrieval mechanism produces predictions fundamentally different from both
tree ensembles and standard MLPs, giving orthogonal signal for MMC.
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
    """Additive Gaussian noise during training only."""

    def __init__(self, std: float = 0.05):
        super().__init__()
        self.std = std

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.training and self.std > 0:
            return x + torch.randn_like(x) * self.std
        return x


class _ModernNCANetwork(nn.Module):
    """Encoder that maps raw features to an embedding space.

    Input -> GaussianNoise -> [Linear -> BatchNorm -> SiLU -> Dropout] x N
          -> Linear(d_embedding)

    Also holds a learnable log-temperature that controls softness of
    distance weighting.
    """

    def __init__(
        self,
        input_dim: int,
        hidden_dims: List[int] = None,
        d_embedding: int = 128,
        dropout: float = 0.1,
        noise_std: float = 0.05,
    ):
        super().__init__()
        if hidden_dims is None:
            hidden_dims = [512, 512]

        self.noise = _GaussianNoise(noise_std)

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
        layers.append(nn.Linear(prev_dim, d_embedding))
        self.encoder = nn.Sequential(*layers)

        # Learnable temperature: exp(log_temperature) controls distance softness
        self.log_temperature = nn.Parameter(torch.zeros(1))

    @property
    def temperature(self) -> torch.Tensor:
        return self.log_temperature.exp()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Encode inputs to embedding space. Returns L2-normalized (batch, d_embedding).

        L2 normalization bounds squared distances to [0, 4], keeping the
        softmax numerically stable and making the learned temperature
        scale-invariant.
        """
        x = self.noise(x)
        emb = self.encoder(x)
        return F.normalize(emb, p=2, dim=-1)

    def in_batch_predict(
        self, x: torch.Tensor, labels: torch.Tensor,
    ) -> torch.Tensor:
        """Predict using in-batch neighbors (for training).

        For each sample i, compute squared L2 distances to all other samples
        in the batch, apply softmax(-dist / temperature), and return the
        weighted average of neighbor labels (excluding self).

        Args:
            x: Raw features (batch, input_dim).
            labels: Target values (batch,).

        Returns:
            Predictions (batch,).
        """
        embeddings = self.forward(x)  # (B, D)

        # Squared L2 distance matrix: (B, B)
        dists = torch.cdist(embeddings, embeddings, p=2).pow(2)

        # Compute logits = -dist / temperature, then mask self-connections
        # We mask AFTER scaling to avoid gradient issues from inf/temp
        logits = -dists / self.temperature  # (B, B)
        mask = torch.eye(dists.size(0), device=dists.device, dtype=torch.bool)
        logits = logits.masked_fill(mask, float("-inf"))

        # Softmax weights: closer neighbors get higher weight
        weights = F.softmax(logits, dim=-1)  # (B, B)

        # Weighted average of neighbor labels
        preds = weights @ labels.unsqueeze(-1)  # (B, 1)
        return preds.squeeze(-1)  # (B,)


# ---------------------------------------------------------------------------
# NumeraiModel wrapper
# ---------------------------------------------------------------------------

class ModernNCAModel(NumeraiModel):
    """ModernNCA retrieval-based model for Numerai tournament.

    Learns a deep embedding space where prediction is done by distance-weighted
    averaging of neighbor labels -- a differentiable KNN that produces
    orthogonal predictions for MMC.
    """

    # Maximum number of reference points to store for prediction
    MAX_REFERENCE_SIZE = 100_000

    def __init__(
        self,
        hidden_dims: List[int] = None,
        d_embedding: int = 128,
        n_neighbors: int = 64,
        dropout: float = 0.1,
        noise_std: float = 0.05,
        learning_rate: float = 1e-3,
        weight_decay: float = 1e-4,
        n_epochs: int = 100,
        batch_size: int = 4096,
        early_stopping_rounds: int = 15,
        **kwargs,
    ):
        if not HAS_TORCH:
            raise RuntimeError("PyTorch not installed. Install with: pip install torch")

        # Parse hidden_dims from comma-separated string if needed (from CLI --extra)
        if isinstance(hidden_dims, str):
            hidden_dims = [int(d) for d in hidden_dims.split(",")]
        self.hidden_dims = hidden_dims or [512, 512]
        self.d_embedding = int(d_embedding)
        self.n_neighbors = int(n_neighbors)
        self.dropout = float(dropout)
        self.noise_std = float(noise_std)
        self.learning_rate = float(learning_rate)
        self.weight_decay = float(weight_decay)
        self.n_epochs = int(n_epochs)
        self.batch_size = int(batch_size)
        self.early_stopping_rounds = int(early_stopping_rounds)

        self._model: Optional[_ModernNCANetwork] = None
        self._feature_names: List[str] = []
        self._device = resolve_device()

        # Reference store for prediction-time KNN
        self._reference_embeddings: Optional[torch.Tensor] = None  # (N_ref, D)
        self._reference_labels: Optional[torch.Tensor] = None  # (N_ref,)

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
        """Train ModernNCA with in-batch neighbor prediction and early stopping."""
        self._feature_names = feature_cols
        input_dim = len(feature_cols)

        self._model = _ModernNCANetwork(
            input_dim=input_dim,
            hidden_dims=self.hidden_dims,
            d_embedding=self.d_embedding,
            dropout=self.dropout,
            noise_std=self.noise_std,
        ).to(self._device)

        n_params = sum(p.numel() for p in self._model.parameters())
        print(f"  [MNCA] {n_params:,} params, features={input_dim}, "
              f"d_embedding={self.d_embedding}, device={self._device}")
        print(f"  [MNCA] Config: dims={self.hidden_dims}, dropout={self.dropout}, "
              f"wd={self.weight_decay}, K={self.n_neighbors}, "
              f"batch={self.batch_size}")

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
            val_mask = train_df[era_col].isin(val_eras).values
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
            batch_size=self.batch_size,
            shuffle=False,
            drop_last=False,
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

        # ── Training loop ──
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

                optimizer.zero_grad()
                # In-batch NCA prediction
                preds = self._model.in_batch_predict(X_batch, y_batch)
                loss = criterion(preds, y_batch)
                loss.backward()
                nn.utils.clip_grad_norm_(self._model.parameters(), max_norm=1.0)
                optimizer.step()
                train_losses.append(loss.item())

            scheduler.step()

            # ── Validate ──
            self._model.eval()
            val_loss_sum = 0.0
            val_count = 0
            with torch.no_grad():
                for X_vb, y_vb in val_loader:
                    X_vb = X_vb.to(self._device)
                    y_vb = y_vb.to(self._device)
                    vp = self._model.in_batch_predict(X_vb, y_vb)
                    val_loss_sum += criterion(vp, y_vb).item() * len(X_vb)
                    val_count += len(X_vb)
            val_loss = val_loss_sum / val_count
            train_loss = float(np.mean(train_losses))

            # Early stopping
            if val_loss < best_val_loss:
                best_val_loss = val_loss
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
                })

            if epoch % 10 == 0 or epoch == self.n_epochs - 1:
                temp = self._model.temperature.item()
                print(f"  [MNCA] Epoch {epoch}: train={train_loss:.6f}, "
                      f"val={val_loss:.6f}, lr={optimizer.param_groups[0]['lr']:.6f}, "
                      f"temp={temp:.4f}")

            if patience_counter >= self.early_stopping_rounds:
                print(f"  [MNCA] Early stopping at epoch {epoch}, "
                      f"best={best_epoch} (val_loss={best_val_loss:.6f})")
                break

        # Restore best weights
        if best_state is not None:
            self._model.load_state_dict(best_state)
        self._model.eval()

        # ── Build reference store from full training data ──
        self._build_reference_store(X_train, y_train)

        # Era counts
        if val_df is not None:
            era_info = {
                "train_eras": train_df[era_col].nunique(),
                "val_eras": val_df[era_col].nunique(),
            }
        else:
            era_info = {
                "train_eras": int(len(eras) * 0.8),
                "val_eras": len(eras) - int(len(eras) * 0.8),
            }

        return {
            "best_iteration": best_epoch,
            "best_score": {"val": {"mse": best_val_loss}},
            **era_info,
        }

    # ------------------------------------------------------------------
    # Reference store
    # ------------------------------------------------------------------

    def _build_reference_store(
        self, X_train: "torch.Tensor", y_train: "torch.Tensor",
    ) -> None:
        """Embed training data and store for prediction-time KNN.

        If the training set exceeds MAX_REFERENCE_SIZE, randomly subsample
        to keep prediction latency manageable.
        """
        n_total = len(X_train)

        # Subsample if too large
        if n_total > self.MAX_REFERENCE_SIZE:
            indices = np.random.permutation(n_total)[: self.MAX_REFERENCE_SIZE]
            indices.sort()  # keep order for reproducibility
            X_ref = X_train[indices]
            y_ref = y_train[indices]
            print(f"  [MNCA] Reference store: subsampled {self.MAX_REFERENCE_SIZE:,} "
                  f"from {n_total:,} training rows")
        else:
            X_ref = X_train
            y_ref = y_train
            print(f"  [MNCA] Reference store: using all {n_total:,} training rows")

        # Compute embeddings in batches
        embed_batch = 8192
        embeddings = []
        self._model.eval()
        with torch.no_grad():
            for i in range(0, len(X_ref), embed_batch):
                batch = X_ref[i: i + embed_batch].to(self._device)
                emb = self._model(batch).cpu()
                embeddings.append(emb)

        self._reference_embeddings = torch.cat(embeddings, dim=0)  # (N_ref, D)
        self._reference_labels = y_ref.cpu() if y_ref.is_cuda else y_ref.clone()

    # ------------------------------------------------------------------
    # Predict
    # ------------------------------------------------------------------

    def predict(self, df: pd.DataFrame, feature_cols: List[str]) -> pd.Series:
        """Predict via KNN lookup in the reference embedding space.

        For each query, compute distances to all reference points (in chunks),
        take top-K nearest, and return distance-weighted average of their labels.
        """
        if self._model is None:
            raise RuntimeError("Model not trained or loaded")
        if self._reference_embeddings is None:
            raise RuntimeError("Reference store not built -- train or load first")

        self._model.eval()
        X = torch.tensor(
            df[feature_cols].fillna(0).values, dtype=torch.float32,
        )

        temperature = self._model.temperature.detach()
        ref_emb = self._reference_embeddings.to(self._device)  # (N_ref, D)
        ref_labels = self._reference_labels.to(self._device)  # (N_ref,)
        k = min(self.n_neighbors, len(ref_emb))

        query_batch_size = 2048
        # Process reference in chunks to limit peak GPU memory
        ref_chunk_size = 50_000

        all_preds = []

        with torch.no_grad():
            for qi in range(0, len(X), query_batch_size):
                q_batch = X[qi: qi + query_batch_size].to(self._device)
                q_emb = self._model(q_batch)  # (Q, D)

                if len(ref_emb) <= ref_chunk_size:
                    # Small reference: compute all distances at once
                    dists = torch.cdist(q_emb, ref_emb, p=2).pow(2)  # (Q, N_ref)
                    topk_dists, topk_idx = dists.topk(k, dim=-1, largest=False)
                else:
                    # Large reference: chunked top-K
                    topk_dists, topk_idx = self._chunked_topk(
                        q_emb, ref_emb, k, ref_chunk_size,
                    )

                # Distance-weighted prediction from top-K neighbors
                topk_labels = ref_labels[topk_idx]  # (Q, K)
                weights = F.softmax(
                    -topk_dists / temperature, dim=-1,
                )  # (Q, K)
                preds = (weights * topk_labels).sum(dim=-1)  # (Q,)
                all_preds.append(preds.cpu().numpy())

        return pd.Series(
            np.concatenate(all_preds), index=df.index, name="prediction",
        )

    @staticmethod
    def _chunked_topk(
        q_emb: "torch.Tensor",
        ref_emb: "torch.Tensor",
        k: int,
        chunk_size: int,
    ) -> tuple:
        """Compute top-K nearest neighbors by processing reference in chunks.

        Returns:
            (topk_dists, topk_idx) each of shape (Q, K).
        """
        # Accumulate candidate distances and indices across chunks
        cand_dists = []
        cand_idx = []
        for ri in range(0, len(ref_emb), chunk_size):
            ref_chunk = ref_emb[ri: ri + chunk_size]
            chunk_dists = torch.cdist(q_emb, ref_chunk, p=2).pow(2)  # (Q, C)
            chunk_k = min(k, chunk_dists.size(1))
            td, ti = chunk_dists.topk(chunk_k, dim=-1, largest=False)
            cand_dists.append(td)
            cand_idx.append(ti + ri)  # offset indices to global ref index

        # Merge candidates and take final top-K
        all_dists = torch.cat(cand_dists, dim=-1)  # (Q, sum_of_chunk_k)
        all_idx = torch.cat(cand_idx, dim=-1)

        final_topk_dists, merge_idx = all_dists.topk(k, dim=-1, largest=False)
        final_topk_idx = all_idx.gather(1, merge_idx)

        return final_topk_dists, final_topk_idx

    # ------------------------------------------------------------------
    # Save / Load
    # ------------------------------------------------------------------

    def save(self, path: Path) -> None:
        """Save encoder weights, reference store, and config."""
        if self._model is None:
            raise RuntimeError("No model to save")

        path.mkdir(parents=True, exist_ok=True)

        # Encoder weights
        torch.save(self._model.state_dict(), str(path / "model.pt"))

        # Reference store
        if self._reference_embeddings is not None:
            torch.save(
                {
                    "embeddings": self._reference_embeddings,
                    "labels": self._reference_labels,
                },
                str(path / "reference.pt"),
            )

        # Meta
        meta = {
            "model_type": self.model_type,
            "hidden_dims": self.hidden_dims,
            "d_embedding": self.d_embedding,
            "n_neighbors": self.n_neighbors,
            "dropout": self.dropout,
            "noise_std": self.noise_std,
            "learning_rate": self.learning_rate,
            "weight_decay": self.weight_decay,
            "n_epochs": self.n_epochs,
            "batch_size": self.batch_size,
            "feature_names": self._feature_names,
            "input_dim": len(self._feature_names),
            "reference_size": (
                len(self._reference_embeddings)
                if self._reference_embeddings is not None
                else 0
            ),
        }
        with open(path / "meta.json", "w") as f:
            json.dump(meta, f, indent=2)

    def load(self, path: Path) -> None:
        """Load encoder weights, reference store, and config from disk."""
        with open(path / "meta.json") as f:
            meta = json.load(f)

        self._feature_names = meta.get("feature_names", [])
        self.hidden_dims = meta.get("hidden_dims", self.hidden_dims)
        self.d_embedding = meta.get("d_embedding", self.d_embedding)
        self.n_neighbors = meta.get("n_neighbors", self.n_neighbors)
        self.dropout = meta.get("dropout", self.dropout)
        self.noise_std = meta.get("noise_std", self.noise_std)

        input_dim = meta.get("input_dim", len(self._feature_names))
        self._model = _ModernNCANetwork(
            input_dim=input_dim,
            hidden_dims=self.hidden_dims,
            d_embedding=self.d_embedding,
            dropout=self.dropout,
            noise_std=self.noise_std,
        ).to(self._device)

        self._model.load_state_dict(
            torch.load(str(path / "model.pt"), map_location=self._device)
        )
        self._model.eval()

        # Load reference store
        ref_path = path / "reference.pt"
        if ref_path.exists():
            ref_data = torch.load(str(ref_path), map_location="cpu")
            self._reference_embeddings = ref_data["embeddings"]
            self._reference_labels = ref_data["labels"]

    @property
    def model_type(self) -> str:
        return "modern_nca"
