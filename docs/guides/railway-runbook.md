# Railway Deployment Runbook

Operator runbook for standing up BigBlueBam on Railway using the deployment orchestrator at `scripts/deploy/platforms/railway.mjs`.

## Context

The Railway platform adapter and orchestrator let you deploy BigBlueBam to Railway from a single `./scripts/deploy.sh` invocation. The orchestrator is **mostly** turnkey — it creates 20 services, configures their build/start commands, wires internal networking via `.railway.internal` DNS, sets every env var the services need, and queues first deploys.

But Railway's public GraphQL API doesn't expose plugin creation, so there are 3 irreducible manual steps the runbook has to account for:

1. Adding Postgres + Redis plugins from the Railway dashboard (the orchestrator pauses and waits for you).
2. Adding the `frontend` (nginx) service and assigning a public domain — the orchestrator doesn't auto-create it.
3. Adding the optional `voice-agent` service if you want AI voice/video.

Everything else is automated and idempotent — re-running the script after a failure is safe and will pick up where it left off (it finds existing projects/services by name and reuses them).

## Which branch to deploy

BigBlueBam uses a two-branch model:

- **`stable`** — the production branch. Every commit here has been validated on `main` first and, where possible, exercised against a real deployment. **This is the default** and what you should pick for most deploys.
- **`main`** — the bleeding-edge integration branch. New features and fixes land here first. Use `main` only when you specifically want the latest code and can tolerate the occasional rough edge.

The deploy script prompts you once (on the first run) to choose between `stable` and `main`. Your choice is saved in `.deploy-state.json` and reused on subsequent runs. To change it later, re-run with `--reconfigure` or edit the state file by hand.

Railway tracks the branch you pick per-service — every service the orchestrator creates is linked to that branch, and Railway auto-rebuilds when commits land on it. If you later decide to switch, re-run the deploy script and pick the other branch; the orchestrator will update each service's tracked branch via `updateServiceInstance()`.

## Prerequisites (do these BEFORE running the script)

### 1. Railway account with billing enabled

- Sign up at **<https://railway.com?referralCode=xCAYHN>** — using our referral link costs you nothing extra and gives BigBlueBam a small Railway credit that helps fund continued development. (Plain sign-up at <https://railway.com> also works; the referral is optional but appreciated.)
- Note the domain is `.com`, not `.app`.
- Add a payment method. Expected monthly cost for BigBlueBam is roughly **$20–40** — you're running 20 services, most of which are low-traffic APIs, plus Postgres and Redis. Exact price depends on traffic and the MinIO/Qdrant volume sizes you allocate.
- **There is no free tier** that can fit this workload — Railway's starter plan caps out quickly with 20 services.

### 2. Railway Personal Access Token (PAT)

- Generate one at <https://railway.com/account/tokens>.
- Scope: the PAT has full account access — treat it like a password.
- You'll either paste it when the script prompts, or export it as an env var beforehand so the script auto-picks it up.

### 3. GitHub repo accessible to Railway

- Your `origin` remote must be a GitHub repo Railway can pull from.
- Railway needs permission to read the repo — connect your GitHub account to Railway once, at <https://railway.com/account/github>.
- The script auto-detects `origin` via `git remote get-url origin` (`scripts/deploy/platforms/railway.mjs:249`) and the current branch via `git rev-parse --abbrev-ref HEAD` (line 262).

### 4. Node.js 22+ locally

- The bootstrap wrappers (`scripts/deploy.sh` and `scripts/deploy.ps1`) will install Node 22 for you via `nvm`/`winget` if missing. You can skip this step if you already have Node 22.

### 5. Docker is NOT required

- Unlike the Docker Compose path, the Railway deployer never runs containers locally. It talks to Railway's GraphQL API directly. You can run the deploy script from any machine with Node 22, even one without Docker installed.

### 6. Railway CLI is OPTIONAL

- The deploy script will print `[!] Railway CLI not detected — admin auto-creation will print manual instructions instead` if `railway version` doesn't resolve. **This is a warning, not an error.** The deploy itself doesn't use the CLI — it talks to Railway's GraphQL API directly.
- The CLI is only needed later for Step 14's automatic admin-user creation. Without it, Step 14 falls back to printing instructions for running the `create-admin` command inside the api service via the Railway dashboard's ephemeral shell.
- If you want to install it anyway: on Windows use `scoop install railway`, download the binary from <https://github.com/railwayapp/cli/releases>, or `npm install -g @railway/cli` (Node wrapper that downloads the binary — npm's "N packages are looking for funding" info output during this install is normal and can be ignored). On macOS/Linux use `brew install railway` or the install script from Railway's docs.

