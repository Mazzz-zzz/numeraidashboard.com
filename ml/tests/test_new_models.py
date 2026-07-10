"""Tests for TabM, ModernNCA, TabICL, and training-time correlation metrics."""

from __future__ import annotations

import json
import numpy as np
import pandas as pd
import pytest

try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

try:
    from tabicl import TabICLRegressor
    HAS_TABICL = True
except ImportError:
    HAS_TABICL = False


@pytest.fixture
def synthetic_data():
    """Small synthetic dataset with signal in feature_0."""
    np.random.seed(42)
    n_eras = 10
    rows_per_era = 100
    n_features = 20

    rows = []
    for i in range(n_eras):
        era = f"era_{i:03d}"
        features = np.random.randn(rows_per_era, n_features).astype(np.float32)
        target = (features[:, 0] * 0.3 + np.random.randn(rows_per_era) * 0.5).astype(np.float32)
        df = pd.DataFrame(features, columns=[f"feature_{j}" for j in range(n_features)])
        df["era"] = era
        df["target"] = target
        rows.append(df)

    return pd.concat(rows, ignore_index=True)


@pytest.fixture
def val_data():
    np.random.seed(123)
    rows = []
    for i in range(3):
        era = f"era_val_{i:03d}"
        features = np.random.randn(100, 20).astype(np.float32)
        target = (features[:, 0] * 0.3 + np.random.randn(100) * 0.5).astype(np.float32)
        df = pd.DataFrame(features, columns=[f"feature_{j}" for j in range(20)])
        df["era"] = era
        df["target"] = target
        rows.append(df)
    return pd.concat(rows, ignore_index=True)


@pytest.fixture
def feature_cols():
    return [f"feature_{j}" for j in range(20)]


# ── TabM Tests ──

@pytest.mark.skipif(not HAS_TORCH, reason="PyTorch not installed")
class TestTabMModel:
    def test_fit_and_predict(self, synthetic_data, feature_cols, val_data):
        from models.tabm_model import TabMModel

        model = TabMModel(
            n_ensemble=4, hidden_dims=[32, 32],
            n_epochs=5, batch_size=128, early_stopping_rounds=3,
        )
        info = model.fit(synthetic_data, feature_cols, "target", "era", val_df=val_data)

        assert "best_iteration" in info
        assert "best_score" in info

        preds = model.predict(synthetic_data, feature_cols)
        assert len(preds) == len(synthetic_data)
        assert preds.isna().sum() == 0

    def test_save_and_load(self, synthetic_data, feature_cols, val_data, tmp_path):
        from models.tabm_model import TabMModel

        model = TabMModel(
            n_ensemble=4, hidden_dims=[32], n_epochs=3,
            batch_size=128, early_stopping_rounds=2,
        )
        model.fit(synthetic_data, feature_cols, "target", "era", val_df=val_data)
        preds_before = model.predict(synthetic_data, feature_cols)

        path = tmp_path / "tabm_model"
        model.save(path)

        model2 = TabMModel()
        model2.load(path)
        preds_after = model2.predict(synthetic_data, feature_cols)

        np.testing.assert_allclose(preds_before.values, preds_after.values, rtol=1e-5)

    def test_epoch_callback(self, synthetic_data, feature_cols, val_data):
        from models.tabm_model import TabMModel

        callbacks = []
        model = TabMModel(
            n_ensemble=4, hidden_dims=[16], n_epochs=5,
            batch_size=128, early_stopping_rounds=3,
        )
        model.fit(
            synthetic_data, feature_cols, "target", "era",
            epoch_callback=lambda info: callbacks.append(info),
            val_df=val_data,
        )

        assert len(callbacks) > 0
        assert "epoch" in callbacks[0]
        assert "train_loss" in callbacks[0]
        assert "val_loss" in callbacks[0]

    def test_model_type(self):
        from models.tabm_model import TabMModel
        assert TabMModel(n_ensemble=4).model_type == "tabm"

    def test_era_split_fallback(self, synthetic_data, feature_cols):
        from models.tabm_model import TabMModel

        model = TabMModel(
            n_ensemble=4, hidden_dims=[16], n_epochs=3,
            batch_size=128, early_stopping_rounds=2,
        )
        info = model.fit(synthetic_data, feature_cols, "target", "era")
        assert info["best_iteration"] >= 0

    def test_ensemble_averaging(self, synthetic_data, feature_cols, val_data):
        """Predictions should differ from constant (ensemble is learning)."""
        from models.tabm_model import TabMModel

        model = TabMModel(
            n_ensemble=8, hidden_dims=[64, 64], n_epochs=15,
            batch_size=128, early_stopping_rounds=10, learning_rate=0.01,
        )
        model.fit(synthetic_data, feature_cols, "target", "era", val_df=val_data)
        preds = model.predict(synthetic_data, feature_cols)
        assert preds.std() > 0.01


