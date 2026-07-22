"""Model factory for Numerai tournament models."""

from __future__ import annotations

from typing import Optional

from models.base import NumeraiModel

# Optional imports - models whose heavy/native deps may not be installed.
# LightGBM is optional too: it needs libomp, which a torch-only (MPS) box may
# not have. Catching Exception (not just ImportError) covers the libomp OSError
# raised at load time, so neural models still work without LightGBM installed.
try:
    from models.lgbm_model import LightGBMModel
except Exception:
    LightGBMModel = None

try:
    from models.xgboost_model import XGBoostModel
except ImportError:
    XGBoostModel = None

try:
    from models.catboost_model import CatBoostModel
except ImportError:
    CatBoostModel = None

try:
    from models.mlp_model import MLPModel
except ImportError:
    MLPModel = None

try:
    from models.ft_transformer_model import FTTransformerModel
except ImportError:
    FTTransformerModel = None

try:
    from models.modern_nca_model import ModernNCAModel
except ImportError:
    ModernNCAModel = None

try:
    from models.tabm_model import TabMModel
except ImportError:
    TabMModel = None

try:
    from models.tabpfn_model import TabPFNModel
except ImportError:
    TabPFNModel = None

try:
    from models.tabicl_model import TabICLModel
except ImportError:
    TabICLModel = None

try:
    from models.warpgbm_model import WarpGBMModel
except ImportError:
    WarpGBMModel = None


