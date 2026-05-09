#!/usr/bin/env python3
"""Seed the local_runs table from a local_runs.json artifact.

Usage (from backend/ directory, with DB env vars set):
    python -m scripts.seed_local_runs path/to/local_runs.json

Idempotent: rows are upserted by (sweep, name, neut_pct). Re-running with the
same file overwrites the existing rows in place. Ideal for picking up new
inference passes without polluting the table with duplicates.

This script does NOT create the table — apply migrations/005_local_runs.sql
first.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Allow running as a module from the backend root: `python -m scripts.seed_local_runs`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy.dialects.postgresql import insert as pg_insert  # type: ignore

from app.database import SessionLocal
from app.models import LocalRun


def _to_record(row: dict[str, Any]) -> dict[str, Any]:
    hp = row.get("hyperparams")
    return {
        "sweep": row["sweep"],
        "name": row["name"],
        "family": row["family"],
        "model_type": row.get("model_type") or row["family"],
        "status": row.get("status") or "OK",
        "target": row.get("target"),
        "elapsed_seconds": row.get("elapsed_seconds"),
        "neut_pct": float(row["neut_pct"]),
        "correlation": row.get("correlation"),
        "sharpe": row.get("sharpe"),
        "mmc": row.get("mmc"),
        "feature_exposure": row.get("feature_exposure"),
        "max_drawdown": row.get("max_drawdown"),
        "hyperparams_json": json.dumps(hp, separators=(",", ":")) if hp else None,
        "sweep_dir": row.get("sweep_dir"),
        "source": row.get("source"),
    }


def seed(json_path: Path, dry_run: bool = False) -> int:
    with open(json_path) as f:
        payload = json.load(f)

    raw_rows = payload.get("rows") or payload  # tolerate either shape
    records = [_to_record(r) for r in raw_rows]

    print(f"Loaded {len(records)} rows from {json_path}")
    print(f"Sweeps: {sorted({r['sweep'] for r in records})}")
    print(f"Families: {sorted({r['family'] for r in records})}")
    if dry_run:
        print("[dry run] not writing to DB")
        for r in records[:3]:
            print(f"  example: {r['sweep']}/{r['name']} neut={r['neut_pct']}%  corr={r['correlation']}")
        return len(records)

    db = SessionLocal()
    try:
        # Postgres ON CONFLICT upsert keyed on the unique index
        # ix_local_runs_unique = (sweep, name, neut_pct).
        stmt = pg_insert(LocalRun.__table__).values(records)
        update_cols = {
            c.name: c
            for c in stmt.excluded
            if c.name not in ("id", "sweep", "name", "neut_pct", "inserted_at")
        }
        stmt = stmt.on_conflict_do_update(
            index_elements=["sweep", "name", "neut_pct"],
            set_=update_cols,
        )
        db.execute(stmt)
        db.commit()
        print(f"Upserted {len(records)} rows into local_runs")
    except Exception as e:
        db.rollback()
        print(f"ERROR: {e}", file=sys.stderr)
        raise
    finally:
        db.close()

    return len(records)


def main():
    parser = argparse.ArgumentParser(description="Seed local_runs table")
    parser.add_argument("json_path", type=Path, help="Path to local_runs.json")
    parser.add_argument("--dry-run", action="store_true", help="Parse but don't write to DB")
    args = parser.parse_args()

    if not args.json_path.exists():
        print(f"File not found: {args.json_path}", file=sys.stderr)
        sys.exit(1)

    seed(args.json_path, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