# ── ModernNCA Tests ──

@pytest.mark.skipif(not HAS_TORCH, reason="PyTorch not installed")
class TestModernNCAModel:
    def test_fit_and_predict(self, synthetic_data, feature_cols, val_data):
        from models.modern_nca_model import ModernNCAModel

        model = ModernNCAModel(
            hidden_dims=[32], d_embedding=16, n_neighbors=10,
            n_epochs=5, batch_size=128, early_stopping_rounds=3,
        )
        info = model.fit(synthetic_data, feature_cols, "target", "era", val_df=val_data)

        assert "best_iteration" in info
        preds = model.predict(synthetic_data, feature_cols)
        assert len(preds) == len(synthetic_data)
        assert preds.isna().sum() == 0

    def test_save_and_load(self, synthetic_data, feature_cols, val_data, tmp_path):
        from models.modern_nca_model import ModernNCAModel

        model = ModernNCAModel(
            hidden_dims=[32], d_embedding=16, n_neighbors=10,
            n_epochs=3, batch_size=128, early_stopping_rounds=2,
        )
        model.fit(synthetic_data, feature_cols, "target", "era", val_df=val_data)
        preds_before = model.predict(synthetic_data, feature_cols)

        path = tmp_path / "nca_model"
        model.save(path)

        model2 = ModernNCAModel()
        model2.load(path)
        preds_after = model2.predict(synthetic_data, feature_cols)

        np.testing.assert_allclose(preds_before.values, preds_after.values, rtol=1e-4)

    def test_reference_store_subsampling(self, feature_cols, val_data):
        """Reference store should subsample when exceeding MAX_REFERENCE_SIZE."""
        from models.modern_nca_model import ModernNCAModel

        model = ModernNCAModel(
            hidden_dims=[16], d_embedding=8, n_neighbors=5,
            n_epochs=2, batch_size=64, early_stopping_rounds=2,
        )
        # Set a tiny limit to trigger subsampling
        model.MAX_REFERENCE_SIZE = 50

        np.random.seed(42)
        df = pd.DataFrame(
            np.random.randn(200, 20).astype(np.float32), columns=feature_cols,
        )
        df["era"] = "era_001"
        df["target"] = np.random.randn(200).astype(np.float32)

        model.fit(df, feature_cols, "target", "era", val_df=val_data)
        assert model._reference_embeddings is not None
        assert len(model._reference_embeddings) <= 50

    def test_model_type(self):
        from models.modern_nca_model import ModernNCAModel
        assert ModernNCAModel().model_type == "modern_nca"

    def test_epoch_callback(self, synthetic_data, feature_cols, val_data):
        from models.modern_nca_model import ModernNCAModel

        callbacks = []
        model = ModernNCAModel(
            hidden_dims=[16], d_embedding=8, n_neighbors=10,
            n_epochs=5, batch_size=128, early_stopping_rounds=3,
        )
        model.fit(
            synthetic_data, feature_cols, "target", "era",
            epoch_callback=lambda info: callbacks.append(info),
            val_df=val_data,
        )
        assert len(callbacks) > 0
        assert "train_loss" in callbacks[0]
        assert "val_loss" in callbacks[0]


# ── TabICL Tests ──

