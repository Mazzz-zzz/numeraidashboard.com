"""Tests for the daemon's cloud sync loop (ml/local/cloud_sync.py)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ML_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ML_DIR / "local"))

from cloud_sync import (  # noqa: E402
    CloudSync,
    active_job_id,
    index_jobs,
    latest_job_id,
    report_fingerprint,
    sync_config_from_env,
)


def _write_job(jobs_dir: Path, job_id: str, run_id: str, status: str) -> None:
    job_dir = jobs_dir / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "request.json").write_text(json.dumps({"runId": run_id}))
    (job_dir / "status.json").write_text(json.dumps({"status": status}))


class FakeDaemon:
    def __init__(self, jobs_dir: Path) -> None:
        self.jobs_dir = jobs_dir
        self.launched: list[dict] = []
        self.cancelled: list[str] = []

    def launch(self, body: dict) -> dict:
        self.launched.append(body)
        job_id = f"local-{body['runId']}-1"
        _write_job(self.jobs_dir, job_id, body["runId"], "queued")
        return {"ok": True, "status": "queued", "providerJobId": job_id}

    def cancel(self, job_id: str) -> dict:
        self.cancelled.append(job_id)
        return {"ok": True, "status": "cancelled", "providerJobId": job_id}

    def status(self, job_id: str) -> dict:
        state = json.loads((self.jobs_dir / job_id / "status.json").read_text())
        return {"ok": True, "status": state["status"], "providerJobId": job_id}


def _sync_with_work(daemon: FakeDaemon, jobs_dir: Path, work: dict) -> tuple[CloudSync, list]:
    sync = CloudSync(daemon, "https://mcp.example.com", "nd_mcp_key", jobs_dir)
    posts: list = []

    def fake_post(path: str, body: dict):
        posts.append((path, body))
        return work if path == "/daemon/poll" else {}

    sync._post = fake_post  # type: ignore[method-assign]
    return sync, posts


def test_sync_config_requires_url_and_key():
    assert sync_config_from_env({}) is None
    assert sync_config_from_env({"NUMERAI_DASHBOARD_MCP_URL": "https://x/"}) is None
    config = sync_config_from_env({
        "NUMERAI_DASHBOARD_MCP_URL": "https://x/",
        "NUMERAI_DASHBOARD_API_KEY": "nd_mcp_abc",
        "NUMERAI_LOCAL_SYNC_INTERVAL": "1",
    })
    assert config == ("https://x", "nd_mcp_abc", 5.0)  # clamped to the minimum


def test_index_prefers_active_jobs_for_claim_dedupe(tmp_path):
    _write_job(tmp_path, "local-run-a-1", "run-a", "failed")
    _write_job(tmp_path, "local-run-a-2", "run-a", "running")
    index = index_jobs(tmp_path)
    assert active_job_id(index, "run-a") == "local-run-a-2"
    assert active_job_id(index, "run-missing") is None
    assert latest_job_id(index, "run-a") in {"local-run-a-1", "local-run-a-2"}


def test_tick_claims_launches_once_and_reports(tmp_path):
    daemon = FakeDaemon(tmp_path)
    work = {"launches": [{"runId": "run-a", "request": {"model_type": "lgbm"}}], "cancels": []}
    sync, posts = _sync_with_work(daemon, tmp_path, work)

    sync.tick()
    assert [b["runId"] for b in daemon.launched] == ["run-a"]
    reports = [body for path, body in posts if path == "/daemon/report"]
    assert reports and reports[0]["runId"] == "run-a"

    sync.tick()  # run-a now has an active local job -> no double launch
    assert len(daemon.launched) == 1


def test_tick_cancels_running_local_job(tmp_path):
    daemon = FakeDaemon(tmp_path)
    _write_job(tmp_path, "local-run-b-1", "run-b", "running")
    work = {"launches": [], "cancels": [{"runId": "run-b", "providerJobId": "local-run-b-1"}]}
    sync, posts = _sync_with_work(daemon, tmp_path, work)

    sync.tick()
    assert daemon.cancelled == ["local-run-b-1"]
    assert any(path == "/daemon/report" and body["action"]["status"] == "cancelled"
               for path, body in posts)


def test_tick_skips_unchanged_status_reports(tmp_path):
    daemon = FakeDaemon(tmp_path)
    _write_job(tmp_path, "local-run-c-1", "run-c", "running")
    sync, posts = _sync_with_work(daemon, tmp_path, {"launches": [], "cancels": []})

    sync.tick()
    sync.tick()
    reports = [1 for path, _ in posts if path == "/daemon/report"]
    assert len(reports) == 1  # second tick: fingerprint unchanged, no re-report


def test_fingerprint_tracks_meaningful_change():
    base = {"status": "running", "logTail": "epoch 1", "metricsJson": None}
    assert report_fingerprint(base) == report_fingerprint(dict(base))
    assert report_fingerprint(base) != report_fingerprint({**base, "logTail": "epoch 2"})
    assert report_fingerprint(base) != report_fingerprint({**base, "status": "completed"})
