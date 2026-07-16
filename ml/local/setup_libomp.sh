#!/usr/bin/env bash
#
# Make LightGBM and XGBoost find libomp on macOS without Homebrew.
#
# Their native dylibs need libomp (OpenMP runtime). On macOS the standard
# install is `brew install libomp`. If Homebrew is unavailable, PyTorch already
# ships a compatible libomp.dylib; this script adds torch's lib directory as an
# rpath to each installed boosting library and re-signs the patched dylib.
# Idempotent; safe to re-run after upgrading LightGBM, XGBoost, or torch.
#
# Usage:
#   PY=python3 ml/local/setup_libomp.sh        # or set PY to your daemon's python
#
set -euo pipefail

PY="${PY:-python3}"

if command -v brew >/dev/null 2>&1; then
	BREW_LIBOMP="$(brew --prefix libomp 2>/dev/null || true)"
	if [[ -f "$BREW_LIBOMP/lib/libomp.dylib" ]]; then
		echo "[setup_libomp] Homebrew libomp already installed — nothing to do."
		exit 0
	fi
fi

# Locate installed native dylibs without importing their packages (imports fail
# while libomp is unresolved).
NATIVE_LIBS=()
while IFS= read -r native_lib; do
	[[ -n "$native_lib" ]] && NATIVE_LIBS+=("$native_lib")
done < <("$PY" - <<'PYEOF'
import importlib.util
import os

libraries = (
    ("lightgbm", "lib/lib_lightgbm.dylib"),
    ("xgboost", "lib/libxgboost.dylib"),
)
found = False
for package, relative_path in libraries:
    spec = importlib.util.find_spec(package)
    if spec is None or not spec.origin:
        continue
    path = os.path.join(os.path.dirname(spec.origin), relative_path)
    if os.path.exists(path):
        print(path)
        found = True
if not found:
    raise SystemExit("neither lightgbm nor xgboost is installed for this interpreter")
PYEOF
)

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

echo "[setup_libomp] torch libomp dir: $TORCH_LIB"
for native_lib in "${NATIVE_LIBS[@]}"; do
	echo "[setup_libomp] boosting dylib: $native_lib"
	if otool -l "$native_lib" | grep -q "path $TORCH_LIB "; then
		echo "[setup_libomp] rpath already present"
		continue
	fi
	echo "[setup_libomp] adding rpath and re-signing..."
	install_name_tool -add_rpath "$TORCH_LIB" "$native_lib"
	codesign --force --sign - "$native_lib" 2>/dev/null || true
done

# Verify every installed boosting package.
if "$PY" - <<'PYEOF'
import importlib
import importlib.util

for package in ("lightgbm", "xgboost"):
    if importlib.util.find_spec(package) is None:
        continue
    module = importlib.import_module(package)
    print(f"[setup_libomp] OK — {package} {module.__version__}")
PYEOF
then
	exit 0
fi
echo "[setup_libomp] still failing — install libomp with 'brew install libomp'." >&2
exit 1
