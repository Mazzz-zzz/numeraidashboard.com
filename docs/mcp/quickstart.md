# Quickstart

This walkthrough creates a small TabM model and routes it through MCP to a local Mac provider. It does not use Modal and does not call the daemon directly.

## 1. Connect with OAuth

Add the hosted endpoint to an MCP client that supports remote Streamable HTTP servers:

```text
https://lacdatamelsv55cio7jpnn5jxe0yvuvm.lambda-url.ap-southeast-2.on.aws/
```

Use OAuth when the client supports it. The client discovers the authorization server, opens the login and consent flow, and stores the resulting bearer token.

For a header-capable automation client, an MCP API key can be sent as:

```http
X-API-Key: nd_mcp_...
```

See [Authentication and safety](/security) for the API-key setup and ownership rules.

## 2. Find the local provider

Call `list_compute_providers`:

```json
{
  "provider_type": "local",
  "status": "available",
  "limit": 20
}
```

Keep the exact `id` from the Mac Studio provider. A local launch must use that ID and must omit `compute_type`.

## 3. Create a TabM draft

Call `create_model`:

```json
{
  "name": "Mac Studio TabM smoke",
  "model_type": "tabm",
  "template": "challenger",
  "run_config": {
    "mode": "train",
    "tournament": "classic",
    "feature_set": "small",
    "neutralization_pct": 25,
    "upload": false,
    "n_ensemble": 4,
    "batch_size": 1024,
    "max_train_eras": 2,
    "early_stopping_rounds": 10
  }
}
```

Verify that the returned model has:

```json
{
  "stage": "draft",
  "modelType": "tabm"
}
```

The response contains the `model.id` required for launch.

## 4. Launch on the Mac provider

Call `launch_model_training` with the returned model ID and local provider ID:

```json
{
  "model_id": "MODEL_ID_FROM_CREATE_MODEL",
  "provider_id": "LOCAL_PROVIDER_ID"
}
```

Do not include `compute_type`. A successful local handoff returns a queued action and creates a `TrainingRun` whose `configJson.model_type` is `tabm`.

## 5. Monitor the run

Call `poll_training_status` with the returned run ID:

```json
{
  "run_id": "RUN_ID_FROM_LAUNCH"
}
```

Expected progression:

```text
queued -> running -> completed
                    \-> failed
```

For local runs, polling reads the most recent state pushed by the worker. It does not start another job.

## Create a sweep

`create_model` can create independently launchable drafts from one parameter:

```json
{
  "name": "TabM ensemble sweep",
  "model_type": "tabm",
  "run_config": {
    "feature_set": "small",
    "batch_size": 1024,
    "max_train_eras": 2
  },
  "sweep": {
    "parameter": "n_ensemble",
    "values": [2, 4, 8],
    "max_runs": 3
  }
}
```

Each returned model has its own model ID and complete run configuration. Launch them individually so provider choice and spend remain explicit.
