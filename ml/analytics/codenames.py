"""Load the canonical codename mapping from ~/numerai-ops/codenames.json."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Dict, List


@dataclass(frozen=True)
class Codename:
    codename: str
    legacy_name: str
    numerai_model_id: str
    architecture: str
    notes: str


def _ops_dir() -> Path:
    return Path(os.environ.get("NUMERAI_OPS_DIR", str(Path.home() / "numerai-ops")))


@lru_cache(maxsize=1)
def load_codenames() -> List[Codename]:
    path = _ops_dir() / "codenames.json"
    if not path.exists():
        raise FileNotFoundError(
            f"codenames.json not found at {path}. "
            f"Set NUMERAI_OPS_DIR to point at the numerai-ops directory."
        )
    raw = json.loads(path.read_text())
    return [
        Codename(
            codename=m["codename"],
            legacy_name=m["legacy_name"],
            numerai_model_id=m["numerai_model_id"],
            architecture=m.get("architecture", ""),
            notes=m.get("notes", ""),
        )
        for m in raw["models"]
    ]


def _by(field: str) -> Dict[str, Codename]:
    return {getattr(c, field): c for c in load_codenames()}


def by_codename(name: str) -> Codename:
    return _by("codename")[name]


def by_legacy_name(name: str) -> Codename:
    return _by("legacy_name")[name]


def by_uuid(uuid: str) -> Codename:
    return _by("numerai_model_id")[uuid]
