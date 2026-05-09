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
