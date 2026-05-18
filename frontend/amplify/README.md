# Amplify Backend

This is the new production backend for the app. The legacy `../backend` FastAPI/SAM
service remains as reference material while this Amplify Gen 2 backend becomes the
source of truth.

Run from `frontend/`:

```sh
npm run sandbox
```

For a one-shot deployment/update:

```sh
npm run sandbox:once
```

The data schema uses Cognito user-pool auth and owner authorization on every
workspace model, so pipelines, branches, sweeps, runs, registered models, compute
providers, and compute jobs are segregated per signed-in user.

## Custom mutations (verification)

`functions/verify-numerai-account/` and `functions/verify-compute-provider/` are
Lambda handlers exposed as Amplify Data custom mutations
(`verifyNumeraiAccount(id)` / `verifyComputeProvider(id)`). They read the target
row, run a provider-specific check, then write `verifiedAt` (on success) or
`lastVerifyError` (on failure) back to DynamoDB.

- Numerai: real call to `https://api-tournament.numer.ai/` GraphQL
  `account { id username }` using the stored public ID + secret key.
- Prime Intellect: HTTP GET against `${baseUrl ?? https://api.primeintellect.ai}/api/v1/me`
  with `Authorization: Bearer <apiKey>` (treat 404 as okay — endpoint TBD).
- Modal: token-prefix format check (`ak-` / `as-`) — no live API call yet.
- SageMaker: IAM role-ARN shape + region presence — no STS AssumeRole yet.
- `local`: always succeeds.
- `custom`: passes if `apiKey` or `baseUrl` is set.

Provider credentials are stored as typed columns on `ComputeProvider`
(`apiKey`, `apiSecret`, `workspaceId`, `awsRoleArn`, `awsRegion`, `baseUrl`).
The legacy `credentialsJson` field is kept for overflow but no longer required.

> Secret material currently lives plaintext in DynamoDB (owner-scoped).
> Migrating to Secrets Manager / SSM SecureString is on the root-README backlog.
