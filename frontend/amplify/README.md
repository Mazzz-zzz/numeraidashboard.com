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