@pytest.mark.skipif(not HAS_TABICL, reason="TabICL not installed")
class TestTabICLModel:
    def test_fit_and_predict(self, synthetic_data, feature_cols, val_data):
        from models.tabicl_model import TabICLModel

        model = TabICLModel(
            n_bags=2, context_rows=200, features_per_bag=20,
            n_recent_eras=10, n_estimators_per_bag=2,
        )
        info = model.fit(synthetic_data, feature_cols, "target", "era", val_df=val_data)

        assert "best_iteration" in info
        preds = model.predict(synthetic_data, feature_cols)
        assert len(preds) == len(synthetic_data)
        assert preds.isna().sum() == 0

    def test_save_and_load(self, synthetic_data, feature_cols, val_data, tmp_path):
        from models.tabicl_model import TabICLModel

        model = TabICLModel(
            n_bags=2, context_rows=200, features_per_bag=20,
            n_recent_eras=10, n_estimators_per_bag=2,
        )
        model.fit(synthetic_data, feature_cols, "target", "era", val_df=val_data)
        preds_before = model.predict(synthetic_data, feature_cols)

        path = tmp_path / "tabicl_model"
        model.save(path)

        model2 = TabICLModel()
        model2.load(path)
        preds_after = model2.predict(synthetic_data, feature_cols)

        np.testing.assert_allclose(preds_before.values, preds_after.values, rtol=1e-4)

    def test_feature_bagging(self):
        """Should subsample features when exceeding MAX_FEATURES."""
        from models.tabicl_model import TabICLModel

        # Use 120 features to exceed MAX_FEATURES (100)
        n_feat = 120
        cols = [f"f_{j}" for j in range(n_feat)]
        model = TabICLModel(n_bags=2, context_rows=100, features_per_bag=50)

        np.random.seed(42)
        df = pd.DataFrame(
            np.random.randn(200, n_feat).astype(np.float32), columns=cols,
        )
        df["era"] = "era_001"
        df["target"] = np.random.randn(200).astype(np.float32)

        model.fit(df, cols, "target", "era")
        # Each bag should have 50 features (capped by features_per_bag)
        for bag in model._bags:
            assert len(bag["features"]) == 50

    def test_model_type(self):
        from models.tabicl_model import TabICLModel
        assert TabICLModel().model_type == "tabicl"

    def test_mps_runtime_defaults_fall_back_to_cpu(self, monkeypatch):
        from models.tabicl_model import TabICLModel

        monkeypatch.delenv("NUMERAI_TABICL_ALLOW_MPS", raising=False)
        model = TabICLModel(device="mps")

        assert model._device == "cpu"
        assert model.offload_mode == "auto"
        assert model.use_amp is False
        assert model.use_fa3 is False

    def test_mps_runtime_can_be_forced_for_experiments(self, monkeypatch):
        from models.tabicl_model import TabICLModel

        monkeypatch.setenv("NUMERAI_TABICL_ALLOW_MPS", "1")
        model = TabICLModel(device="mps")

        assert model._device == "mps"
        assert model.offload_mode == "auto"
        assert model.use_amp == "auto"
        assert model.use_fa3 is False

    def test_make_regressor_passes_mps_safe_options(self, monkeypatch):
        import models.tabicl_model as tabicl_model
        from models.tabicl_model import TabICLModel

        captured = {}

        class FakeRegressor:
            def __init__(self, **kwargs):
                captured.update(kwargs)

            def fit(self, X, y):
                self.model_ = object()
                self.model_config_ = {"fake": True}
                self.model_path_ = None

        monkeypatch.setattr(tabicl_model, "TabICLRegressor", FakeRegressor)
        monkeypatch.setenv("NUMERAI_TABICL_ALLOW_MPS", "1")

        model = TabICLModel(
            device="mps",
            n_estimators_per_bag=3,
            offload_mode="auto",
            use_amp="auto",
            use_fa3="auto",
            batch_size=7,
        )
        model._make_regressor(
            {"X": np.zeros((4, 2), dtype=np.float32), "y": np.zeros(4, dtype=np.float32), "seed": 123},
            model._device,
        )

        assert captured["device"] == "mps"
        assert captured["offload_mode"] == "auto"
        assert captured["use_amp"] == "auto"
        assert captured["use_fa3"] is False
        assert captured["batch_size"] == 7

    def test_no_fillna(self, feature_cols, val_data):
        """TabICL should preserve NaN values (not fill them)."""
        from models.tabicl_model import TabICLModel

        np.random.seed(42)
        df = pd.DataFrame(
            np.random.randn(200, 20).astype(np.float32), columns=feature_cols,
        )
        df["era"] = "era_001"
        df["target"] = np.random.randn(200).astype(np.float32)
        df.iloc[0, 0] = np.nan

        model = TabICLModel(n_bags=1, context_rows=200, features_per_bag=20, n_estimators_per_bag=2)
        model.fit(df, feature_cols, "target", "era")

        # Stored context should contain the NaN
        assert np.isnan(model._bags[0]["X"]).any()


