#!/usr/bin/env bash
#
# Make LightGBM find libomp on macOS without Homebrew.
#
# LightGBM's native lib (lib_lightgbm.dylib) needs libomp (OpenMP runtime). On
# macOS the standard install is `brew install libomp`. If you don't have
# Homebrew, PyTorch already ships a compatible libomp.dylib in its package — this
# script points LightGBM at it by adding torch's lib dir as an rpath (and
# re-signing the patched dylib). Idempotent; safe to re-run after upgrading
# lightgbm or torch.
#
# Usage:
#   PY=python3 ml/local/setup_libomp.sh        # or set PY to your daemon's python
#
set -euo pipefail

PY="${PY:-python3}"

if command -v brew >/dev/null 2>&1 && brew --prefix libomp >/dev/null 2>&1; then
	echo "[setup_libomp] Homebrew libomp already installed — nothing to do."
	exit 0
fi

# Locate lightgbm's native dylib without importing it (import would fail if
# libomp isn't resolvable yet).
LGBM_LIB="$("$PY" - <<'PYEOF'
import importlib.util, os
spec = importlib.util.find_spec("lightgbm")
if spec is None or not spec.origin:
    raise SystemExit("lightgbm is not installed for this interpreter")
print(os.path.join(os.path.dirname(spec.origin), "lib", "lib_lightgbm.dylib"))
PYEOF
)"

# Locate torch's bundled libomp dir.
TORCH_LIB="$("$PY" - <<'PYEOF'
import os
try:
    import torch
except Exception:
    raise SystemExit("torch is not installed for this interpreter")
d = os.path.join(os.path.dirname(torch.__file__), "lib")
if not os.path.exists(os.path.join(d, "libomp.dylib")):
    raise SystemExit("torch does not bundle libomp.dylib; install libomp via 'brew install libomp'")
print(d)
PYEOF
)"

echo "[setup_libomp] lightgbm dylib: $LGBM_LIB"
echo "[setup_libomp] torch libomp dir: $TORCH_LIB"

if otool -l "$LGBM_LIB" | grep -q "path $TORCH_LIB "; then
	echo "[setup_libomp] rpath already present — nothing to do."
	exit 0
fi

echo "[setup_libomp] adding rpath and re-signing..."
install_name_tool -add_rpath "$TORCH_LIB" "$LGBM_LIB"
codesign --force --sign - "$LGBM_LIB" 2>/dev/null || true

# Verify.
if "$PY" -c "import lightgbm; print('[setup_libomp] OK — lightgbm', lightgbm.__version__)" 2>/dev/null; then
	exit 0
fi
echo "[setup_libomp] still failing — install libomp with 'brew install libomp'." >&2
exit 1