## Step-by-step deploy

### Step 0 — Pull the latest refs

```sh
cd /path/to/BigBlueBam
git fetch origin
```

You don't need to be checked out to the branch you're deploying — the script will prompt you to choose `stable` or `main` in Step 4a and pass the choice to Railway. But your local clone does need to know about both branches, which `git fetch` ensures.

### Step 1 — Run the deploy script

```sh
# Linux / macOS:
./scripts/deploy.sh

# Windows PowerShell:
.\scripts\deploy.ps1
```

Both wrappers check for Node 22, install it if needed, and hand off to `scripts/deploy/main.mjs`.

### Step 2 — Select the Railway platform

The script prompts: **"Where are you deploying?"** with a menu. Pick **"Railway"** (option 2). The prompt lives at `scripts/deploy/main.mjs:62`.

If you've run the script before, it remembers your last choice in `.deploy-state.json` at the repo root and will offer to reuse it.

### Step 3 — Provide your PAT

The Railway adapter runs `checkPrerequisites()` at `scripts/deploy/platforms/railway.mjs:133-170`. It will either:

- Pick up `RAILWAY_TOKEN` from your environment if set, OR
- Prompt you to paste the PAT. It echoes a link to the token page if you haven't created one yet.

**Must be a Personal Access Token, not a Project Token or Workspace/Team Token.** Railway has multiple token types, and only PATs (generated at the account-level tokens page) have the scope to call `me { ... }` and create new projects. Project Tokens and Workspace Tokens authenticate successfully at the HTTP layer but Railway's GraphQL resolver rejects the `me` query with `Not Authorized`. Go to <https://railway.com/account/tokens> (the account-level page, **not** a project's Settings → Tokens page) and click "Create New Token."

If you accidentally paste a non-PAT, the script will detect it and print a targeted error explaining what's wrong — no silent failures. The token is stored in your local `.env` (gitignored) so subsequent runs don't re-prompt.

### Step 4 — Confirm project name, GitHub repo, and branch

The script asks:

- **Project name** (default: `bigbluebam`) — this is the Railway project name, not a display label. If a project with this name already exists in your Railway account, the orchestrator reuses it (via `findProjectByName`, `scripts/deploy/shared/railway-orchestrator.mjs:275`).
- **GitHub repo** — auto-detected from your `origin` remote. Confirm or paste a different `owner/repo`.
- **Deploy branch** — you're prompted with a menu: `stable` (default, recommended), `main` (bleeding-edge), and optionally your current local branch. Pick `stable` unless you specifically want the latest unreleased code. See [Which branch to deploy](#which-branch-to-deploy) above for the rationale. The selected branch is saved in `.deploy-state.json` and reused on subsequent runs.

### Step 5 — Fill in domain and integration settings

You'll be asked for:

