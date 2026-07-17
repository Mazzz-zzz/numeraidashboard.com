"""Cloud sync for the local training daemon.

Connects this machine to the hosted dashboard without any inbound network
path: the daemon polls the MCP endpoint's /daemon/poll route for work
(queued runs on `local` compute providers, cancellation requests) and pushes
status/log/metrics updates back through /daemon/report. Authentication is the
dashboard's existing X-API-Key mechanism, so every claim and report is scoped
to the key owner's records.

Enable by exporting before starting the daemon:

    NUMERAI_DASHBOARD_MCP_URL=https://<function-url>/
    NUMERAI_DASHBOARD_API_KEY=nd_mcp_...
    NUMERAI_LOCAL_SYNC_INTERVAL=20   # optional, seconds

The loop is deliberately boring: one thread, one HTTP request per phase,
errors logged and retried on the next tick. Disk remains the source of truth
for job state (the daemon's job dirs); the cloud is a mirror.
"""

from __future__ import annotations

import json
import os
import threading
import traceback
import urllib.error
import urllib.request
from pathlib import Path

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
DEFAULT_INTERVAL_SECONDS = 20.0
MIN_INTERVAL_SECONDS = 5.0


def sync_config_from_env(env: dict[str, str] | None = None) -> tuple[str, str, float] | None:
    """Return (base_url, api_key, interval) when cloud sync is configured."""
    env = env if env is not None else dict(os.environ)
    base_url = (env.get("NUMERAI_DASHBOARD_MCP_URL") or "").strip().rstrip("/")
    api_key = (env.get("NUMERAI_DASHBOARD_API_KEY") or "").strip()
    if not base_url or not api_key:
        return None
    try:
        interval = float(env.get("NUMERAI_LOCAL_SYNC_INTERVAL", DEFAULT_INTERVAL_SECONDS))
    except ValueError:
        interval = DEFAULT_INTERVAL_SECONDS
    return base_url, api_key, max(MIN_INTERVAL_SECONDS, interval)


def index_jobs(jobs_dir: Path) -> dict[str, list[dict]]:
    """Map runId -> local jobs (newest first) from the daemon's job dirs."""
    index: dict[str, list[dict]] = {}
    if not jobs_dir.exists():
        return index
    for job_dir in jobs_dir.iterdir():
        request = _read_json(job_dir / "request.json")
        if not request:
            continue
        run_id = str(request.get("runId") or "").strip()
        if not run_id:
            continue
        state = _read_json(job_dir / "status.json") or {}
        index.setdefault(run_id, []).append({
            "jobId": job_dir.name,
            "status": str(state.get("status") or "queued"),
            "mtime": _mtime(job_dir),
        })
    for jobs in index.values():
        jobs.sort(key=lambda j: j["mtime"], reverse=True)
    return index


def active_job_id(index: dict[str, list[dict]], run_id: str) -> str | None:
    """The newest non-terminal local job for a run, if any (claim dedupe)."""
    for job in index.get(run_id, []):
        if job["status"] not in TERMINAL_STATUSES:
            return job["jobId"]
    return None


def latest_job_id(index: dict[str, list[dict]], run_id: str) -> str | None:
    jobs = index.get(run_id, [])
    return jobs[0]["jobId"] if jobs else None


def report_fingerprint(action: dict) -> tuple:
    """Change detector so unchanged states are not re-reported every tick."""
    return (
        str(action.get("status") or ""),
        str(action.get("logTail") or "")[-500:],
        bool(action.get("metricsJson")),
    )


class CloudSync:
    """Poll → claim/cancel → report loop bridging the daemon and the cloud."""

    def __init__(self, daemon, base_url: str, api_key: str, jobs_dir: Path,
                 interval: float = DEFAULT_INTERVAL_SECONDS) -> None:
        self._daemon = daemon
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._jobs_dir = jobs_dir
        self._interval = interval
        self._stop = threading.Event()
        self._last_sent: dict[str, tuple] = {}

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        threading.Thread(target=self._loop, name="cloud-sync", daemon=True).start()
        print(f"[cloud-sync] enabled -> {self._base_url} (every {self._interval:.0f}s)")

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - sync must never kill the daemon
                traceback.print_exc()

    # -- one sync cycle -----------------------------------------------------

    def tick(self) -> None:
        work = self._post("/daemon/poll", {})
        if work is None:
            return
        index = index_jobs(self._jobs_dir)

        for launch in work.get("launches") or []:
            run_id = str(launch.get("runId") or "").strip()
            request = launch.get("request") or {}
            if not run_id or active_job_id(index, run_id):
                continue  # unknown or already claimed by this daemon
            result = self._daemon.launch({**request, "runId": run_id})
            print(f"[cloud-sync] claimed run {run_id} -> {result.get('providerJobId')}")
            self._send_report(run_id, result)
            index = index_jobs(self._jobs_dir)

        for cancel in work.get("cancels") or []:
            run_id = str(cancel.get("runId") or "").strip()
            if not run_id:
                continue
            job_id = str(cancel.get("providerJobId") or "") or latest_job_id(index, run_id)
            if not job_id or not (self._jobs_dir / job_id).exists():
                continue  # nothing local to stop; leave cloud state as-is
            result = self._daemon.cancel(job_id)
            print(f"[cloud-sync] cancelled run {run_id} ({job_id})")
            self._send_report(run_id, result)

        # Push progress for every run with a local job that isn't known-terminal.
        for run_id, jobs in index_jobs(self._jobs_dir).items():
            job = jobs[0]
            action = self._daemon.status(job["jobId"])
            fingerprint = report_fingerprint(action)
            if self._last_sent.get(run_id) == fingerprint:
                continue
            if self._send_report(run_id, action):
                self._last_sent[run_id] = fingerprint

    # -- HTTP ---------------------------------------------------------------

    def _send_report(self, run_id: str, action: dict) -> bool:
        return self._post("/daemon/report", {"runId": run_id, "action": action}) is not None

    def _post(self, path: str, body: dict) -> dict | None:
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=json.dumps(body, default=str).encode(),
            headers={"Content-Type": "application/json", "X-API-Key": self._api_key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode(errors="replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            print(f"[cloud-sync] {path} failed: HTTP {exc.code} {detail}")
        except Exception as exc:  # noqa: BLE001 - network blips are routine
            print(f"[cloud-sync] {path} unreachable: {exc}")
        return None


def maybe_start_cloud_sync(daemon, jobs_dir: Path) -> CloudSync | None:
    """Start the sync loop when env config is present; otherwise stay quiet."""
    config = sync_config_from_env()
    if not config:
        return None
    base_url, api_key, interval = config
    sync = CloudSync(daemon, base_url, api_key, jobs_dir, interval)
    sync.start()
    return sync


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0
