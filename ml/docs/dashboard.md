# ML Dashboard

The ML dashboard is accessible at the `/ml` tab in the OpenOptions frontend. It provides experiment management, training control, and real-time monitoring.

## Tabs

### Overview

The landing tab showing:
- **Active runs** — count of pending/running training jobs
- **Start Training** button — opens training config modal
- **Training progress** — for any active runs, shows:
  - Pulse animation indicating activity
  - Elapsed time since `started_at`
  - Cancel button
- **Recent runs** — last 10 runs with status, model type, correlation, Sharpe, timestamps

**Auto-polling**: When `active_runs > 0`, the dashboard polls `GET /api/ml/overview` every 5 seconds. Polling stops automatically when all runs complete.

### Experiments

Lists all experiments with:
- Experiment name and description
- Run count
- Best correlation and Sharpe across runs
- Status (active/archived)

Click an experiment to see its runs with full metrics.

### Models

Browse trained models with:
- Model name and type
- Validation metrics (correlation, Sharpe, feature exposure, max drawdown)
- S3 artifact path
- Associated experiment and run

### Rounds

Track Numerai tournament round results:
- Round number
- Submission correlation and Sharpe
- Submission ID and timestamp

## Training Config Modal

Opened by clicking "Start Training" on the Overview tab.

### Fields

| Field | Type | Options | Required |
|---|---|---|---|
| Experiment Name | Text input | Any string | Yes |
| Description | Text input | Any string | No |
| Feature Set | Dropdown | Small (42), Medium (705), All (2376) | Yes |
| Model Type | Dropdown | LightGBM | Yes |
| Instance Type | Dropdown | ml.m5.xlarge (4 vCPU, 16 GB), ml.m5.2xlarge (8 vCPU, 32 GB) | Yes |
| Hyperparameters | JSON textarea | e.g., `{"num_leaves": 256}` | No |

The hyperparameters textarea is hidden behind an "Advanced" toggle.

### Submission Flow

1. User fills form and clicks "Start Training"
2. Frontend calls `POST /api/ml/train` with `TrainRequest`
3. API creates experiment (if new), creates run, launches SageMaker job
4. Modal closes, Overview tab shows the new active run
5. Auto-polling starts (5s interval)

## Training Progress Component

Displayed on the Overview tab when there are active runs.

Shows for each active run:
- **Status indicator** — pulsing green dot
- **Elapsed time** — calculated from `started_at`
- **Cancel button** — calls `POST /api/ml/runs/{id}/cancel`

The progress component uses an indeterminate animation since precise step-level progress is updated every 60s by the poller (rather than continuously).

## Data Flow

```
User clicks "Start Training"
    │
    ▼
TrainConfigModal → POST /api/ml/train
    │
    ▼
API creates DB rows + launches SageMaker job
    │
    ▼
ml-stores.ts starts polling (5s interval)
    │
    ├─ GET /api/ml/overview → active_runs, recent_runs
    │
    └─ GET /api/ml/runs/{id}/metrics → epoch loss data
         │
         ▼
    Loss charts update (Plotly)
    Progress displays update
    │
    └─ When active_runs === 0 → polling stops
```

## Frontend Architecture

### Stores (`src/lib/ml-stores.ts`)

| Store | Type | Purpose |
|---|---|---|
| `trainingInProgress` | `writable<boolean>` | Whether a training submission is in flight |

Key functions:
- `triggerTraining(config)` — POST to /api/ml/train, starts polling
- `startPolling()` — 5s interval polling overview + experiments + models
- `stopPolling()` — clears interval

### Components

| Component | File | Purpose |
|---|---|---|
| `TrainConfigModal` | `src/lib/components/ml/TrainConfigModal.svelte` | Training configuration form |
| `TrainingProgress` | `src/lib/components/ml/TrainingProgress.svelte` | Active run progress display |

### API Client (`src/lib/api.ts`)

```typescript
interface TrainRequest {
  experiment_name: string;
  description?: string;
  feature_set: string;
  model_type: string;
  instance_type: string;
  hyperparams?: Record<string, unknown>;
}

interface TrainResponse {
  run_id: number;
  experiment_id: number;
  sagemaker_job_name: string;
}

// Methods on ApiClient class:
triggerTraining(body: TrainRequest): Promise<TrainResponse>
cancelTraining(runId: number): Promise<void>
```

## Svelte 5 Notes

The ML dashboard uses Svelte 5 runes:
- `$state()` for reactive local state
- `$derived` for computed values
- `$props()` for component props
- `onMount()` / `onDestroy()` for lifecycle

Event handlers use the Svelte 5 syntax:
```svelte
<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
```
