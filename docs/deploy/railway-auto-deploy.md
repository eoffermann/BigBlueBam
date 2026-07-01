# Automated Railway deployment (new-app provisioning)

## The problem this solves

Locally, adding a service to `docker-compose.yml` and running `docker compose up`
creates it — no manual steps. On Railway that was not true. Railway's GitHub
integration redeploys services that **already exist** in the project when
`stable` moves, but it cannot notice that the catalog gained a **brand-new app**
(e.g. `blip-api`) and create that service. A service Railway has never seen is
never deployed, so a new app 404s or falls through to the marketing-site
catch-all in production until someone hand-creates it in the dashboard.

That gap shipped three times (Bin, Bay, Blip). This automation removes it.

## How it works

`.github/workflows/deploy.yml` runs on every push to `stable` (and can be run
by hand via **workflow_dispatch**). It calls
`scripts/deploy/railway-auto-deploy.mjs`, which:

1. Authenticates to Railway with the `RAILWAY_API_TOKEN` secret (GraphQL API).
2. Resolves the `bigbluebam` project + its default environment.
3. Reads the **shared** secrets (`SESSION_SECRET`, `INTERNAL_*`, `MINIO_*`,
   `LIVEKIT_*`) off already-deployed services and copies them forward, so no
   secret has to live in CI. Service-local secrets that nothing else references
   (`BLIP_INGEST_PEPPER`) are generated fresh.
4. Diffs the live services against `scripts/deploy/shared/services.mjs` and, for
   every service that does not yet exist, creates it, sets its Dockerfile /
   healthcheck / start command, sets its variables (catalog-computed +
   copied/generated secrets), attaches a volume if the catalog declares one, and
   triggers its first deploy (`RailwayOrchestrator.syncNew()`).
5. Refreshes the `frontend` ingress (`RAILWAY_ALWAYS_REDEPLOY=frontend`) so a new
   app's nginx routes go live even if Railway's own auto-deploy skips the ingress.

Existing services are left to Railway's GitHub integration, which redeploys them
on push. The workflow only adds the one step Railway cannot do itself: **create
the new service.** It is idempotent — `createService` returns an existing service
untouched, so a run with nothing new to create is a no-op.

## One-time setup

Add a repository secret named `RAILWAY_API_TOKEN`:

- Railway → **Account Settings → Tokens → Create Token** (an **account** API
  token; unlike `railway login` OAuth it does not expire).
- GitHub repo → **Settings → Secrets and variables → Actions → New repository
  secret**: name `RAILWAY_API_TOKEN`, value the token.

Until that secret exists the workflow no-ops (warns and exits 0), so landing the
workflow file is harmless.

> **Gotcha that cost hours before:** the account API token is **rejected by the
> `railway` CLI** ("Invalid RAILWAY_TOKEN") but **accepted by the Railway GraphQL
> API**, which is what the deploy scripts use. "The CLI says the token is
> invalid" does **not** mean deployment is blocked — test the token with
> `node scripts/deploy/railway-auto-deploy.mjs` (dry run), not the CLI.

## Running it by hand

```bash
# Dry run — read-only, prints exactly what WOULD be created/deployed.
node scripts/deploy/railway-auto-deploy.mjs

# Apply — create missing services + trigger deploys.
node scripts/deploy/railway-auto-deploy.mjs --apply
```

It reads the token from `RAILWAY_API_TOKEN` / `RAILWAY_TOKEN` in the environment
or from `.env`. Other knobs (all optional): `RAILWAY_PROJECT_NAME` (default
`bigbluebam`), `RAILWAY_DEPLOY_BRANCH` (default `stable`), `RAILWAY_GITHUB_REPO`
(default `$GITHUB_REPOSITORY` or the git remote), `RAILWAY_ALWAYS_REDEPLOY`
(comma-separated service names to redeploy every run), `PUBLIC_URL`.

## What you STILL have to do when adding an app

The automation reads the catalog; it does not write it. A new app still needs
its three registrations or provisioning is wrong or throws:

1. **`infra/nginx/nginx.railway.conf`** — the `/app/`, `/app/api/` (+`/app/ws`)
   location blocks, or the path falls through to the marketing site.
2. **`scripts/deploy/shared/services.mjs`** — the service catalog entry, plus the
   app in `mcp-server.needs` + a `*_API_URL` if it has MCP tools.
3. **`scripts/deploy/shared/env-hints.mjs`** — a hint for **every** env var the
   service declares. A required var with no hint makes provisioning throw
   `Cannot resolve required variable "…"`. (That exact drift — a missing
   `BLIP_INGEST_PEPPER` hint — was found and fixed when this automation landed.)

See also `docs/deploy/railway-var-decisions.md` for how each variable's value is
derived, and the `project_railway_new_app_checklist` note.