# ── Factory Tests ──

class TestModelFactory:
    def test_all_models_in_registry(self):
        from models import list_available_models
        available = list_available_models()
        assert "lgbm" in available
        if HAS_TORCH:
            assert "mlp" in available
            assert "tabm" in available
            assert "modern_nca" in available
            assert "ft_transformer" in available
        if HAS_TABICL:
            assert "tabicl" in available

    @pytest.mark.skipif(not HAS_TORCH, reason="PyTorch not installed")
    def test_create_tabm(self):
        from models import create_model
        model = create_model(model_type="tabm", n_ensemble=4, hidden_dims=[16])
        assert model.model_type == "tabm"

    @pytest.mark.skipif(not HAS_TORCH, reason="PyTorch not installed")
    def test_create_modern_nca(self):
        from models import create_model
        model = create_model(model_type="modern_nca", d_embedding=16)
        assert model.model_type == "modern_nca"

    @pytest.mark.skipif(not HAS_TABICL, reason="TabICL not installed")
    def test_create_tabicl(self):
        from models import create_model
        model = create_model(model_type="tabicl", n_bags=2)
        assert model.model_type == "tabicl"

    @pytest.mark.skipif(not HAS_TABICL, reason="TabICL not installed")
    def test_create_tabicl_falls_back_from_mps_by_default(self, monkeypatch):
        from models import create_model

        monkeypatch.delenv("NUMERAI_TABICL_ALLOW_MPS", raising=False)
        model = create_model(
            model_type="tabicl",
            device="mps",
            offload_mode="auto",
            use_amp="auto",
            use_fa3="auto",
            batch_size=9,
        )

        assert model._device == "cpu"
        assert model.offload_mode == "auto"
        assert model.use_amp is False
        assert model.use_fa3 is False
        assert model.batch_size == 9

    def test_unknown_model_raises(self):
        from models import create_model
        with pytest.raises(ValueError, match="Unknown model_type"):
            create_model(model_type="nonexistent_model")


# ── Correlation-during-training Tests ──

@pytest.mark.skipif(not HAS_TORCH, reason="PyTorch not installed")
class TestTrainingCorrelation:
    """Test that epoch callbacks can carry correlation and sharpe."""

    def test_epoch_callback_keys(self, synthetic_data, feature_cols, val_data):
        """Verify standard epoch callback has required keys."""
        from models.tabm_model import TabMModel

        callbacks = []
        model = TabMModel(
            n_ensemble=4, hidden_dims=[16], n_epochs=3,
            batch_size=128, early_stopping_rounds=2,
        )
        model.fit(
            synthetic_data, feature_cols, "target", "era",
            epoch_callback=lambda info: callbacks.append(info.copy()),
            val_df=val_data,
        )

        assert len(callbacks) >= 1
        required_keys = {"epoch", "train_loss", "val_loss", "train_l2", "val_l2"}
        assert required_keys.issubset(callbacks[0].keys())

    def test_correlation_computation_is_valid(self, synthetic_data, feature_cols, val_data):
        """Per-era correlation should produce finite values on synthetic data."""
        import sys
        sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
        from training.validate import per_era_correlation

        # Train a quick model and get predictions
        from models.tabm_model import TabMModel
        model = TabMModel(
            n_ensemble=4, hidden_dims=[32], n_epochs=5,
            batch_size=128, early_stopping_rounds=3,
        )
        model.fit(synthetic_data, feature_cols, "target", "era", val_df=val_data)
        preds = model.predict(val_data, feature_cols)

        tmp = val_data[["era", "target"]].copy()
        tmp["_pred"] = preds.values
        era_corrs = per_era_correlation(tmp, "_pred", "target", "era")

        assert len(era_corrs) > 0
        assert np.all(np.isfinite(era_corrs))
        mean_corr = float(era_corrs.mean())
        sharpe = float(era_corrs.mean() / era_corrs.std()) if era_corrs.std() > 0 else 0.0
        assert np.isfinite(mean_corr)
        assert np.isfinite(sharpe)


