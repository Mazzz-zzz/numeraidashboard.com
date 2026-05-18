# numeraidashboard.com

Web dashboard for building, training, and managing Numerai models.

## Layout

| Path        | What it is                                                                 |
| ----------- | -------------------------------------------------------------------------- |
| `frontend/` | SvelteKit app (TypeScript, Vite, static adapter). Production frontend.     |
| `frontend/amplify/` | AWS Amplify Gen 2 backend — Cognito auth + owner-scoped data models. |
| `backend/`  | Legacy FastAPI / SAM service. Reference only; being replaced by Amplify.   |
| `ml/`       | Python ML pipeline — training, analytics, SageMaker entry points.          |
| `amplify.yml` | Amplify Hosting build spec (builds `frontend/`).                         |

## Run the frontend

```sh
cd frontend
npm install
npm run dev
```

Build:

```sh
npm run build
```

## Amplify backend (auth + data)

From `frontend/`:

```sh
npm run sandbox        # watch mode
npm run sandbox:once   # one-shot deploy
```

Auth is Cognito email + passkey. Data models (pipelines, branches, sweeps, runs,
model registry, compute providers, compute jobs) use owner authorization, so each
signed-in user only sees their own workspace.

The signed-in routes (`/builder`, `/models`, `/compute`) are gated on auth state
and hidden from the nav until login. The homepage (`/`) is public.

## ML pipeline

See `ml/README.md`.

## What's next

Honest backlog. Anything checked is shipped on `main`.

### Foundation

- [x] Cognito email + passkey auth wired through `/login`.
- [x] Owner-scoped Amplify Data models for pipelines, branches, sweeps, runs, registry, providers, jobs.
- [x] `NumeraiAccount` model + `/settings` flow canvas for linking Numerai + GPU provider keys.
- [x] Typed provider credential fields on `ComputeProvider` (apiKey, apiSecret, workspaceId, awsRoleArn, awsRegion, baseUrl) + per-provider drawer inputs in `/settings` (no more raw-JSON textarea).
- [x] `verifyNumeraiAccount` and `verifyComputeProvider` custom mutations (Lambdas under `frontend/amplify/functions/`) — real Numerai GraphQL ping, shape/format checks for Modal + SageMaker + Prime Intellect, status stored on `verifiedAt` / `lastVerifyError`.
- [x] `ModelRegistryItem.parentModelId` + `/evolution` flow canvas for lineage.
- [x] Real CRUD on `/models` (replaces marketing fakery).
- [x] `frontend/DESIGN.md` editorial visual language.
- [ ] Move Numerai + provider secrets out of plaintext DynamoDB (Parameter Store SecureString most likely) before real keys go in.

### Hardening the verify checks

- [ ] Confirm Prime Intellect's real auth-check endpoint (current `/api/v1/me` is a guess; treat any non-2xx other than 404 as failure for now).
- [ ] Promote SageMaker verify from shape-check to a real `sts:AssumeRole` against the provided role ARN — requires IAM perms on the verify-compute-provider Lambda.
- [ ] Promote Modal verify from prefix-check to a real API call once their token-introspection endpoint is documented.

### Closing the loop with Numerai

- [ ] Submission worker that authenticates with the linked `NumeraiAccount` and:
  - [ ] Pulls each model's `liveCorr`, `liveMmc`, `payoutNmr`, `lastSubmittedRound`, `lastSubmittedAt` and writes them back to `ModelRegistryItem`.
  - [ ] Posts predictions from a `TrainingRun` artifact to the round.
- [ ] `ModelSubmission` entity (round, score, submitted_at, predictions S3 uri) so per-round history isn't squashed onto the registry row.
- [ ] Round/dataset reference cache (global, not per-user) — round number, open/close times, dataset version.

### Builder + compute

- [ ] Wire `/builder` to the real `Pipeline` / `ModelBranch` schema (currently uses `lib/product-data.ts` fakery — same problem `/models` had).
- [ ] Wire `/compute` to `ComputeProvider` / `ComputeJob` — submit a real training job to a linked provider, track status.
- [ ] Auto-set `ModelRegistryItem.parentModelId` when a registered model originates from a `TrainingRun` whose branch has a parent. (Right now lineage is manual.)
- [ ] Cycle guard in the parent picker — currently only blocks self-reference, not multi-hop loops.

### Polish

- [ ] Fix the 3 pre-existing `svelte-check` errors in `routes/builder/+page.svelte` and `routes/ml/+page.svelte`.
- [ ] Apply `DESIGN.md` conventions to `/builder`, `/compute`, `/ml`, `/chart`, and the homepage (they predate the editorial language).
- [ ] Decide what to do with `ModelRegistryItem.lineageJson` (currently unused — either populate from a training run snapshot or drop the field).
- [ ] Real provider logos in flow nodes (current SVGs are stylized abstractions to avoid trademark issues).

