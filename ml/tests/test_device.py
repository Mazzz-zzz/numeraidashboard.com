"""Tests for the shared torch device resolver (config/device.py)."""

from __future__ import annotations

import importlib

import pytest

try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

from config import device as device_mod


def test_resolve_device_str_without_torch_is_cpu(monkeypatch):
    """resolve_device_str() degrades to 'cpu' when torch is unavailable."""
    def _raise():
        raise ImportError("no torch")

    monkeypatch.setattr(device_mod, "resolve_device", lambda prefer=None: _raise())
    assert device_mod.resolve_device_str() == "cpu"


def test_env_override_is_honoured(monkeypatch):
    """NUMERAI_TORCH_DEVICE forces the device regardless of hardware."""
    if not HAS_TORCH:
        pytest.skip("PyTorch not installed")
    monkeypatch.setenv(device_mod.DEVICE_ENV_VAR, "cpu")
    assert str(device_mod.resolve_device()) == "cpu"


def test_prefer_arg_beats_env(monkeypatch):
    """An explicit prefer= argument wins over the env var."""
    if not HAS_TORCH:
        pytest.skip("PyTorch not installed")
    monkeypatch.setenv(device_mod.DEVICE_ENV_VAR, "cpu")
    assert str(device_mod.resolve_device(prefer="cpu")) == "cpu"


@pytest.mark.skipif(not HAS_TORCH, reason="PyTorch not installed")
def test_auto_pick_is_a_real_device():
    """With no override, resolution returns one of cuda/mps/cpu."""
    import os

    os.environ.pop(device_mod.DEVICE_ENV_VAR, None)
    dev = str(device_mod.resolve_device())
    assert dev.split(":")[0] in {"cuda", "mps", "cpu"}


@pytest.mark.skipif(not HAS_TORCH, reason="PyTorch not installed")
def test_mps_preference_enables_cpu_fallback(monkeypatch):
    """Choosing an MPS device sets PYTORCH_ENABLE_MPS_FALLBACK for op safety."""
    import os

    monkeypatch.delenv("PYTORCH_ENABLE_MPS_FALLBACK", raising=False)
    device_mod.resolve_device(prefer="mps")
    assert os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK") == "1"


def test_empty_cache_is_safe_without_matching_device():
    """empty_cache() must never raise, even on CPU-only / no-torch setups."""
    device_mod.empty_cache()          # auto
    device_mod.empty_cache("cpu")     # explicit cpu -> no-op