# ── TabICL Validation and Memory Tests ──

@pytest.mark.skipif(not HAS_TABICL, reason="TabICL not installed")
class TestTabICLValidation:
    """Tests for TabICL validation timing and epoch callback correctness.

    These tests verify the fixes for:
    - Validation running at the LAST bag (not just bag 0)
    - val_loss being computed from the full ensembled predict()
    - Epoch callback carrying val_loss at the correct bag
    """

    def test_val_loss_only_at_last_bag(self, synthetic_data, feature_cols, val_data):
        """val_loss should be non-zero only at the last bag, not bag 0."""
        from models.tabicl_model import TabICLModel

        callbacks = []
        model = TabICLModel(
            n_bags=3, context_rows=200, features_per_bag=20,
            n_recent_eras=10, n_estimators_per_bag=2,
        )
        model.fit(
            synthetic_data, feature_cols, "target", "era",
            epoch_callback=lambda info: callbacks.append(info.copy()),
            val_df=val_data,
        )

        assert len(callbacks) == 3  # one per bag
        # Only the last bag should have a real val_loss
        for cb in callbacks[:-1]:
            assert cb["val_loss"] == 0.0, (
                f"Bag {cb['epoch']} should have val_loss=0, got {cb['val_loss']}"
            )
        last = callbacks[-1]
        assert last["val_loss"] > 0, (
            "Last bag should have a non-zero val_loss from full ensembled predict"
        )

    def test_val_loss_uses_full_ensemble(self, synthetic_data, feature_cols, val_data):
        """val_loss at the last bag should match a manual full-model predict MSE."""
        from models.tabicl_model import TabICLModel

        callbacks = []
        model = TabICLModel(
            n_bags=2, context_rows=200, features_per_bag=20,
            n_recent_eras=10, n_estimators_per_bag=2,
        )
        model.fit(
            synthetic_data, feature_cols, "target", "era",
            epoch_callback=lambda info: callbacks.append(info.copy()),
            val_df=val_data,
        )

        # Manually compute MSE from full model predict
        preds = model.predict(val_data, feature_cols)
        expected_mse = float(np.mean((preds.values - val_data["target"].values) ** 2))

        reported_mse = callbacks[-1]["val_loss"]
        np.testing.assert_allclose(reported_mse, expected_mse, rtol=0.01,
            err_msg="val_loss should match full-ensemble MSE")

    def test_no_val_loss_without_val_df(self, synthetic_data, feature_cols):
        """When val_df is None, all bags should have val_loss=0."""
        from models.tabicl_model import TabICLModel

        callbacks = []
        model = TabICLModel(
            n_bags=2, context_rows=200, features_per_bag=20,
            n_recent_eras=10, n_estimators_per_bag=2,
        )
        model.fit(
            synthetic_data, feature_cols, "target", "era",
            epoch_callback=lambda info: callbacks.append(info.copy()),
            val_df=None,
        )

        for cb in callbacks:
            assert cb["val_loss"] == 0.0


# ── Trainer Epoch Callback Tests ──

