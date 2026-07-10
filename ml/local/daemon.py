#!/usr/bin/env python3
"""Local training daemon for the numeraidashboard frontend.

A tiny, dependency-free HTTP service you run on your own machine so the
dashboard's **local** compute provider can launch real training runs on this
box (including the Apple Silicon / MPS GPU). It mirrors the request/response
contract of the cloud provider adapters (Modal, Prime Intellect) so the UI
treats a local run like any other.

Why a daemon? The dashboard's `startTraining` runs in an AWS Lambda, which
cannot reach your laptop. The browser, however, runs on the same machine as
this daemon, so the frontend's local adapter talks to it directly over
127.0.0.1 — no cloud round-trip, no credentials, fully self-contained.

Endpoints (all JSON, CORS-enabled for local dev origins):
  GET  /health                     -> {ok, device, jobs}
  POST /launch  {runId, model_type, feature_set, neutralization_pct,
                 hyperparams, upload}
                                   -> {ok, status, providerJobId, ...}
  GET  /status?jobId=<id>          -> {ok, status, logTail, metricsJson, ...}
  POST /cancel  {jobId}            -> {ok, status: 'cancelled', ...}

Each job runs as a subprocess (this same file in `--run-job` mode) so a crash
or cancel never takes down the daemon. Job state and logs live on disk under
ml/output/local-jobs/<jobId>/ and survive a daemon restart.

In local dev the frontend's Vite dev server starts this automatically (see
frontend/vite.config.ts) and proxies it at same-origin `/local-daemon`, so
`npm run dev` is all you need. You can also run it standalone:

    cd ml
    python3 local/daemon.py                       # serve on 127.0.0.1:8787
    python3 local/daemon.py --port 9000

When run standalone, add a compute provider of type "local" in the dashboard
with base URL http://127.0.0.1:8787 and launch a model.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# ml/ package root (this file is ml/local/daemon.py). Put it on sys.path so the
# training/config/sagemaker packages import regardless of how we're launched.
ML_DIR = Path(__file__).resolve().parent.parent
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))
JOBS_DIR = ML_DIR / "output" / "local-jobs"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787

# Max training jobs that may run concurrently. One GPU, so keep the ceiling
# modest; downloads are serialized regardless (see data.download).
MAX_PARALLEL_CAP = 8


def _initial_max_parallel() -> int:
    try:
        return max(1, min(int(os.environ.get("NUMERAI_LOCAL_MAX_PARALLEL", "1")), MAX_PARALLEL_CAP))
    except ValueError:
        return 1

# Hyperparameter -> settings env var mapping and model-kwarg keys are the
# canonical ones defined by the local_runner; reuse them so behaviour matches.
try:
    from sagemaker.local_runner import HP_TO_ENV, MODEL_KWARGS_KEYS
except Exception:  # pragma: no cover - fallback if boto3/local_runner missing
    HP_TO_ENV = {"max_train_eras": "ML_MAX_TRAIN_ERAS", "num_rounds": "ML_DEFAULT_NUM_ROUNDS"}
    MODEL_KWARGS_KEYS = {
        "hidden_dims", "dropout", "noise_std", "weight_decay", "batch_size",
        "mixup_alpha", "swa", "warmup_epochs", "multi_head", "n_ensemble",
        "d_token", "n_blocks", "n_heads", "n_bags", "context_rows",
        "features_per_bag", "n_recent_eras", "n_estimators_per_bag",
        "norm_methods", "device", "offload_mode", "use_amp", "use_fa3",
    }


# ---------------------------------------------------------------------------
# Job directory helpers (on-disk source of truth)
# ---------------------------------------------------------------------------

def _job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, default=str))


def _log_tail(path: Path, max_chars: int = 4000) -> str | None:
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return None
    return text[-max_chars:] if len(text) > max_chars else text


def _safe_run_id(run_id: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in run_id)[:40]


# ---------------------------------------------------------------------------
# Job runner (subprocess entry point, invoked as `--run-job <dir>`)
# ---------------------------------------------------------------------------

def run_job(job_dir: Path) -> int:
    """Execute one training job. Reads request.json, writes status.json.

    Runs in its own process with stdout/stderr already redirected to run.log
    by the parent daemon.
    """
    sys.path.insert(0, str(ML_DIR))
    request = _read_json(job_dir / "request.json") or {}
    status_path = job_dir / "status.json"
    started_at = _now_iso()

    model_type = str(request.get("model_type") or "mlp")
    feature_set = str(request.get("feature_set") or "small")
    neutralization_pct = float(request.get("neutralization_pct", 25.0))
    upload = bool(request.get("upload", False))
    hyperparams = request.get("hyperparams") or {}
    if not isinstance(hyperparams, dict):
        hyperparams = {}

    def _status(status: str, **extra) -> None:
        _write_json(status_path, {
            "status": status,
            "startedAt": started_at,
            "checkedAt": _now_iso(),
            "pid": os.getpid(),  # let a restarted daemon find/kill an orphan
            **extra,
        })

    _status("running")

    # Map hyperparams onto ML_ settings env vars (same contract as local_runner)
    for hp_key, env_key in HP_TO_ENV.items():
        if hp_key in hyperparams:
            val = hyperparams[hp_key]
            os.environ[env_key] = json.dumps(val) if isinstance(val, (list, dict)) else str(val)
    model_kwargs = {k: v for k, v in hyperparams.items() if k in MODEL_KWARGS_KEYS}

    def progress_callback(info: dict) -> None:
        info = {**info, "compute": "local"}
        _write_json(job_dir / "progress.json", info)

    def epoch_callback(info: dict) -> None:
        _write_json(job_dir / "epochs.json", {**info, "compute": "local"})

    stop_gpu = threading.Event()
    _start_gpu_monitor(job_dir, stop_gpu)

    start = time.time()
    try:
        if feature_set.startswith("signals_"):
            from training.signals_trainer import run_signals_training
            metrics = run_signals_training(
                output_dir=str(job_dir / "output"),
                skip_download=False,
                upload=upload,
                progress_callback=progress_callback,
                epoch_callback=epoch_callback,
                model_type=model_type,
                neutralization_pct=neutralization_pct,
            )
        else:
            from training.trainer import run_training
            metrics = run_training(
                feature_set_name=feature_set,
                output_dir=str(job_dir / "output"),
                skip_download=False,
                upload=upload,
                progress_callback=progress_callback,
                epoch_callback=epoch_callback,
                model_type=model_type,
                neutralization_pct=neutralization_pct,
                model_kwargs=model_kwargs,
            )
        elapsed = round(time.time() - start, 1)
        metrics = {**(metrics or {}), "compute": "local", "elapsedSeconds": elapsed}
        artifact = str(job_dir / "output")
        _status("completed", finishedAt=_now_iso(), metricsJson=metrics, artifactUri=artifact)
        print(f"[local-daemon] job complete in {elapsed}s")
        return 0
    except Exception as exc:  # noqa: BLE001 - surface any training failure to the UI
        elapsed = round(time.time() - start, 1)
        _status(
            "failed",
            finishedAt=_now_iso(),
            error=str(exc),
            metricsJson={"compute": "local", "elapsedSeconds": elapsed},
        )
        print(f"[local-daemon] job FAILED after {elapsed}s: {exc}")
        traceback.print_exc()
        return 1
    finally:
        stop_gpu.set()


def _start_gpu_monitor(job_dir: Path, stop_event: threading.Event) -> None:
    """Sample this process's GPU memory into gpu.json every 2s until stopped.

    Runs inside the training subprocess: MPS/CUDA memory is per-process, so the
    daemon cannot observe the trainer's allocations directly — the trainer
    reports them here and the daemon surfaces the running job's file in /health.
    """
    def _loop() -> None:
        try:
            import torch
        except Exception:
            return
        has_cuda = torch.cuda.is_available()
        mps_backend = getattr(torch.backends, "mps", None)
        has_mps = hasattr(torch, "mps") and bool(mps_backend) and mps_backend.is_available()
        if not (has_cuda or has_mps):
            return
        mb = lambda b: round(b / (1024 * 1024))  # noqa: E731
        while not stop_event.wait(2.0):
            snap: dict = {}
            try:
                if has_cuda:
                    snap["allocatedMb"] = mb(torch.cuda.memory_allocated())
                    snap["driverMb"] = mb(torch.cuda.memory_reserved())
                else:
                    if hasattr(torch.mps, "current_allocated_memory"):
                        snap["allocatedMb"] = mb(torch.mps.current_allocated_memory())
                    if hasattr(torch.mps, "driver_allocated_memory"):
                        snap["driverMb"] = mb(torch.mps.driver_allocated_memory())
                _write_json(job_dir / "gpu.json", snap)
            except Exception:
                pass

    threading.Thread(target=_loop, name="gpu-monitor", daemon=True).start()


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class _Daemon:
    """Runs jobs one at a time via a FIFO worker; disk holds the truth.

    Training jobs are serialized deliberately: this box has a single GPU, and
    concurrent runs would otherwise race on the shared Numerai data cache
    (``ml/data_cache/``) and corrupt each other's downloads. Extra launches
    wait in a queue and start as the current job finishes.
    """

    def __init__(self) -> None:
        self._procs: dict[str, subprocess.Popen] = {}
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._lock = threading.Lock()
        # How many training jobs may run at once. Downloads are still serialized
        # (see data.download._download_lock); only training runs in parallel.
        self._slot = threading.Condition()
        self._active = 0
        self._max_parallel = _initial_max_parallel()
        _reconcile_orphans()
        threading.Thread(target=self._dispatch, name="job-dispatch", daemon=True).start()

    def launch(self, body: dict) -> dict:
        run_id = str(body.get("runId") or "").strip()
        if not run_id:
            return _result(ok=False, status="failed", error="runId is required")

        job_id = f"local-{_safe_run_id(run_id)}-{int(time.time())}"
        job_dir = _job_dir(job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        _write_json(job_dir / "request.json", body)
        _write_json(job_dir / "status.json", {"status": "queued", "checkedAt": _now_iso()})
        self._queue.put(job_id)

        with self._slot:
            waiting = max(0, self._active - self._max_parallel + self._queue.qsize())
        position = f" (queued, {waiting} ahead)" if waiting > 0 else ""
        return _result(
            ok=True,
            status="queued",
            provider_job_id=job_id,
            log_tail=f"Local training job {job_id} queued ({body.get('model_type', 'mlp')} / "
                     f"{body.get('feature_set', 'small')}){position}.",
        )

    def set_max_parallel(self, value: int) -> int:
        n = max(1, min(int(value), MAX_PARALLEL_CAP))
        with self._slot:
            self._max_parallel = n
            self._slot.notify_all()  # release waiters if capacity went up
        return n

    @property
    def max_parallel(self) -> int:
        return self._max_parallel

    def _dispatch(self) -> None:
        """Pull queued jobs and run up to `max_parallel` concurrently."""
        while True:
            job_id = self._queue.get()
            with self._slot:
                while self._active >= self._max_parallel:
                    self._slot.wait()
                self._active += 1
            threading.Thread(
                target=self._run_and_release, args=(job_id,), name=f"job-{job_id}", daemon=True
            ).start()

    def _run_and_release(self, job_id: str) -> None:
        try:
            self._run_one(job_id)
        except Exception:  # noqa: BLE001 - a job crash must not kill the daemon
            job_dir = _job_dir(job_id)
            if job_dir.exists():
                _write_json(job_dir / "status.json", {
                    "status": "failed", "error": "worker error", "checkedAt": _now_iso(),
                })
            traceback.print_exc()
        finally:
            with self._slot:
                self._active -= 1
                self._slot.notify_all()
            self._queue.task_done()

    def _run_one(self, job_id: str) -> None:
        job_dir = _job_dir(job_id)
        state = _read_json(job_dir / "status.json") or {}
        if state.get("status") == "cancelled":
            return  # cancelled while still queued — skip

        log_file = open(job_dir / "run.log", "w")  # noqa: SIM115 - held for subprocess lifetime
        env = {
            **os.environ,
            "PYTHONPATH": str(ML_DIR) + os.pathsep + os.environ.get("PYTHONPATH", ""),
            "PYTHONUNBUFFERED": "1",
            "PYTORCH_ENABLE_MPS_FALLBACK": os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK", "1"),
        }
        proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--run-job", str(job_dir)],
            cwd=str(ML_DIR),
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )
        with self._lock:
            self._procs[job_id] = proc
        try:
            proc.wait()
        finally:
            log_file.close()

    def status(self, job_id: str) -> dict:
        job_dir = _job_dir(job_id)
        if not job_dir.exists():
            return _result(ok=False, status="failed", provider_job_id=job_id,
                           error=f"Unknown job {job_id}")
        state = _read_json(job_dir / "status.json") or {"status": "queued"}
        status = str(state.get("status") or "queued")

        # Reconcile: process died without writing a terminal status -> failed.
        with self._lock:
            proc = self._procs.get(job_id)
        if status in ("queued", "running") and proc is not None and proc.poll() is not None:
            if proc.returncode != 0:
                status = "failed"
                state = {**state, "status": status, "error": state.get("error") or
                         f"Job process exited with code {proc.returncode}"}
                _write_json(job_dir / "status.json", state)

        return _result(
            ok=status != "failed",
            status=status,
            provider_job_id=job_id,
            log_tail=_log_tail(job_dir / "run.log"),
            error=state.get("error"),
            metrics_json=state.get("metricsJson"),
            artifact_uri=state.get("artifactUri"),
        )

    def cancel(self, job_id: str) -> dict:
        job_dir = _job_dir(job_id)
        with self._lock:
            proc = self._procs.get(job_id)
        if proc is not None and proc.poll() is None:
            try:
                proc.send_signal(signal.SIGTERM)
            except ProcessLookupError:
                pass
        if job_dir.exists():
            # Writing 'cancelled' also makes the worker skip it if still queued.
            state = _read_json(job_dir / "status.json") or {}
            _write_json(job_dir / "status.json", {**state, "status": "cancelled", "checkedAt": _now_iso()})
        return _result(ok=True, status="cancelled", provider_job_id=job_id,
                       log_tail=f"Cancelled local job {job_id}.")

    def job_count(self) -> int:
        with self._lock:
            running = sum(1 for p in self._procs.values() if p.poll() is None)
        return running + self._queue.qsize()

    def stats(self) -> dict:
        with self._lock:
            running = sum(1 for p in self._procs.values() if p.poll() is None)
        return {"running": running, "queued": self._queue.qsize(), "maxParallel": self._max_parallel}

    def _running_ids(self) -> list[str]:
        with self._lock:
            return [job_id for job_id, p in self._procs.items() if p.poll() is None]

    def gpu_snapshot(self) -> dict:
        """Summed GPU memory across all running jobs (each writes its gpu.json)."""
        alloc = driver = 0
        found = False
        for job_id in self._running_ids():
            snap = _read_json(_job_dir(job_id) / "gpu.json")
            if isinstance(snap, dict):
                if "allocatedMb" in snap:
                    alloc += snap["allocatedMb"]
                    found = True
                if "driverMb" in snap:
                    driver += snap["driverMb"]
                    found = True
        return {"allocatedMb": alloc, "driverMb": driver} if found else {}


def _make_handler(daemon: _Daemon):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args) -> None:  # quieter console
            pass

        def _send(self, payload: dict, code: int = 200) -> None:
            data = json.dumps(payload, default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                return json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                return {}

        def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib naming
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            route = urlparse(self.path)
            if route.path == "/health":
                self._send({
                    "ok": True, "jobs": daemon.job_count(),
                    **_gpu_stats(), **daemon.stats(), **daemon.gpu_snapshot(),
                })
            elif route.path == "/status":
                job_id = (parse_qs(route.query).get("jobId") or [""])[0]
                self._send(daemon.status(job_id))
            elif route.path == "/config":
                self._send({"ok": True, "maxParallel": daemon.max_parallel, "cap": MAX_PARALLEL_CAP})
            else:
                self._send({"ok": False, "error": "not found"}, code=404)

        def do_POST(self) -> None:  # noqa: N802
            route = urlparse(self.path)
            if route.path == "/launch":
                self._send(daemon.launch(self._body()))
            elif route.path == "/cancel":
                job_id = str(self._body().get("jobId") or "")
                self._send(daemon.cancel(job_id))
            elif route.path == "/config":
                value = self._body().get("maxParallel")
                if value is None:
                    self._send({"ok": False, "error": "maxParallel is required"}, code=400)
                else:
                    self._send({"ok": True, "maxParallel": daemon.set_max_parallel(value), "cap": MAX_PARALLEL_CAP})
            else:
                self._send({"ok": False, "error": "not found"}, code=404)

    return Handler


def _result(
    *,
    ok: bool,
    status: str,
    provider_job_id: str | None = None,
    log_tail: str | None = None,
    error: str | None = None,
    metrics_json: dict | None = None,
    artifact_uri: str | None = None,
) -> dict:
    """Build the TrainingActionResult-shaped payload the frontend expects."""
    return {
        "ok": ok,
        "status": status,
        "providerJobId": provider_job_id,
        "checkedAt": _now_iso(),
        "logTail": log_tail,
        "error": error,
        "costUsd": None,
        "metricsJson": metrics_json,
        "artifactUri": artifact_uri,
    }


def _resolve_device() -> str:
    try:
        sys.path.insert(0, str(ML_DIR))
        from config.device import resolve_device_str
        return resolve_device_str()
    except Exception:
        return "unknown"


def _gpu_stats() -> dict:
    """Best-effort device + memory info for the dashboard's GPU strip."""
    device = _resolve_device()
    stats: dict = {"device": device}
    try:
        import torch
        stats["torch"] = torch.__version__
        mb = lambda b: round(b / (1024 * 1024))  # noqa: E731
        if device == "mps" and hasattr(torch, "mps"):
            stats["chip"] = _mac_chip_name()
            for key, fn in (
                ("allocatedMb", getattr(torch.mps, "current_allocated_memory", None)),
                ("driverMb", getattr(torch.mps, "driver_allocated_memory", None)),
                ("recommendedMaxMb", getattr(torch.mps, "recommended_max_memory", None)),
            ):
                try:
                    if fn is not None:
                        stats[key] = mb(fn())
                except Exception:
                    pass
        elif device.startswith("cuda") and torch.cuda.is_available():
            try:
                stats["chip"] = torch.cuda.get_device_name(0)
                stats["allocatedMb"] = mb(torch.cuda.memory_allocated())
                stats["recommendedMaxMb"] = mb(torch.cuda.get_device_properties(0).total_memory)
            except Exception:
                pass
    except Exception:
        pass
    return stats


