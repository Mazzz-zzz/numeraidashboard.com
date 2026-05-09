"""Local analytics for the codenamed Numerai models on the wish account.

Reads the canonical codename mapping from ~/numerai-ops/codenames.json
(override via NUMERAI_OPS_DIR env var) and provides utilities to compare
model performance.
"""
from ml.analytics.codenames import (
    Codename,
    by_codename,
    by_legacy_name,
    by_uuid,
    load_codenames,
)

__all__ = [
    "Codename",
    "by_codename",
    "by_legacy_name",
    "by_uuid",
    "load_codenames",
]
