# Numerai Dashboard MCP

The Numerai Dashboard MCP is the authenticated agent control plane for model drafts, compute providers, training runs, and submission history.

```text
https://lacdatamelsv55cio7jpnn5jxe0yvuvm.lambda-url.ap-southeast-2.on.aws/
```

It uses Streamable HTTP and supports OAuth 2.1 or a dashboard MCP API key.

## What it controls

- Create, inspect, update, and delete model registry items.
- Expand one Builder configuration into a bounded model sweep.
- Discover the authenticated user's compute providers.
- Create and launch training runs from any supported model type.
- Poll or cancel training runs.
- Read owned submission history.

The current model catalog includes LightGBM, XGBoost, CatBoost, MLP, FT-Transformer, ModernNCA, TabM, TabPFN, and TabICL. Model-specific fields are preserved in `run_config` rather than restricted to a common hyperparameter subset.

## Control flow

```text
MCP client
  -> create_model
  -> list_compute_providers
  -> launch_model_training
  -> TrainingRun queued for selected provider
  -> poll_training_status
```

For a `local` provider, the hosted MCP does not connect to the workstation. The normal workstation worker polls the control plane, claims the queued run, and reports status and logs back to the same run.

```text
MCP -> hosted control plane -> queued local run
                                ^          |
                                |          v
                           status/logs <- Mac worker
```

## Important routing rules

> Selecting a local provider never falls back to Modal.

- Choose the provider returned by `list_compute_providers`; do not infer a provider from its name.
- Omit `compute_type` for local providers. That field is accepted only for Modal.
- Do not call workstation daemon endpoints directly. Queue with MCP and let the normal worker claim the run.
- Check the returned model's `modelType` and the run's `configJson.model_type` before treating a launch as valid.

## Current parity boundary

The MCP covers the Builder/model lifecycle and training control needed for agent-run experiments. Provider credential editing, Numerai account editing, passkey registration, and submission creation are not yet exposed as MCP tools. Those operations remain in the authenticated web UI.

Continue with the [quickstart](/quickstart) or see the complete [tool reference](/tools).
