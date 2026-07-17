# Local training daemon

`daemon.py` runs real training jobs on this machine (Apple Silicon MPS or
CUDA) for the dashboard's **local** compute provider. Disk is the source of
truth: each job lives under `ml/output/local-jobs/<jobId>/` with its request,
status, logs, and artifacts.

## Two ways the daemon receives work

1. **Browser (local dev).** `npm run dev` starts the daemon automatically and
   the frontend's local adapter calls it over `127.0.0.1` — no cloud involved.
2. **Cloud sync (hosted dashboard / MCP).** With two environment variables
   set, the daemon also polls the hosted MCP endpoint for work and pushes
   status back — outbound-only, no ports exposed, no Tailscale required:

   ```sh
   export NUMERAI_DASHBOARD_MCP_URL=https://<mcp-function-url>/
   export NUMERAI_DASHBOARD_API_KEY=nd_mcp_...   # from `npm run mcp:key`
   cd ml && python3 local/daemon.py
   ```

   Every ~20s (`NUMERAI_LOCAL_SYNC_INTERVAL` to change) the daemon:
   - claims **queued** runs whose provider has type `local` and launches them;
   - stops jobs whose run was **cancelled** from the dashboard or an agent;
   - reports status, log tail, metrics, and artifact paths back, so the web
     UI and MCP tools (`poll_training_status`, `list_training_runs`) show
     live local state from anywhere.

   Claims are deduplicated against the on-disk job index, so restarting the
   daemon never double-launches a run. Run this on one machine per API key.

## Always-on with launchd (Mac Studio)

```sh
cd ml/local/launchd
sed -e "s|__REPO__|$(git rev-parse --show-toplevel)|g" \
    -e "s|__PYTHON__|$(command -v python3)|g" \
    com.numeraidashboard.local-daemon.plist \
  > ~/Library/LaunchAgents/com.numeraidashboard.local-daemon.plist
# then edit ~/Library/LaunchAgents/...plist to set your real API key
launchctl load ~/Library/LaunchAgents/com.numeraidashboard.local-daemon.plist
tail -f /tmp/numeraidashboard-local-daemon.log
```

`launchctl unload …` stops it; `KeepAlive` restarts it after crashes and at
login. Use the venv python that has torch installed for `__PYTHON__`.

## Cloud contract

The daemon talks to two authenticated routes on the MCP Lambda
(`frontend/amplify/functions/mcp-server/`):

- `POST /daemon/poll` → `{launches: [{runId, providerId, request}], cancels:
  [{runId, providerJobId}]}` — owner-scoped via the API key.
- `POST /daemon/report` `{runId, action}` — persists a
  `TrainingActionResult`-shaped update to the run and its compute job.

The `request` payload mirrors the browser adapter
(`frontend/src/lib/services/local-training-service.ts`): `model_type`,
`feature_set`, `neutralization_pct`, `hyperparams`, `upload`, derived from the
run's `configJson` (optionally nested under a `local` key).
