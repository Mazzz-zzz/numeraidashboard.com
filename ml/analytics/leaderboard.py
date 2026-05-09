"""Local leaderboard: fetch live perf for every codenamed model and rank.

Run from the OpenOptions repo root:
    python3 -m ml.analytics.leaderboard
    python3 -m ml.analytics.leaderboard --metric mmc60
    python3 -m ml.analytics.leaderboard --json
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

logging.getLogger("numerapi.base_api").setLevel(logging.ERROR)

from ml.analytics.codenames import load_codenames

METRICS = ["canon_corr", "canon_mmc", "corr60", "mmc60", "cort20", "v2_corr20", "fnc_v3"]


def _read_env_credentials() -> tuple[str, str]:
    public = os.environ.get("ML_NUMERAI_PUBLIC_ID")
    secret = os.environ.get("ML_NUMERAI_SECRET_KEY")
    if public and secret:
        return public, secret
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("ML_NUMERAI_PUBLIC_ID="):
                public = line.split("=", 1)[1].strip()
            elif line.startswith("ML_NUMERAI_SECRET_KEY="):
                secret = line.split("=", 1)[1].strip()
    if not (public and secret):
        sys.exit("Missing ML_NUMERAI_PUBLIC_ID / ML_NUMERAI_SECRET_KEY")
    return public, secret


def fetch_latest_metrics() -> list[dict]:
    """For each codenamed model, return the latest day's value of each metric."""
    from numerapi import NumerAPI

    public, secret = _read_env_credentials()
    napi = NumerAPI(public_id=public, secret_key=secret)

    out = []
    for c in load_codenames():
        rounds = napi.round_model_performances_v2(c.numerai_model_id)
        rounds = sorted(rounds, key=lambda r: r["roundNumber"], reverse=True)
        latest = {}
        latest_round = None
        latest_day = None
        for r in rounds:
            for s in (r.get("submissionScores") or []):
                dn = s["displayName"]
                key = (r["roundNumber"], s["day"])
                if dn not in latest or key > (latest[dn]["round"], latest[dn]["day"]):
                    latest[dn] = {
                        "value": s["value"],
                        "round": r["roundNumber"],
                        "day": s["day"],
                        "percentile": s.get("percentile"),
                    }
            if rounds and latest_round is None:
                latest_round = r["roundNumber"]
                latest_day = max((s["day"] for s in (r.get("submissionScores") or [])), default=None)

        row = {
            "codename": c.codename,
            "legacy_name": c.legacy_name,
            "architecture": c.architecture,
            "round": latest_round,
            "day": latest_day,
        }
        for m in METRICS:
            row[m] = latest.get(m, {}).get("value")
            row[f"{m}_pctile"] = latest.get(m, {}).get("percentile")
        out.append(row)
    return out


def print_leaderboard(rows: list[dict], sort_by: str) -> None:
    rows = sorted(rows, key=lambda r: (r.get(sort_by) or -1e9), reverse=True)
    cols = ["canon_corr", "canon_mmc", "corr60", "mmc60", "cort20", "fnc_v3"]
    header = f"{'rank':>4}  {'codename':<11} {'rnd':>5} {'d':>2}  " + "  ".join(f"{c:>10}" for c in cols)
    print(header)
    print("-" * len(header))
    for i, r in enumerate(rows, 1):
        marker = " *" if r.get(sort_by) is not None and r.get(sort_by) == max(
            (x.get(sort_by) for x in rows if x.get(sort_by) is not None), default=None
        ) else "  "
        cells = []
        for c in cols:
            v = r.get(c)
            cells.append(f"{v:+.4f}" if isinstance(v, (int, float)) else "    -    ")
        rnd = r.get("round") if r.get("round") is not None else "-"
        day = r.get("day") if r.get("day") is not None else "-"
        print(f"{i:>3}{marker} {r['codename']:<11} {rnd:>5} {day:>2}  " + "  ".join(f"{c:>10}" for c in cells))
    print(f"\nSorted by: {sort_by}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metric", default="canon_mmc", choices=METRICS,
                        help="Metric to sort by (default: canon_mmc)")
    parser.add_argument("--json", action="store_true",
                        help="Emit JSON instead of a table")
    args = parser.parse_args()

    rows = fetch_latest_metrics()
    if args.json:
        print(json.dumps(rows, indent=2, default=str))
    else:
        print_leaderboard(rows, args.metric)


if __name__ == "__main__":
    main()