def _mac_chip_name() -> str | None:
    try:
        out = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True, text=True, timeout=1,
        )
        name = out.stdout.strip()
        return name or None
    except Exception:
        return None


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _reconcile_orphans() -> None:
    """Fail jobs left 'running'/'queued' by a previous daemon.

    A freshly started daemon has nothing in flight, so any job still marked
    running or queued on disk belongs to a dead process (e.g. the daemon was
    restarted mid-run). Left alone it would report 'running' forever and pin the
    dashboard model at the 'training' stage.
    """
    if not JOBS_DIR.exists():
        return
    for job_dir in JOBS_DIR.iterdir():
        state = _read_json(job_dir / "status.json")
        if state and state.get("status") in ("running", "queued"):
            # Kill the orphaned training process if it's somehow still alive.
            pid = state.get("pid")
            if isinstance(pid, int):
                try:
                    os.kill(pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
            _write_json(job_dir / "status.json", {
                **state,
                "status": "failed",
                "error": state.get("error") or "Interrupted — the local daemon was restarted.",
                "checkedAt": _now_iso(),
                "finishedAt": _now_iso(),
            })


def serve(host: str, port: int) -> None:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    daemon = _Daemon()
    server = ThreadingHTTPServer((host, port), _make_handler(daemon))
    print(f"[local-daemon] serving on http://{host}:{port} (device={_resolve_device()})")
    print(f"[local-daemon] jobs dir: {JOBS_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[local-daemon] shutting down")
        server.shutdown()


def main() -> None:
    parser = argparse.ArgumentParser(description="Local training daemon for numeraidashboard")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--run-job", metavar="JOB_DIR", default=None,
                        help="Internal: execute a single job dir (used by the daemon).")
    args = parser.parse_args()

    if args.run_job:
        sys.exit(run_job(Path(args.run_job)))
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