- **Public domain** (prompt text: *"Public domain for the deployed app"*). This is the URL humans will use to reach your deployed app in a browser — it gets baked into `CORS_ORIGIN` and `FRONTEND_URL` on every API service. Three legitimate answers:

  1. **A custom domain you already own** — e.g., `bigbluebam.mycompany.com`. You'll point DNS at Railway's frontend service in Step 12.
  2. **A Railway auto-generated subdomain** — e.g., `bigbluebam.up.railway.app`. You won't know the exact subdomain until Step 11 creates the frontend service, but you can plan for the pattern.
  3. **A temporary placeholder** (the prompt's default is `bigbluebam.example.com`) — fine if you don't know the real domain yet. Railway lets you edit `CORS_ORIGIN` and `FRONTEND_URL` on each service later from the dashboard Variables tab.

  Enter only the hostname — no `https://` prefix, no trailing slash.

- **Storage provider** — stick with the default MinIO (built-in, self-hosted on Railway) unless you want to point at an external S3.
- **Vector database** — stick with Qdrant (default). Beacon's knowledge base needs it.
- **LiveKit** — optional. Choose "skip" unless you're enabling voice/video (Board app uses it).
- **OAuth / SMTP / Google / Microsoft credentials** — optional. Skip anything you don't need now; you can add env vars in the Railway dashboard later.

### Step 6 — Validation + project creation (automatic)

At this point the orchestrator runs Phases 1 and 2 of `railway-orchestrator.mjs:run()` with no further input from you:

1. **Validate** (`:243-270`): Calls `client.assertSchemaCompatibility()` to confirm Railway's GraphQL schema has all the mutations the script needs, then `client.whoami()` to verify your PAT works.
2. **Project** (`:273-303`): If the project already exists, it's reused; otherwise `createProject()` is called. Either way the default environment ID is resolved.

You'll see progress lines like `✓ Validating Railway schema` and `✓ Using project bigbluebam (project_xxxxx)`.

### Step 7 — **MANUAL: Add Postgres + Redis plugins in Railway dashboard**

The orchestrator **pauses** here and prints:

```
The next step requires you to add Postgres and Redis plugins to the
project in the Railway dashboard. Railway's public API does not
expose plugin creation — we have to ask you to do it by hand.

Open: https://railway.com/project/<projectId>
Click: "+ New" → "Database" → "Add PostgreSQL"
Click: "+ New" → "Database" → "Add Redis"

Press Enter when done.
```

This is the `awaitPluginConfirmation` callback at `railway-orchestrator.mjs:306-334`. Go to the Railway dashboard, click the link the script printed, add both plugins (takes ~30 seconds each — Railway provisions them quickly), then return to your terminal and press Enter.

**Why this is manual:** Railway's public GraphQL API exposes `projectCreate`, `serviceCreate`, and `environmentTriggersDeploy`, but there's no public mutation for `pluginCreate`. The Railway CLI uses a private API for this. We explicitly refuse to depend on private APIs.

### Step 8 — Services, configuration, variables (automatic)

After you confirm, Phase 4 runs (`railway-orchestrator.mjs:337-429`). For each of the 20 services in the deploy plan, the orchestrator:

1. Calls `createService()` — idempotent (returns existing if present).
2. Calls `updateServiceInstance()` with the right Dockerfile path, start command, health check path, and restart policy.
3. Calls `upsertVariables()` with all the env vars that service needs, using `${{Postgres.DATABASE_URL}}` / `${{Redis.REDIS_URL}}` / `http://minio.railway.internal:9000` / etc.

You'll see progress lines like:

```
[4/60]  ✓ api: Creating service "api"
[5/60]  ✓ api: Configuring service "api"
[6/60]  ✓ api: Setting variables for "api"
[7/60]  ✓ helpdesk-api: Creating service "helpdesk-api"
...
```

The 20 services are:

- **16 app services**: api, helpdesk-api, banter-api, beacon-api, brief-api, bolt-api, bearing-api, board-api, bond-api, blast-api, bench-api, book-api, blank-api, bill-api, mcp-server, worker
- **3 self-hosted infra**: minio (10GB volume), qdrant (5GB volume), livekit (no volume)
- **1 job**: migrate (restart policy: NEVER; runs once per deploy)

`voice-agent` is intentionally excluded (TODO at `railway-orchestrator.mjs:37-40`).

### Step 9 — Trigger first deploys (automatic)

Phase 5 (`railway-orchestrator.mjs:432-449`) loops through the deploy plan once more and calls `triggerDeploy()` for each service. Deploys run asynchronously on Railway — the script does NOT wait for them to finish. It exits with a summary like:

```
✓ Deploy queued
  Project:  project_xxxxx
  Environment: env_yyyyy
  Services created:    20
  Services configured: 20
  Services deployed:   20

  Next steps:
  1. Watch progress: https://railway.com/project/project_xxxxx
  2. Add the `frontend` service manually (see runbook)
  3. Configure your public domain on the `frontend` service
```

### Step 10 — Watch Phase-4 deploys complete (in Railway dashboard)

Open the dashboard link the script printed. You'll see all 20 services and their deploy status. Typical first-deploy time: **15–25 minutes** (the api image is large and compiles ~60 TypeScript packages; subsequent deploys benefit from Railway's layer cache).

You want every service to reach **"Active"** state before moving on. If a service fails to build or stays stuck:

- Click the service → **Deployments** tab → inspect the build log.
- Common first-deploy failures: missing env var (re-run the orchestrator — it's idempotent), out-of-memory on build (upgrade Railway plan), GitHub permissions (re-link the repo).

### Step 11 — **MANUAL: Add the `frontend` (nginx) service**

The orchestrator does **not** auto-create the nginx frontend because it needs a public domain, and domain configuration lives entirely in Railway's dashboard.

In the Railway dashboard:

1. Click **"+ New"** → **"Service"** → **"Empty Service"**.
2. Name it `frontend`.
3. **Settings → Source** → connect it to the same GitHub repo.
4. **Settings → Build** → set `Dockerfile Path` to `infra/nginx/Dockerfile` (or run `node scripts/gen-railway-configs.mjs` locally and use the generated `railway/frontend.json` as a reference).
5. **Settings → Networking** → **Generate Domain** to get a `*.up.railway.app` URL, OR configure your custom domain via **Settings → Networking → Custom Domain**.
6. **Variables** → nginx needs upstream hostnames. The generated `infra/nginx/nginx.railway.conf` already uses `<service>.railway.internal:<port>` — confirm it's the one baked into the frontend image. If you ran `gen-railway-configs.mjs`, the script wrote the Railway-flavored config to `infra/nginx/nginx.railway.conf` for you.
7. **Deploy.**

### Step 12 — **MANUAL: Configure public domain + confirm routing**

In Railway: set the domain on the `frontend` service. Once Railway provisions the cert (usually <1 minute), visit:

- `https://<your-domain>/b3/api/health` — should return `{"status":"ok"}` (b3 / api service)
- `https://<your-domain>/bolt/api/health` — same for bolt-api
- `https://<your-domain>/helpdesk/api/health` — same for helpdesk-api

If the paths route correctly, the `frontend` nginx service is proxying to the internal services over `.railway.internal` correctly.

### Step 13 — **OPTIONAL: Add `voice-agent` service**

If you want AI voice/video features:

1. Railway dashboard → **"+ New"** → **"Service"** → **"Empty Service"**.
2. Name it `voice-agent`.
3. **Settings → Build** → `Dockerfile Path = apps/voice-agent/Dockerfile`.
4. **Variables** → set `LIVEKIT_HOST`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` to match your LiveKit deployment.
5. Deploy.

Skip this step if you don't need voice/video — nothing in the rest of the stack depends on it.

### Step 14 — Create the initial admin user

Once the api service is Active and the public domain is responding, you need a bootstrap admin. Two options:

**Option A (recommended): Railway CLI one-shot**

```sh
railway login
railway link --project <projectId>
railway run --service api -- node dist/cli.js create-admin \
  --email you@example.com --password 'strong-password-here' \
  --name "Your Name" --org "Your Org"
```

**Option B: Railway dashboard shell**

1. Dashboard → `api` service → **Settings → Advanced → Ephemeral Shell** (or equivalent).
2. Run: `node dist/cli.js create-admin --email you@example.com --password '...' --name 'Your Name' --org 'Your Org'`

Option A is cleaner but requires the Railway CLI. The orchestrator documents this as a "deferred step" at `railway.mjs:441-442` because the admin creation depends on a public domain being configured — which is a manual step.

### Step 15 — Log in and sanity-check

Open `https://<your-domain>/b3/` in a browser. Log in with the admin creds from Step 14. You should land on the Bam dashboard. Quick smoke test:

- Create a project
- Create a task
- Navigate to `/bolt/` (automations), `/beacon/` (knowledge base), `/bond/` (CRM)
- Confirm each app loads and shows its empty state (no 500s)

## What the orchestrator does NOT do (and why)

| Manual step | Why it's manual |
|---|---|
| Add Postgres + Redis plugins | Railway's public GraphQL API doesn't expose plugin creation. The CLI uses a private API we refuse to depend on. |
| Create the `frontend` (nginx) service | Needs a public domain; domain config lives in the Railway dashboard. Orchestrator leaves this to you so you can pick your domain name. |
| Assign a public domain | Railway's domain API requires dashboard interaction for custom domains; the auto-generated `*.up.railway.app` subdomain works but is ugly. |
| Add `voice-agent` | Excluded on purpose — most deployments don't need it, and it has a bigger base image. |
| Create admin user | Depends on the api service being Active AND the public domain being reachable. The orchestrator exits before both are true. |
| Delete / tear down | Not implemented intentionally — this is a data-safety measure. Delete the project manually from **Settings → Delete Project** in the Railway dashboard. |

## Idempotency and re-running

**Safe to re-run at any time.** The orchestrator is designed around Railway's mutation shape so every operation is idempotent:

- `findProjectByName(projectName)` — reuses existing project
- `findServiceByName(projectId, name)` — reuses existing service instead of creating a duplicate
- `upsertVariables({..., replace: false})` — merges new vars into existing ones instead of clobbering
- `triggerDeploy()` — queues a new deploy even if the service is already Active

If the script fails at any point (network hiccup, Railway 500, etc.), just run `./scripts/deploy.sh` again. It picks up where it left off.

See `scripts/deploy/shared/railway-orchestrator.mjs:13-18` for the explicit idempotency contract.

## Key files (for reference while running)

- **`scripts/deploy.sh`** / **`scripts/deploy.ps1`** — bootstrap wrappers
- **`scripts/deploy/main.mjs`** — platform selection + top-level prompts (`:28-220`)
- **`scripts/deploy/platforms/railway.mjs`** — Railway adapter, PAT prompt, project name input (`:277-412`)
- **`scripts/deploy/shared/railway-orchestrator.mjs`** — the 5-phase orchestrator (`:162-494`)
- **`scripts/deploy/shared/railway-api.mjs`** — GraphQL client with all the mutations
- **`scripts/deploy/shared/services.mjs`** — the service catalog (20 services + their Dockerfile paths, env hints, start commands)
- **`scripts/deploy/shared/env-hints.mjs`** — env var resolution logic (plugin refs, internal DNS, generated secrets)
- **`scripts/gen-railway-configs.mjs`** — generates `infra/nginx/nginx.railway.conf` and `railway/<service>.json` files (useful if you need to inspect what the orchestrator will configure before running)
- **`docs/deployment-guide.md`** — the main deployment guide that this runbook sits alongside

## Verification checklist

End-to-end success means all of these are true:

- [ ] Railway dashboard shows 23+ services: 20 from the orchestrator (16 apps + 3 infra + migrate) + 2 plugins (postgres, redis) + 1 manual (frontend). Optionally +1 for voice-agent.
- [ ] Every service is in **Active** state with a green indicator.
- [ ] `https://<your-domain>/b3/api/health` returns `{"status":"ok"}` with HTTP 200.
- [ ] `https://<your-domain>/bolt/api/__nonexistent__` returns the canonical error envelope `{"error":{"code":"NOT_FOUND",...}}` (verifies nginx routing + the envelope handlers).
- [ ] `https://<your-domain>/b3/` loads the SPA login page in a browser.
- [ ] You can log in with the admin created in Step 14.
- [ ] You can create a project in Bam and see it in the dashboard list (verifies Postgres + schema migrations + SPA → API wiring).
- [ ] Railway dashboard → `postgres` service → **Data** tab shows the `bigbluebam` database with 40+ tables (verifies migrations ran end-to-end).

If any of those fail, the Railway service logs are the first place to look. `docs/deployment-guide.md` has a "Migration failures" troubleshooting section that applies to Railway too.

## Known gotchas

1. **Migration sidecar on upgrade.** Once you have an active Railway deploy, future updates just push commits to the branch — Railway auto-rebuilds the affected services. But the `migrate` service doesn't auto-run on every push: it only runs when its own source (the api image) rebuilds. If you add a new migration without any other api-image changes, trigger a manual redeploy of the `migrate` service from the Railway dashboard.

2. **First deploy is slow.** The api image compiles ~60 TypeScript packages; expect 15–25 minutes for the first build. Subsequent deploys are much faster thanks to Railway's build cache.

3. **MinIO + Qdrant volume sizes are baked in.** 10GB and 5GB respectively. If you outgrow them, resize from the Railway dashboard → service → **Volumes** tab. Volumes survive service deletion unless explicitly removed.

4. **`voice-agent` requires extra setup.** LiveKit also needs to be running (Step 5 asked about it). If you skipped LiveKit, don't add voice-agent either — it'll crash-loop.

5. **Login verification in the script is deferred.** The orchestrator can't fully verify everything works from the CLI because the final test (hit the login endpoint) depends on a public domain that doesn't exist yet. `railway.mjs:441-442` throws a clear message about this. Don't treat it as a failure — it's a known limitation documented in code.

6. **Re-linking GitHub.** If the orchestrator creates a service but the service can't pull from GitHub, Railway's log will say "source not connected." Go to Railway → Account → GitHub → re-authorize the BigBlueBam repo. Then re-run the script.
