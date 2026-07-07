"""Torch device resolution for Numerai models.

Picks the best available accelerator in priority order
``CUDA -> MPS (Apple Silicon) -> CPU`` so the same model code runs
GPU-accelerated on NVIDIA boxes *and* on Apple Silicon Macs without any
per-machine edits. Previously every model hard-coded
``torch.device("cuda" if torch.cuda.is_available() else "cpu")``, which
silently fell back to CPU on Macs and ignored the Metal (MPS) GPU entirely.

The choice can be forced with the ``NUMERAI_TORCH_DEVICE`` environment
variable (e.g. ``cpu``, ``cuda``, ``cuda:1``, ``mps``).

Notes on MPS (Metal Performance Shaders):
  - The Apple GPU only supports float32 (not float64). All model tensors in
    this package are already built as ``torch.float32``, so this is safe.
  - Not every torch op has an MPS kernel yet. We set
    ``PYTORCH_ENABLE_MPS_FALLBACK=1`` so unsupported ops transparently fall
    back to CPU instead of raising.
"""

from __future__ import annotations

import os
from typing import Optional

DEVICE_ENV_VAR = "NUMERAI_TORCH_DEVICE"


def _mps_ready(torch) -> bool:
    """True when a usable Apple Silicon (MPS) backend is present."""
    backend = getattr(torch.backends, "mps", None)
    if backend is None:
        return False
    try:
        return bool(backend.is_built()) and bool(backend.is_available())
    except Exception:
        return False


def _configure_mps() -> None:
    """Enable CPU fallback for ops without an MPS kernel (idempotent)."""
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def resolve_device(prefer: Optional[str] = None):
    """Return the best available ``torch.device``.

    Resolution order: explicit ``prefer`` arg -> ``NUMERAI_TORCH_DEVICE`` env
    var -> CUDA -> MPS -> CPU.

    Raises ``ImportError`` if torch is not installed — callers that treat
    torch as optional should guard the import themselves.
    """
    import torch

    choice = prefer or os.environ.get(DEVICE_ENV_VAR)
    if choice:
        choice = choice.strip()
        if choice.startswith("mps"):
            _configure_mps()
        return torch.device(choice)

    if torch.cuda.is_available():
        return torch.device("cuda")
    if _mps_ready(torch):
        _configure_mps()
        return torch.device("mps")
    return torch.device("cpu")


def resolve_device_str(prefer: Optional[str] = None) -> str:
    """Like :func:`resolve_device` but returns the device as a string.

    Useful for libraries (TabPFN, TabICL) whose APIs take a device *string*
    such as ``"cuda"`` / ``"mps"`` / ``"cpu"`` rather than a ``torch.device``.
    Returns ``"cpu"`` if torch is unavailable.
    """
    try:
        return str(resolve_device(prefer))
    except ImportError:
        return "cpu"


def empty_cache(device=None) -> None:
    """Release cached accelerator memory for the given device (best effort).

    Mirrors ``torch.cuda.empty_cache()`` but also handles MPS via
    ``torch.mps.empty_cache()``. No-op on CPU or when torch is absent.
    """
    try:
        import torch
    except ImportError:
        return

    dev = str(device) if device is not None else ""
    want_cuda = dev.startswith("cuda") or (not dev and torch.cuda.is_available())
    want_mps = dev.startswith("mps") or (not dev and _mps_ready(torch))

    if want_cuda and torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif want_mps and hasattr(torch, "mps"):
        torch.mps.empty_cache()
