# Local training

Local training uses a queue-and-claim design because the hosted MCP Lambda cannot and should not connect to a user's localhost daemon.

## Handoff sequence

1. The MCP client calls `launch_model_training` with a provider whose `providerType` is `local`.
2. The control plane creates an owned `TrainingRun` and leaves it in `queued` state.
3. The normal workstation worker polls the authenticated daemon work feed.
4. The worker derives its launch request from the complete run configuration.
5. The worker launches the model locally and reports running, completed, failed, or cancelled state.
6. MCP and the web UI read that reported state from the same run.

## Configuration forwarding

The worker request separates routing fields from model hyperparameters.

Routing fields include:

- `mode`
- `tournament`
- `model_type`
- `feature_set`
- `neutralization_pct`
- `upload`

Every other top-level Builder field is forwarded as a model hyperparameter. An explicit `hyperparams` object overrides inferred fields with the same name.

This preserves model-specific settings such as:

- TabM ensemble size and hidden dimensions.
- Neural batch size, dropout, and weight decay.
- Transformer token and attention settings.
- Foundation-model context and inference settings.
- Boosting rounds, depth, leaves, and sampling fractions.

Registry bookkeeping such as `modelId`, `modelName`, and `sweep` is not forwarded as a hyperparameter.

## Safe local launch checklist

- `list_compute_providers` returns the intended provider with `providerType: local`.
- `create_model` returns `modelType: tabm` for a TabM test.
- `launch_model_training` uses the exact local provider ID.
- The launch input does not contain `compute_type`.
- The created run contains `configJson.model_type: tabm`.
- The action initially returns `queued`.
- Later status/log updates come from the normal workstation worker.

## Cancellation

Calling `cancel_run` marks the run cancelled in the hosted control plane. The worker sees that cancellation on its normal polling cycle and stops the corresponding local job. A racing non-terminal worker update cannot resurrect a cancelled run.

## Troubleshooting

### The run stays queued

- Confirm the local provider is `available` and not disabled.
- Confirm the normal worker is running and polling with a valid MCP API key.
- Check the provider heartbeat shown in dashboard settings.
- Confirm the run's `providerId` matches the local provider.

### The wrong model starts

- Inspect `list_models` and confirm the selected model's `modelType`.
- Inspect the launch result and confirm `run.configJson.model_type`.
- Do not reuse an old run ID from a different experiment.

### A Modal error appears

The wrong provider was selected or a stale run retained a Modal provider. Select the local provider explicitly with `launch_model_training`. Never pass `compute_type` for local work.
