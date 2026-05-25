# Amplify Backend

This is the production backend for the app. New product work should use this
Amplify Gen 2 backend as the source of truth.

Run from `frontend/`:

```sh
npm run sandbox
```

For a one-shot deployment/update:

```sh
npm run sandbox:once
```

Useful local verification commands:

```sh
npm test
npx tsc --noEmit --project tsconfig.json
npm run build
```

The data schema uses Cognito user-pool auth and owner authorization on every
workspace model, so pipelines, branches, sweeps, runs, registered models, compute
providers, model submissions, and compute jobs are segregated per signed-in user.

## Custom Mutations

`functions/verify-numerai-account/` and `functions/verify-compute-provider/` are
Lambda handlers exposed as Amplify Data custom mutations
(`verifyNumeraiAccount` / `verifyComputeProvider`). They run provider-specific
checks and return a typed result; callers write `verifiedAt` or
`lastVerifyError` to the owner-scoped model row.

- Numerai: real call to `https://api-tournament.numer.ai/` GraphQL
  `account { id username }` using the stored public ID + secret key.
- Prime Intellect: HTTP GET against `${baseUrl ?? https://api.primeintellect.ai}/api/v1/pods/?offset=0&limit=1`
  with `Authorization: Bearer <apiKey>`.
- Modal: token-prefix format check (`ak-` / `as-`) — no live API call yet.
- SageMaker: IAM role-ARN shape + region presence — no STS AssumeRole yet.
- `local`: always succeeds.
- `custom`: passes if `apiKey` or `baseUrl` is set.

Provider and Numerai secret material is stored through SSM SecureString from the
verification Lambdas. GraphQL model rows store only references:

- `NumeraiAccount.secretRef`
- `ComputeProvider.apiKeyRef`
- `ComputeProvider.apiSecretRef`

Non-secret provider configuration stays on `ComputeProvider`
(`workspaceId`, `awsRoleArn`, `awsRegion`, `baseUrl`). The legacy
`credentialsJson` field is kept for overflow but should not contain secret
material.

Training control-plane actions are also exposed as custom mutations:

- `startTraining(runId, providerId, providerType)`
- `cancelTraining(runId, providerId, providerType, providerJobId)`
- `pollTrainingStatus(runId, providerId, providerType, providerJobId)`
- `submitModel(modelId, providerId, numeraiAccountId, roundNumber, predictionSet, neutralizationPct, validationMode, uploadEnabled)`
- `refreshRoundMetrics(modelId, submissionId, roundNumber)`

These functions are the frontend-owned boundary for provider launch, cancel, and
status checks. Prime Intellect is wired to compute pods: `startTraining` creates
a pod from a configured custom template, `pollTrainingStatus` reads pod state and
logs, and `cancelTraining` deletes the pod. Real Modal/SageMaker calls should be
added inside these handlers.

`RoundDataset` is a global authenticated cache for Numerai round metadata and live
dataset references. `ModelSubmission` remains owner-scoped so each user sees only
their planned, queued, submitted, and completed submission history.

## Logs and records

When a function fails, inspect the Lambda log group generated for the matching
function folder name:

- `verify-numerai-account`
- `verify-compute-provider`
- `start-training`
- `cancel-training`
- `poll-training-status`
- `submit-model`
- `refresh-round-metrics`

When data looks wrong, inspect the corresponding Amplify Data table/model:

- connection setup: `NumeraiAccount`, `ComputeProvider`
- builder state: `Pipeline`, `ModelBranch`, `SweepPlan`
- workload state: `TrainingRun`, `ComputeJob`
- model/submission state: `ModelRegistryItem`, `ModelSubmission`, `RoundDataset`

## Current limitations

- `start-training` uses a typed adapter boundary. Prime Intellect compute pod
  launch is implemented, but it requires a Prime custom template id in
  `ComputeProvider.credentialsJson.primeIntellect.customTemplateId` so the pod
  has a startup entrypoint for the Numerai ML worker. Modal/SageMaker/custom
  providers still return deterministic queued ids.
- `cancel-training` and `poll-training-status` normalize statuses and payloads
  for the frontend. Prime Intellect cancel/poll API calls are implemented;
  Modal/SageMaker/custom provider calls still need to be implemented.
- `submit-model` returns deterministic artifact/upload metadata and validates the
  submission contract. A real Numerai upload worker still needs to generate and
  post prediction files.
- `refresh-round-metrics` returns deterministic round/metric snapshots so the UI
  path can be exercised. Replace that snapshot source with Numerai live results
  when the scoring integration is added.

## Rollback

Rollback by redeploying the previous frontend commit. If Amplify schema or
function code changed, rerun from `frontend/`:

```sh
npm run sandbox:once
```

For runtime mitigation, disable a problematic compute provider in `/settings`
instead of deleting records. Secrets remain in SSM SecureString parameters; data
rows store only references.