def create_model(
    model_type: str = "lgbm",
    num_leaves: int = 512,
    max_depth: int = 8,
    learning_rate: float = 0.005,
    n_estimators: int = 10000,
    feature_fraction: float = 0.1,
    bagging_fraction: float = 0.5,
    bagging_freq: int = 1,
    early_stopping_rounds: int = 200,
    **kwargs,
) -> NumeraiModel:
    """Factory function to create a model instance by type.
    
    Args:
        model_type: Model implementation identifier.
        num_leaves: LightGBM num_leaves.
        max_depth: Tree depth cap for boosting models.
        learning_rate: Learning rate.
        n_estimators: Number of boosting rounds/iterations
        feature_fraction: LightGBM feature_fraction (column sampling)
        bagging_fraction: LightGBM bagging_fraction (row sampling)
        bagging_freq: LightGBM bagging frequency
        early_stopping_rounds: Early stopping patience
        **kwargs: Additional model-specific parameters
    
    Returns:
        NumeraiModel instance
    
    Raises:
        ValueError: If model_type is not supported
        RuntimeError: If required package not installed
    """
    model_type = model_type.lower()
    
    if model_type == "lgbm":
        if LightGBMModel is None:
            raise RuntimeError(
                "LightGBM not available. Install with: pip install lightgbm "
                "(macOS also needs libomp: brew install libomp)."
            )
        return LightGBMModel(
            num_leaves=num_leaves,
            max_depth=max_depth,
            learning_rate=learning_rate,
            n_estimators=n_estimators,
            feature_fraction=feature_fraction,
            bagging_fraction=bagging_fraction,
            bagging_freq=bagging_freq,
            early_stopping_rounds=early_stopping_rounds,
            **kwargs,
        )
    
    elif model_type == "warpgbm":
        if WarpGBMModel is None:
            raise RuntimeError(
                "WarpGBM not installed. Install the MPS-capable fork with: "
                'pip install "git+https://github.com/Mazzz-zzz/warpgbm.git@mps-support"'
            )
        return WarpGBMModel(
            n_estimators=n_estimators,
            learning_rate=learning_rate,
            max_depth=max_depth,
            feature_fraction=feature_fraction,
            **kwargs,
        )

    elif model_type == "xgboost":
        if XGBoostModel is None:
            raise RuntimeError(
                "XGBoost not installed. "
                "Install with: pip install xgboost==3.2.0"
            )
        return XGBoostModel(
            n_estimators=n_estimators,
            learning_rate=learning_rate,
            max_depth=max_depth,
            feature_fraction=feature_fraction,
            bagging_fraction=bagging_fraction,
            early_stopping_rounds=early_stopping_rounds,
            **kwargs,
        )

    elif model_type == "catboost":
        if CatBoostModel is None:
            raise RuntimeError(
                "CatBoost not installed. "
                "Install with: pip install catboost"
            )
        # Map LightGBM params to CatBoost equivalents
        return CatBoostModel(
            iterations=n_estimators,
            learning_rate=learning_rate,
            depth=max_depth,
            early_stopping_rounds=early_stopping_rounds,
            **kwargs,
        )
    
    elif model_type == "mlp":
        if MLPModel is None:
            raise RuntimeError(
                "PyTorch not installed. "
                "Install with: pip install torch"
            )
        # MLP uses epochs not boosting rounds — cap at 100, patience at 20
        mlp_epochs = min(n_estimators, 100)
        mlp_patience = min(early_stopping_rounds, 20)
        # Filter kwargs to only those MLPModel accepts
        mlp_keys = {
            "hidden_dims", "dropout", "noise_std", "weight_decay",
            "batch_size", "mixup_alpha", "swa", "swa_start_frac",
            "warmup_epochs", "multi_head",
        }
        mlp_kwargs = {k: v for k, v in kwargs.items() if k in mlp_keys}
        return MLPModel(
            learning_rate=learning_rate,
            n_epochs=mlp_epochs,
            early_stopping_rounds=mlp_patience,
            **mlp_kwargs,
        )

    elif model_type == "ft_transformer":
        if FTTransformerModel is None:
            raise RuntimeError(
                "PyTorch not installed. "
                "Install with: pip install torch"
            )
        ft_epochs = min(n_estimators, 100)
        ft_patience = min(early_stopping_rounds, 15)
        return FTTransformerModel(
            learning_rate=learning_rate,
            n_epochs=ft_epochs,
            early_stopping_rounds=ft_patience,
            **kwargs,
        )

    elif model_type == "modern_nca":
        if ModernNCAModel is None:
            raise RuntimeError(
                "PyTorch not installed. "
                "Install with: pip install torch"
            )
        nca_epochs = min(n_estimators, 100)
        nca_patience = min(early_stopping_rounds, 15)
        nca_keys = {
            "hidden_dims", "d_embedding", "n_neighbors",
            "dropout", "noise_std", "weight_decay", "batch_size",
        }
        nca_kwargs = {k: v for k, v in kwargs.items() if k in nca_keys}
        return ModernNCAModel(
            learning_rate=learning_rate,
            n_epochs=nca_epochs,
            early_stopping_rounds=nca_patience,
            **nca_kwargs,
        )

    elif model_type == "tabm":
        if TabMModel is None:
            raise RuntimeError(
                "PyTorch not installed. "
                "Install with: pip install torch"
            )
        tabm_epochs = min(n_estimators, 100)
        tabm_patience = min(early_stopping_rounds, 15)
        tabm_keys = {
            "n_ensemble", "hidden_dims", "dropout", "noise_std",
            "weight_decay", "batch_size",
        }
        tabm_kwargs = {k: v for k, v in kwargs.items() if k in tabm_keys}
        return TabMModel(
            learning_rate=learning_rate,
            n_epochs=tabm_epochs,
            early_stopping_rounds=tabm_patience,
            **tabm_kwargs,
        )

    elif model_type == "tabpfn":
        if TabPFNModel is None:
            raise RuntimeError(
                "TabPFN not installed. "
                "Install with: pip install tabpfn"
            )
        tabpfn_keys = {
            "n_bags", "context_rows", "features_per_bag",
            "n_recent_eras", "n_estimators_per_bag",
        }
        tabpfn_kwargs = {k: v for k, v in kwargs.items() if k in tabpfn_keys}
        return TabPFNModel(**tabpfn_kwargs)

    elif model_type == "tabicl":
        if TabICLModel is None:
            raise RuntimeError(
                "TabICL not installed. "
                "Install with: pip install tabicl"
            )
        tabicl_keys = {
            "n_bags", "context_rows", "features_per_bag",
            "n_recent_eras", "n_estimators_per_bag",
            "norm_methods", "device", "offload_mode", "use_amp", "use_fa3",
            "batch_size",
        }
        tabicl_kwargs = {k: v for k, v in kwargs.items() if k in tabicl_keys}
        return TabICLModel(**tabicl_kwargs)

    else:
        raise ValueError(
            f"Unknown model_type: {model_type}. "
            f"Supported types: lgbm, xgboost, catboost, mlp, ft_transformer, "
            f"modern_nca, tabm, tabpfn, tabicl"
        )


def list_available_models() -> list[str]:
    """Return list of available model types."""
    models = []
    if LightGBMModel is not None:
        models.append("lgbm")
    if XGBoostModel is not None:
        models.append("xgboost")
    if CatBoostModel is not None:
        models.append("catboost")
    if MLPModel is not None:
        models.append("mlp")
    if FTTransformerModel is not None:
        models.append("ft_transformer")
    if ModernNCAModel is not None:
        models.append("modern_nca")
    if TabMModel is not None:
        models.append("tabm")
    if TabPFNModel is not None:
        models.append("tabpfn")
    if TabICLModel is not None:
        models.append("tabicl")
    return models
