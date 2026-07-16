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

## Hosted MCP endpoint

`functions/mcp-server/` exposes a stateless, JSON-response Streamable HTTP MCP
server through an Amplify-managed Lambda Function URL. Deployment writes the
endpoint and OAuth configuration to `amplify_outputs.json` as `custom.mcpUrl`,
`custom.mcpOAuthClientId`, `custom.mcpOAuthAuthorizationServer`, and
`custom.mcpOAuthDomain`.

Claude custom connectors use Cognito OAuth:

1. Set the connector URL to `custom.mcpUrl`.
2. In Advanced settings, set OAuth Client ID to `custom.mcpOAuthClientId`.
3. Leave OAuth Client Secret blank.
4. Connect and sign in through the Cognito consent flow.

The dedicated app client uses authorization code + S256 PKCE and permits only
Claude's hosted callback, `https://claude.ai/api/mcp/auth_callback`. The MCP
endpoint publishes RFC 9728 protected-resource metadata, verifies Cognito access
token signatures and the dedicated client ID, and resolves the token subject
back to the same owner-scoped records used by the web app.

API keys remain available for clients that support static request headers.
Generate one locally:

```sh
cd frontend
npm run mcp:key
```

Save `keyHash`, `keyPrefix`, a label in `name`, and the Cognito owner value in an
`ApiKey` row using Amplify Data Manager. The owner value must be
`<cognito-sub>::<username>` (or the subject alone). Keep `rawKey` in the MCP
client; it is shown only by the generator and cannot be recovered from Odoo,
Amplify, or DynamoDB. Set `revokedAt` to disable a key immediately.

Configure an API-key client with the deployed URL and header:

```json
{
  "url": "https://example.lambda-url.region.on.aws/",
  "headers": { "X-API-Key": "nd_mcp_..." }
}
```

Tools are `list_training_runs`, `launch_training_run`,
`poll_training_status`, `cancel_run`, and `list_submissions`. The Lambda has IAM
access to the Data API, but every read and write is checked again against the
authenticated Cognito subject before provider credentials or workflow rows are
used. Local Mac daemon logs remain snapshots from `ComputeJob.logTail`; the
hosted Lambda does not connect directly to a workstation.

## Modal Worker Deployment

Modal launch, status, and cancel are coupled to the web endpoints in
`ml/sagemaker/modal_runner.py`. Whenever those endpoint names, request payloads,
or response contracts change, deploy the worker before shipping the dashboard:

```sh
cd ml
modal deploy sagemaker/modal_runner.py
```

The dashboard launch path preflights the expected `job-status` and `job-cancel`
endpoints before spawning a training call. A 404 from those checks means the
Modal app is stale; redeploy `ml/sagemaker/modal_runner.py` instead of retrying
the dashboard launch.

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
- `mcp-server`

When data looks wrong, inspect the corresponding Amplify Data table/model:

- connection setup: `NumeraiAccount`, `ComputeProvider`
- builder state: `Pipeline`, `ModelBranch`, `SweepPlan`
- workload state: `TrainingRun`, `ComputeJob`
- remote control: `ApiKey`
- model/submission state: `ModelRegistryItem`, `ModelSubmission`, `RoundDataset`

## Current limitations

- `start-training` uses a typed adapter boundary. Prime Intellect compute pod
  launch is implemented and defaults to `L40S_48GB` on a direct CUDA/PyTorch pod
  image when no custom template is configured. Modal/SageMaker/custom providers
  still return deterministic queued ids.
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