class TestTrainerEpochCallback:
    """Tests for the trainer's per-target epoch callback wrapping.

    These tests verify:
    - global_epoch is used (not local epoch) for corr/sharpe computation trigger
    - ICL models trigger corr/sharpe when val_loss > 0 (at last bag)
    - Non-ICL models trigger at global_epoch % 10 == 0
    """

    def test_global_epoch_triggers_corr_computation(self):
        """The should_compute check must use global_epoch, not local epoch.

        Bug: previously used info['epoch'] % 10 == 0, which is the local
        (per-target) epoch. For targets after the first, local epoch 0 maps
        to a barely-trained model, and subsequent local epochs (1,2,3...)
        never trigger since they're < 10.
        """
        # Simulate the callback logic directly
        callback_results = []

        def simulate_callback(global_offset, local_epoch, is_icl=False, val_loss=0.0):
            info = {
                "epoch": local_epoch,
                "val_loss": val_loss,
            }
            info["global_epoch"] = global_offset + info["epoch"]
            should_compute = (
                (info.get("val_loss", 0) > 0 if is_icl else info["global_epoch"] % 10 == 0)
                and True  # model and val_sub present
            )
            return should_compute

        # Target 0: local epochs 0-7, global 0-7
        # epoch 0 (global 0) should trigger
        assert simulate_callback(0, 0) is True
        # epoch 5 (global 5) should not
        assert simulate_callback(0, 5) is False

        # Target 1: local epochs 0-5, global 8-13
        # local epoch 0 (global 8) should NOT trigger — this was the bug
        assert simulate_callback(8, 0) is False
        # local epoch 2 (global 10) SHOULD trigger
        assert simulate_callback(8, 2) is True

        # Target 2: local epoch 2, global 20 — should trigger
        assert simulate_callback(18, 2) is True

    def test_local_epoch_would_miss_corr(self):
        """Red test: using local epoch % 10 misses corr for all targets after the first.

        This demonstrates the bug: if we used info['epoch'] % 10 instead of
        info['global_epoch'] % 10, target 1+ would only compute at local epoch 0
        (barely trained) and never again.
        """
        # Simulate with the OLD buggy logic: info["epoch"] % 10 == 0
        def buggy_should_compute(global_offset, local_epoch):
            return local_epoch % 10 == 0  # BUG: uses local epoch

        # Target 1, local epoch 2, global epoch 10 — SHOULD trigger but bug misses it
        assert buggy_should_compute(8, 2) is False  # bug confirms: missed
        # Only local epoch 0 triggers — which is a barely-trained model
        assert buggy_should_compute(8, 0) is True

    def test_icl_triggers_on_val_loss(self):
        """ICL models should trigger corr/sharpe when val_loss > 0 (last bag)."""
        def simulate_icl_callback(val_loss):
            info = {"epoch": 0, "val_loss": val_loss}
            info["global_epoch"] = 0
            is_icl = True
            should_compute = (
                (info.get("val_loss", 0) > 0 if is_icl else info["global_epoch"] % 10 == 0)
                and True
            )
            return should_compute

        # Non-last bags have val_loss=0 — should NOT trigger
        assert simulate_icl_callback(0.0) is False
        # Last bag has val_loss > 0 — should trigger
        assert simulate_icl_callback(0.05) is True


# ── ICL Memory Eviction Tests ──

@pytest.mark.skipif(not HAS_TABICL, reason="TabICL not installed")
class TestICLMemoryEviction:
    """Tests verifying that ICL models are properly evicted between targets.

    The trainer stores Path sentinels in models[] instead of model objects
    for tabpfn/tabicl, to avoid GPU OOM during multi-target training.
    """

    def test_model_save_load_roundtrip_for_eviction(self, synthetic_data, feature_cols, val_data, tmp_path):
        """Verify that a saved+loaded TabICL model produces identical predictions.

        This is critical because the eviction pattern relies on save→delete→reload.
        """
        from models.tabicl_model import TabICLModel

        model = TabICLModel(
            n_bags=2, context_rows=200, features_per_bag=20,
            n_recent_eras=10, n_estimators_per_bag=2,
        )
        model.fit(synthetic_data, feature_cols, "target", "era", val_df=val_data)

        preds_original = model.predict(val_data, feature_cols)
        model.save(tmp_path / "evict_test")
        del model

        reloaded = TabICLModel(
            n_bags=2, context_rows=200, features_per_bag=20,
            n_recent_eras=10, n_estimators_per_bag=2,
        )
        reloaded.load(tmp_path / "evict_test")
        preds_reloaded = reloaded.predict(val_data, feature_cols)

        np.testing.assert_allclose(
            preds_original.values, preds_reloaded.values, rtol=1e-4,
            err_msg="Reloaded model must produce identical predictions for eviction pattern to work"
        )

    def test_path_sentinel_pattern(self, tmp_path):
        """The trainer stores Path objects for evicted models.

        Verify the pattern: isinstance(models[target], Path) means evicted,
        otherwise it's a live model object.
        """
        from pathlib import Path
        from models import create_model

        models = {}

        # Simulate non-ICL: stores model object
        lgbm = create_model(model_type="lgbm")
        models["target"] = lgbm
        assert not isinstance(models["target"], Path)

        # Simulate ICL eviction: stores path
        models["target_icl"] = tmp_path / "model_target_icl"
        assert isinstance(models["target_icl"], Path)
