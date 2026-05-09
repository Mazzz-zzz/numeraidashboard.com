#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -c "from sagemaker.launch_job import _package_source; from pathlib import Path; _package_source(Path('.'))"
curl -fsS -X POST https://7ia5onp99c.execute-api.ap-southeast-2.amazonaws.com/prod/api/ml/train \
  -H "Content-Type: application/json" \
  -d "$1"
