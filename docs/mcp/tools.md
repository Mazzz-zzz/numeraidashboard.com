# Tool reference

All tools operate on records owned by the authenticated dashboard user. IDs returned by list or create tools should be passed unchanged to action tools.

## Model tools

### `list_models`

Lists model registry items and each model's complete Builder `runConfig`.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `stage` | string | No | Filter by `draft`, `training`, `success`, `failed`, `testing`, `live`, or `retired`. |
| `limit` | integer | No | Result limit from 1 to 100. Default: 20. |

Read-only.

### `create_model`

Creates one Builder-compatible model draft. When `sweep` is supplied, creates one independent draft per selected value.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model_type` | string | Yes | Model type such as `tabm`, `lgbm`, or `ft_transformer`. |
| `name` | string | No | Base model name. A model-specific default is generated when omitted. |
| `run_config` | object | No | Complete model configuration. Arbitrary model-specific fields are preserved. |
| `change_summary` | string | No | Registry change summary. |
| `parent_model_id` | string | No | Owned parent model for lineage. |
| `template` | string | No | `baseline`, `challenger`, `ensemble`, or `custom`. Default: `custom`. |
| `sweep.parameter` | string | With sweep | Top-level `run_config` field varied by the sweep. |
| `sweep.values` | scalar[] | With sweep | One to 64 string, number, or boolean values. |
| `sweep.max_runs` | integer | No | Maximum drafts to create, from 1 to 64. |

Defaults are added for `mode`, `tournament`, `feature_set`, `neutralization_pct`, and `upload`. The explicit `model_type` must agree with any type already present in `run_config`.

This operation creates records and is not idempotent.

### `update_model`

Updates an owned model registry item and optionally replaces its complete run configuration.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model_id` | string | Yes | Owned model ID. |
| `name` | string | No | New non-empty model name. |
| `stage` | string | No | New lifecycle stage. |
| `change_summary` | string or null | No | New summary; `null` clears it. |
| `parent_model_id` | string or null | No | Owned parent ID; `null` clears it. |
| `numerai_model_id` | string or null | No | Linked Numerai model ID; `null` clears it. |
| `run_config` | object | No | Replacement run configuration; it must contain `model_type` or `modelType`. |

At least one editable field is required.

### `delete_model`

Permanently deletes one owned model registry item.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model_id` | string | Yes | Model ID to delete. |

This is destructive. Related training-run history is retained.

## Provider tools

### `list_compute_providers`

Lists safe provider metadata without returning credential references or secret values.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `provider_type` | string | No | `prime_intellect`, `modal`, `sagemaker`, `local`, or `custom`. |
| `status` | string | No | `available`, `planned`, or `disabled`. |
| `limit` | integer | No | Result limit from 1 to 100. Default: 20. |

Read-only.

## Training tools

### `list_training_runs`

Lists owned training runs, including configuration, status, metrics, cost, logs, and artifact URI when available.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | string | No | `queued`, `running`, `completed`, `failed`, or `cancelled`. |
| `limit` | integer | No | Result limit from 1 to 100. Default: 20. |

Read-only.

### `launch_model_training`

Creates a new training run from an owned model and launches it through the selected provider.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model_id` | string | Yes | Model returned by `create_model` or `list_models`. |
| `provider_id` | string | Yes | Provider returned by `list_compute_providers`. |
| `compute_type` | string | No | Modal-only compute selection. Never pass this for local providers. |
| `max_spend_usd` | number | No | Optional non-negative run budget. |

For local providers, this queues work for the normal worker. It does not invoke a cloud training mutation or connect to the workstation.

This operation creates a run and is not idempotent.

### `launch_training_run`

Launches an existing queued or failed training run.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `run_id` | string | Yes | Existing training run ID. |
| `provider_id` | string | No | Explicit owned provider override. Otherwise the run's provider is used. |
| `compute_type` | string | No | Modal-only compute type such as `cpu`, `t4`, `a10g`, `l4`, `a100`, or `h100`. |

Do not use this to create a run from a Builder draft; use `launch_model_training` instead.

### `poll_training_status`

Returns the latest action, run, and compute-job state and persists provider updates where applicable.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `run_id` | string | Yes | Training run ID. |

For local runs, this reads daemon-pushed state and never starts or polls a second local job.

### `cancel_run`

Cancels a queued or active training run.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `run_id` | string | Yes | Training run ID. |

This is destructive but idempotent while cancellation is being processed. For local work, the cancellation remains visible until the worker acts on it.

## Submission tools

### `list_submissions`

Lists owned Numerai model submission records.

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `model_id` | string | No | Filter by model ID. |
| `status` | string | No | Filter by submission status. |
| `limit` | integer | No | Result limit from 1 to 100. Default: 20. |

Read-only. Creating a new submission is not yet exposed through MCP.

## Error behavior

Tool failures return an MCP tool result with `isError: true` and a human-readable message. Common failures include:

- A record does not belong to the authenticated user.
- A provider is disabled.
- `compute_type` was supplied for a non-Modal provider.
- A model configuration has no model type.
- A run is already active or terminal.
- Required IDs are empty or do not exist.
