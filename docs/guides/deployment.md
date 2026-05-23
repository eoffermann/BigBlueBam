# Deployment Guide

Deploy BigBlueBam from zero to running in about 10 minutes. No IT department required. BigBlueBam is Docker-native from day one. The application services are designed to scale horizontally with no code changes — env-driven config, Redis-backed sessions and pubsub, and BullMQ for worker coordination. Today's shipped deployment targets are **Tier 1** (single-machine Docker Compose) and **Railway** (managed cloud, fully automated). The Tier 2/3/4 substrate works (`docker compose up --scale` already coordinates correctly across replicas), but Tier 4's Kubernetes Helm chart is planned and not yet authored.

This guide is structured to take you from quickstart → "everything's running" → scaling concerns. Read top-to-bottom on your first deploy; come back to the later sections when you outgrow Tier 1.

---

## What You'll Need

Before you start, here's what the setup wizard will configure for you:

- **A place to run it** — any machine with Docker, or a Railway account for managed cloud
- **A database** — PostgreSQL and Redis, automatically provisioned
- **An admin account** — you'll create this during setup
- **Optional**: file storage (S3/MinIO), AI features (Anthropic/OpenAI), voice/video (LiveKit)

---

## Choose Your Deployment Path

### Option 1: Docker Compose (Recommended)

Run on any machine with Docker. The fastest path to a running stack, and the path most teams use for both local development and production self-hosted deployments.

- Works on Linux, macOS, Windows
- All 22 services run with one `docker compose up -d`
- Full control over data and configuration
- Migrations apply automatically before app services start
- Requires Docker Desktop or Docker Engine

### Option 2: Railway (Managed Cloud)

Cloud-hosted, managed containers with managed PostgreSQL and Redis. Best for teams that want to skip server administration. The deploy script handles everything: creates the Railway project, prompts you to add the managed Postgres and Redis plugins (one click each in the dashboard — the only manual step), then walks the service catalog and creates all 19 services via Railway's public GraphQL API, configures each one's source repo, Dockerfile, healthcheck, and environment variables, and triggers the initial deploys. Total time: about 5–10 minutes from `./scripts/deploy.sh` to a running stack.

---

## Quick Start: Step-by-Step Setup

### Step 1: Clone the repository

```bash
git clone https://github.com/eoffermann/BigBlueBam.git
cd BigBlueBam
```

### Step 2: Launch the deploy script

The script checks for Node.js and Docker, installing them if needed.

**Linux / macOS:**
```bash
./scripts/deploy.sh
```

**Windows (PowerShell):**
```powershell
.\scripts\deploy.ps1
```

**Windows (Command Prompt):**
```batch
scripts\deploy.bat
```

> **Note:** Docker is required for the recommended Docker Compose path. The Railway option runs entirely in the cloud and doesn't need Docker locally.

### Step 3: Pick your platform

The script presents an interactive menu:

```
Where are you deploying?

  1. Docker Compose — Run locally or on any server with Docker (recommended)
  2. Railway — Managed cloud containers, fully automated
```

### Step 4: Configure your services

The script auto-generates secure passwords and asks a few simple questions:

```
How should BigBlueBam store uploaded files?

  1. Built-in storage (MinIO — simplest, included in the install)
  2. Amazon S3 (you'll need an AWS account)
  3. Cloudflare R2 (you'll need a Cloudflare account)
  4. Skip for now (file uploads won't work)
```

Similar prompts for vector search (Beacon knowledge base) and voice/video (Banter calls). Most teams just press Enter for the defaults — you can change everything later.

#### Advanced port mapping (optional)

If you're deploying to a NAS (Synology, QNAP, TrueNAS, Unraid) or any host where the BigBlueBam default ports (80, 443, 7880, 7881) are already in use, the script auto-detects the conflicts and walks you through remapping. See `scripts/deploy/shared/port-mapping.mjs` for the full list of ports it can remap. Default behavior on a clean laptop is "no questions asked" — the prompt only fires when conflicts are detected or you opt in.

#### Local TLS / SSL (optional)

When you opt into HTTPS-style URLs (the default for any non-localhost domain), the deploy script offers four ways to put a real certificate behind that promise:

1. **Self-signed (recommended baseline)** — the script generates a cert with `openssl` at deploy time. Browsers warn once per device, but TLS itself works correctly: cookies get the `Secure` flag, HSTS is honored, OAuth flows complete properly. Right answer if you just need TLS to function.
2. **Bring your own** — type the absolute paths to a cert and key you already have (corp PKI, wildcard, manually-fetched LE, etc.). The script validates the pair with `openssl` before copying into `./certs/`.
3. **mkcert** — if you have [mkcert](https://github.com/FiloSottile/mkcert) installed, the script can issue a cert signed by mkcert's local CA. Browsers on the deploy machine trust it automatically. Other client devices need the CA installed manually.
4. **Let's Encrypt** — auto-issues a real, public-trusted cert via certbot's HTTP-01 challenge. Requires a public domain pointing at your host with port 80 reachable from the internet (the prompt refuses cleanly if you remapped HTTP_PORT). Renewal is a daily cron entry the script prints for you to install.

The script also asks how plain HTTP and HTTPS should coexist: `redirect` (recommended), `both` (kept for LAN scripts that use plain http), or `https-only` (drops port 80 entirely).

For the full picture — sharp edges, deferred work, and design decisions — see [`local-ssl-notes.md`](./local-ssl-notes.md).

### Step 5: Deploy

- **Docker Compose**: Builds all containers locally, starts everything with `docker compose up`. Migrations run automatically before app services start.
- **Railway**: Logs in to your Railway account, creates the project, provisions managed PostgreSQL + Redis, then creates all 19 services via Railway's GraphQL API — setting source repo, Dockerfile, healthcheck, and environment variables on each, and triggering the initial deploys.

This takes 3–5 minutes on first run for Docker Compose; the Railway path runs unattended after you generate a Personal Access Token and click two buttons to add the managed Postgres and Redis plugins.

### Step 6: Create your admin account

```
Let's create your admin account.

Email address: you@yourcompany.com

Password:
  1. Generate a strong password for me (recommended)
  2. I'll type my own password
> 1

  Your generated password:

    Falcon-Copper-Ribbon-Sage42!

  ⚠  Copy this now — it will not be shown again.

  ✓ Password saved to macOS Keychain
    Service: "BigBlueBam"  Account: "you@yourcompany.com"

Your name: Jane Smith
Organization: Acme Corp

Creating account... ✓
Verifying login... ✓
```

The generated password uses a memorable word-based format that is both strong and easy to read. On macOS, Windows, and Linux desktops, the script can automatically save it to your system keychain.

> **Important:** This is a SuperUser account with full access to everything — all organizations, all settings, all data. Keep the password secure.

### Step 7: You're live!

```
BigBlueBam is running!

  Bam (Projects):     https://your-domain/b3/
  Helpdesk:           https://your-domain/helpdesk/
  Banter (Messaging): https://your-domain/banter/
  Beacon (Knowledge): https://your-domain/beacon/
  Brief (Documents):  https://your-domain/brief/
  Bolt (Automations): https://your-domain/bolt/
  Bearing (Goals):    https://your-domain/bearing/
  MCP Server:         https://your-domain/mcp/
```

---

## After Deployment

### Set up a custom domain

Configure your domain in the Railway dashboard or point your DNS to your server's IP address. BigBlueBam handles all routing through a single nginx reverse proxy on port 80.

### Configure AI providers

Go to **Settings → AI Providers** in the Bam admin panel. Add credentials for Anthropic, OpenAI, or any OpenAI API-compatible endpoint. This enables AI features across the suite, including Bolt's AI-assisted automation authoring.

### Invite your team

Create user accounts from the **People** page in Bam. Assign roles (Member, Admin, Owner) and add users to projects.

### Import existing data

BigBlueBam supports importing from CSV, Trello, Jira, and GitHub Issues. Use the import tools in **Settings → Integrations**.

### Set up email notifications

Configure SMTP settings in your environment variables or through the deploy script's reconfigure option:

```bash
./scripts/deploy.sh --reconfigure
```

---

## What's Running

BigBlueBam consists of 22 services, all managed through Docker Compose. The authoritative service catalog lives at `scripts/deploy/shared/services.mjs` — that's also what generates the per-service Railway manifests under `railway/`.

### Application Services

| Service | Port | Description |
|---------|------|-------------|
| api | 4000 | Main Bam API — tasks, sprints, boards, auth |
| helpdesk-api | 4001 | Helpdesk API — tickets, replies, SLAs, public portal |
| banter-api | 4002 | Banter API — messaging, channels, DMs, calls |
| beacon-api | 4004 | Beacon API — knowledge base, vector search, policies |
| brief-api | 4005 | Brief API — collaborative documents, templates |
| bolt-api | 4006 | Bolt API — automation engine, rules, executions |
| bearing-api | 4007 | Bearing API — goals, key results, progress |
| board-api | 4008 | Board API — whiteboards, real-time collab |
| bond-api | 4009 | Bond API — CRM contacts, companies, deals |
| blast-api | 4010 | Blast API — email campaigns, templates, tracking |
| bench-api | 4011 | Bench API — analytics, dashboards, widgets |
| book-api | 4012 | Book API — calendar events, booking pages |
| blank-api | 4013 | Blank API — forms, submissions, public portal |
| bill-api | 4014 | Bill API — invoices, payments, expenses |
| mcp-server | 3001 | MCP protocol server (~340 AI tools) |
| worker | — | Background job processor (BullMQ) |
| voice-agent | 4003 | AI voice agent (Python/FastAPI) |
| frontend | 80 | nginx reverse proxy serving all SPAs |
| site | 3000 | Marketing website (proxied at `/` by frontend) |

### Infrastructure Services

| Service | Port | Description |
|---------|------|-------------|
| PostgreSQL | 5432 | Primary database (managed on Railway) |
| Redis | 6379 | Cache, sessions, PubSub, job queues (managed on Railway) |
| MinIO | 9000 | S3-compatible file storage |
| Qdrant | 6333 | Vector search for semantic retrieval |
| LiveKit | 7880 | WebRTC server for voice/video |

---

## Environment Variables

Key environment variables (auto-generated by the deploy script):

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `SESSION_SECRET` | Session encryption key (32+ chars) |
| `INTERNAL_HELPDESK_SECRET` | Shared secret between Helpdesk and Bam APIs |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | S3 storage credentials |
| `CORS_ORIGIN` | Allowed origins for CORS |

Optional:

| Variable | Description |
|----------|-------------|
| `OAUTH_GOOGLE_CLIENT_ID` / `SECRET` | Google OAuth credentials |
| `OAUTH_GITHUB_CLIENT_ID` / `SECRET` | GitHub OAuth credentials |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Email notification settings |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit voice/video credentials |
| `QDRANT_URL` / `QDRANT_API_KEY` | Qdrant vector database connection |

---

## Choosing a Branch to Deploy

BigBlueBam uses a two-branch model:

- **`stable`** — the production branch. Every commit has been validated on `main` first and, where possible, exercised against a real deployment. **This is the default** and what you should pick for most deploys.
- **`main`** — the bleeding-edge integration branch. New features and fixes land here first. Pick `main` only when you specifically want the latest code and can tolerate the occasional rough edge.

The deploy script prompts you once (on the first run) to choose between `stable` and `main`. Your choice is saved in `.deploy-state.json` and reused on subsequent runs. To switch later, re-run with `--reconfigure` and pick the other branch.

Both the Docker Compose and Railway platform adapters honor the choice:
- **Docker Compose** uses the selected branch for `git fetch origin <branch>` and `git pull origin <branch>` on the upgrade path.
- **Railway** passes the branch to every service it creates, so Railway auto-rebuilds when commits land on it.

---

## Updating

**The recommended way to update is to re-run the deploy script.** It detects the existing installation, checks for new commits on your chosen branch (default: `stable`), forces a `--no-cache` rebuild of the API image (so new migration files can't be lost to stale build cache or WSL2 file sync), runs the database migrations explicitly, and restarts services:

```bash
./scripts/deploy.sh  # or deploy.ps1 on Windows
```

That's it — you don't need to `git pull` first; the script will offer to do it for you and report how many commits you're behind on the tracked branch.

### Updating manually

If you'd rather drive the update by hand, the sequence below matches what the deploy script does and avoids two traps that have bitten the project in the past (see [Migration failures](#migration-failures) for context). Substitute `stable` with `main` if you're on the bleeding-edge branch:

```bash
# 1. Pull the new code (default: stable — swap for main if you opted in)
git pull origin stable

# 2. Force a no-cache rebuild of the api image
#    (defeats stale build cache that can drop new migration files silently)
docker compose build --no-cache api

# 3. Run migrations explicitly
#    (the migrate sidecar is cached via service_completed_successfully
#     and will NOT re-run on a plain `up -d`, even with new migrations)
docker compose up -d postgres
docker compose run --rm migrate

# 4. Bring everything back up
docker compose up -d --build
```

You can verify the migration actually shipped:

```bash
# Confirm the file is in the image
docker compose run --rm migrate sh -c "ls /app/migrations | tail -5"

# Confirm the column/table exists in the live DB
docker compose exec postgres psql -U bigbluebam -d bigbluebam -c "\d <table_name>"
```

> **Important:** Never run `docker compose down -v` — the `-v` flag destroys all persistent data (database, uploads, cache). Use `docker compose down` (without `-v`) to stop services safely.

---

## Forward-Only Migration Policy

BigBlueBam uses a **forward-only** schema migration model. This has direct consequences for any operator running the stack:

- **All schema lives in `infra/postgres/migrations/NNNN_*.sql`.** The legacy `infra/postgres/init.sql` has been removed; do not expect it to exist.
- **Migrations auto-apply on every deploy.** The `migrate` docker-compose service is a `service_completed_successfully` dependency of `api`, `helpdesk-api`, `banter-api`, and `worker`. App containers will not start until the database is at the current schema version.
- **Upgrades for existing clients are zero-touch.** Pull the new image, `docker compose up -d`, migrations run, services start. There is no manual SQL step.
- **Migrations are immutable once applied.** The runner records a SHA-256 checksum of each applied migration's SQL body. Editing a file after it has been applied to any environment causes the runner to abort with `CHECKSUM MISMATCH`. If you need to amend applied schema, **create a new migration file**.
- **No rollback tooling is provided.** There are no `down` scripts. Destructive changes (drop column, drop table, rename) must use the **expand-contract** pattern:
  1. Additive migration (new column / new table) — old and new code both work
  2. Deploy application code that writes to both places / reads from the new place
  3. Backfill migration
  4. Contract migration (drop old column / old table) in a later release, after all running app versions have been upgraded
- **Schema changes are additive by default.** A migration should be safe to apply while the previous application version is still serving traffic.
- **Fresh installs and existing deployments converge on the same list.** There is no "baseline" vs "upgrade" split — the migrations folder is the single source of truth.

### What this means for early clients

If you are running BigBlueBam from a pre-migration-system snapshot (i.e., your database was created from the old `init.sql`), the `0000_init.sql` and subsequent migrations are written to be idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, etc.). On first run, the migrate service will record all historical migrations as applied without making destructive changes to your existing data.

Inspect what has been applied:

```bash
docker compose exec postgres psql -U bigbluebam -c \
  "SELECT id, applied_at FROM schema_migrations ORDER BY id;"
```

---

## WebSocket Proxy Requirements

BigBlueBam exposes three WebSocket endpoints through nginx:

| Path | Upstream | Purpose |
|---|---|---|
| `/b3/ws` | `api:4000` | BBB realtime (tasks, boards, sprints) |
| `/banter/ws` | `banter-api:4002` | Banter realtime (channels, messages, calls) |
| `/helpdesk/ws` | `helpdesk-api:4001` | Helpdesk realtime (tickets, typing, presence) |

Any proxy layer in front of nginx (cloud load balancer, CDN, reverse proxy) **must**:

- Forward the `Upgrade: websocket` and `Connection: upgrade` headers unmodified
- Allow long-lived connections (set idle timeout to at least 60s, preferably 300s+)
- Not buffer the WebSocket stream (`proxy_buffering off` on nginx-style proxies)
- Route all three WS paths to the correct backend service

When scaling any of the API services horizontally, cross-instance broadcast is handled by **Redis PubSub** — sticky sessions are *not* required, but Redis must be reachable from every replica.

---

## Deployment Tiers — Where to Go After Tier 1

The architecture is designed to support a progression from a single-machine Docker Compose deployment to a fully orchestrated Kubernetes cluster, with no application code changes between tiers. Tier 1 and Railway (managed cloud) are fully implemented today; Tiers 2 and 3 work via env-var swaps and `docker compose up --scale`; Tier 4 (Helm chart) is on the roadmap. The progression:

```mermaid
graph LR
    T1["Tier 1<br/>Single Machine<br/>Docker Compose<br/><i>1-10 users</i>"]
    T2["Tier 2<br/>Managed Data Layer<br/>Cloud DB + Redis + S3<br/><i>10-50 users</i>"]
    T3["Tier 3<br/>Horizontal Scaling<br/>Multiple API Replicas<br/><i>50-200 users</i>"]
    T4["Tier 4<br/>Kubernetes<br/>Full Orchestration<br/><i>200+ users</i>"]

    T1 -->|"Swap env vars"| T2
    T2 -->|"Add load balancer"| T3
    T3 -->|"Helm chart"| T4

    style T1 fill:#dbeafe,stroke:#2563eb
    style T2 fill:#d1fae5,stroke:#059669
    style T3 fill:#fef3c7,stroke:#d97706
    style T4 fill:#fce7f3,stroke:#db2777
```

### Tier 1: Single Machine Docker Compose

This is what the quickstart above sets up. Hardware requirements:

| Component | Minimum | Recommended |
|---|---|---|
| **CPU** | 2 cores | 4 cores |
| **RAM** | 4 GB | 8 GB |
| **Storage** | 20 GB SSD | 50 GB SSD |
| **Network** | 10 Mbps | 100 Mbps |

Resource allocation across services:

| Service | RAM | CPU |
|---|---|---|
| frontend | 128 MB | 0.25 |
| api | 512 MB | 1.0 |
| mcp-server | 256 MB | 0.5 |
| worker | 512 MB | 1.0 |
| postgres | 1 GB | 1.0 |
| redis | 256 MB | 0.25 |
| minio | 256 MB | 0.25 |
| **Total** | **~2.9 GB** | **~4.25** |

### Tier 2: Managed Data Layer

Replace self-hosted PostgreSQL, Redis, and MinIO with managed cloud services. Only environment variable changes required — no code changes.

```dotenv
# Replace PostgreSQL with managed service (AWS RDS, Cloud SQL, Neon, etc.)
DATABASE_URL=postgresql://user:pass@your-rds-instance.amazonaws.com:5432/bigbluebam?sslmode=require

# Replace Redis with managed service (ElastiCache, Upstash, etc.)
REDIS_URL=rediss://:password@your-redis.cache.amazonaws.com:6379

# Replace MinIO with S3 / R2 / GCS
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
S3_ACCESS_KEY=AKIA...
S3_SECRET_KEY=...
S3_BUCKET=bigbluebam-attachments
S3_REGION=us-east-1
```

Remove the data service definitions from `docker-compose.yml` (or override with a `docker-compose.cloud.yml`):

```yaml
# docker-compose.cloud.yml
services:
  postgres:
    profiles: ["disabled"]
  redis:
    profiles: ["disabled"]
  minio:
    profiles: ["disabled"]
```

Run with: `docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d`

**Benefits:** automated backups and point-in-time recovery, high availability and failover, managed patching and upgrades, monitoring and alerting built in.

### Tier 3: Horizontal Scaling

Scale application containers behind a load balancer. Data services remain managed.

```mermaid
graph TB
    LB["Load Balancer<br/>(nginx / ALB / Cloudflare)"]

    subgraph "Application Instances"
        API1["api (replica 1)"]
        API2["api (replica 2)"]
        API3["api (replica 3)"]
        MCP1["mcp-server (replica 1)"]
        MCP2["mcp-server (replica 2)"]
        W1["worker (replica 1)"]
        W2["worker (replica 2)"]
    end

    subgraph "Managed Data"
        PG["PostgreSQL (managed)"]
        Redis["Redis (managed)"]
        S3["S3 / R2"]
    end

    LB -->|"HTTP/WS"| API1
    LB -->|"HTTP/WS"| API2
    LB -->|"HTTP/WS"| API3
    LB -->|"SSE/HTTP"| MCP1
    LB -->|"SSE/HTTP"| MCP2

    API1 --> PG
    API2 --> PG
    API3 --> PG
    API1 --> Redis
    API2 --> Redis
    API3 --> Redis
    W1 --> Redis
    W2 --> Redis
    W1 --> PG
    W2 --> PG
```

Example nginx load-balancer block (WebSocket connections use Redis PubSub for cross-instance broadcasting — sticky sessions are not required):

```nginx
upstream api_backend {
    least_conn;
    server api-1:4000;
    server api-2:4000;
    server api-3:4000;
}

upstream mcp_backend {
    least_conn;
    server mcp-1:3001;
    server mcp-2:3001;
}

server {
    listen 443 ssl;

    location /b3/api/ {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /b3/ws {
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /helpdesk/api/ {
        proxy_pass http://helpdesk_api_backend;
        proxy_http_version 1.1;
    }

    location /helpdesk/ws {
        proxy_pass http://helpdesk_api_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }

    location /mcp/ {
        proxy_pass http://mcp_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
    }

    location /b3/ {
        alias /usr/share/nginx/html/b3/;
        try_files $uri $uri/ /b3/index.html;
    }

    location /helpdesk/ {
        alias /usr/share/nginx/html/helpdesk/;
        try_files $uri $uri/ /helpdesk/index.html;
    }

    location = / {
        return 302 /helpdesk/;
    }
}
```

Scale with Docker Compose:

```bash
docker compose up -d --scale api=3 --scale worker=2 --scale mcp-server=2
```

**Key considerations:**
- **WebSocket scaling**: Redis PubSub ensures events reach all connected clients regardless of which API instance they are connected to.
- **BullMQ scaling**: Worker instances coordinate via Redis. Jobs are distributed automatically.
- **Session consistency**: Sessions are stored in Redis, so any API instance can serve any user.

### Tier 4: Kubernetes

> **Status: planned, not yet implemented.** A Helm chart at `infra/helm/bigbluebam/` is on the roadmap (see `docs/plans/remaining-work-2026-04-16.md` Infrastructure → P1) but does not exist yet. The shape below is the design target; today's production target is Railway via the deploy script's Railway adapter, which provides equivalent multi-replica behavior for the application services without requiring k8s ops expertise.

Full orchestration via a Helm chart at `infra/helm/bigbluebam/`.

```
bigbluebam-production/
  deployments/
    api (3 replicas, HPA)
    mcp-server (2 replicas, HPA)
    worker (2 replicas)
    frontend (2 replicas)
  services/
    api-service (ClusterIP)
    mcp-service (ClusterIP)
    frontend-service (ClusterIP)
  ingress/
    main-ingress (TLS termination)
  configmaps/
    app-config
    nginx-config
  secrets/
    db-credentials
    redis-credentials
    s3-credentials
    session-secret
  hpa/
    api-hpa
    mcp-hpa
```

Install the chart:

```bash
kubectl create namespace bigbluebam
kubectl -n bigbluebam create secret generic db-credentials \
  --from-literal=DATABASE_URL="postgresql://..."
kubectl -n bigbluebam create secret generic app-secrets \
  --from-literal=SESSION_SECRET="..." \
  --from-literal=REDIS_URL="..."

helm install bigbluebam infra/helm/bigbluebam/ \
  --namespace bigbluebam \
  --values infra/helm/bigbluebam/values-production.yaml
```

Example HPA for the API:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

---

## Backup and Disaster Recovery

### PostgreSQL Backups

| Method | Frequency | Retention |
|---|---|---|
| **Logical backup** (`pg_dump`) | Daily | 30 days |
| **Point-in-time recovery** (WAL archiving) | Continuous | 7 days |
| **Managed service snapshots** | Daily | Per provider policy |

```bash
# Manual backup
docker compose exec postgres pg_dump -U bigbluebam -Fc bigbluebam > backup_$(date +%Y%m%d).dump

# Restore
docker compose exec -T postgres pg_restore -U bigbluebam -d bigbluebam < backup_20260402.dump
```

### Redis Backup

Redis uses AOF persistence. For managed services, use the provider's snapshot mechanism.

### MinIO / S3 Backup

Enable versioning on the S3 bucket. For MinIO, use `mc mirror` for cross-site replication:

```bash
mc mirror --watch minio/bigbluebam-attachments backup/bigbluebam-attachments
```

For Docker Compose, the data is in named volumes (`pgdata`, `redisdata`, `miniodata`, `qdrantdata`).

### Disaster Recovery Procedure

1. Provision new infrastructure (or restore from IaC)
2. Restore PostgreSQL from latest backup
3. Restore MinIO/S3 data
4. Update DNS to point to new infrastructure
5. Restart application containers
6. Verify health checks pass

---

## Health Checks and Monitoring

### Health Check Endpoints

| Endpoint | Via nginx | Internal Port | Purpose |
|---|---|---|---|
| `GET /b3/api/health` | Port 80 | 4000 (api) | Full health check (DB, Redis, MinIO connectivity) |
| `GET /mcp/health` | Port 80 | 3001 (mcp-server) | MCP server health + API connectivity |
| `GET /b3/api/health/live` | Port 80 | 4000 | Kubernetes liveness probe (is the process running?) |
| `GET /b3/api/health/ready` | Port 80 | 4000 | Kubernetes readiness probe (can it serve requests?) |

Each API service additionally has its own `/health` endpoint on its internal port for direct probing:

```bash
curl http://localhost:4000/health    # Main API
curl http://localhost:4004/health    # Beacon
curl http://localhost:4006/health    # Bolt
```

Health check response shape:

```json
{
  "status": "healthy",
  "version": "1.2.3",
  "uptime_seconds": 86400,
  "checks": {
    "database": "ok",
    "redis": "ok",
    "minio": "ok"
  }
}
```

If any check fails, the status becomes `"degraded"` and the HTTP status code changes to 503. This triggers container restarts (Docker health check) or pod replacement (Kubernetes readiness probe).

### Recommended Monitoring Stack

| Tool | Purpose | Integration |
|---|---|---|
| **Sentry** | Error tracking and performance monitoring | `@sentry/node` in API + `@sentry/react` in frontend |
| **Grafana** | Dashboards and visualization | Queries Prometheus and Loki |
| **Prometheus** | Metrics collection | Scrapes `/metrics` endpoint on API |
| **Loki** | Log aggregation | Collects Docker container logs |

### Key Metrics to Monitor

| Metric | Warning Threshold | Critical Threshold |
|---|---|---|
| API response time (P95) | > 500ms | > 2s |
| API error rate | > 1% | > 5% |
| WebSocket connections | > 80% of limit | > 95% of limit |
| PostgreSQL connections | > 70% of pool | > 90% of pool |
| Redis memory usage | > 70% of max | > 90% of max |
| Worker queue depth | > 100 jobs | > 1000 jobs |
| Disk usage | > 70% | > 90% |

Configure alerts in Grafana or your cloud provider's monitoring service for the thresholds above. Critical alerts should page on-call; warning alerts should notify a Slack channel.

---

## CI/CD Pipeline

```mermaid
flowchart LR
    Push["git push"]
    Lint["Lint<br/>(ESLint + Biome)"]
    Type["Typecheck<br/>(tsc --noEmit)"]
    Unit["Unit Tests<br/>(Vitest)"]
    Build["Build Images"]
    Integration["Integration Tests<br/>(Docker Compose)"]
    Push_GHCR["Push to GHCR"]
    Staging["Deploy to<br/>Staging"]
    Promote["Promote to<br/>Production"]

    Push --> Lint
    Push --> Type
    Push --> Unit
    Lint --> Build
    Type --> Build
    Unit --> Build

    Build -->|"PR"| Integration
    Integration -->|"PR passes"| Push_GHCR

    Build -->|"merge to main"| Push_GHCR
    Push_GHCR --> Staging

    Staging -->|"tag v*"| Promote

    style Push fill:#e0e7ff,stroke:#4f46e5
    style Promote fill:#fce7f3,stroke:#db2777
```

| Trigger | Actions |
|---|---|
| **Every push** | Lint (ESLint + Biome), typecheck (`tsc --noEmit`), unit tests (Vitest) |
| **Pull request** | Above + ephemeral Docker Compose stack for integration tests |
| **Merge to main** | Build Docker images, push to GHCR, deploy to staging |
| **Tag (`v*`)** | Promote staging images to production with zero-downtime rolling update |

### Environment Matrix

| Environment | Purpose | Data | URL | Deploy Trigger |
|---|---|---|---|---|
| **Local dev** | Developer workstations | Local Docker volumes | `localhost` | Manual |
| **CI/test** | Automated testing | Ephemeral (destroyed after test) | N/A | Every push/PR |
| **Preview** | PR review with live app | Seeded test data | `pr-123.preview.bigbluebam.io` | PR creation |
| **Staging** | Pre-production validation | Anonymized production copy | `staging.bigbluebam.io` | Merge to main |
| **Production** | Live service | Real data | `app.bigbluebam.io` | Tagged release |

---

## Troubleshooting

### Services won't start

Check logs for the failing service:
```bash
docker compose logs -f api          # Main API
docker compose logs -f frontend     # nginx / web UI
docker compose logs -f bolt-api     # Automations
```

### Port conflicts

If port 80 is already in use, set a custom port:
```bash
HTTP_PORT=8080 docker compose up -d
```

### Migration failures

If a migration fails, check the error in the migrate service logs:
```bash
docker compose logs migrate
```

Never edit an existing migration file — the runner tracks SHA-256 checksums and will abort on mismatch.

**"Column does not exist" errors after an update.** If an API service logs `PostgresError: column "X" does not exist` (SQLSTATE `42703`) after an update, the migration file either didn't make it into the rebuilt image or the cached `migrate` sidecar didn't re-run. Re-run the update with the deploy script (`./scripts/deploy.sh`), which forces both a no-cache image rebuild and an explicit migrate invocation.

**Bulletproof fallback** if Docker's build cache or WSL2 file sync refuses to pick up a new migration file, apply it directly:

```bash
# Apply the migration SQL against the running postgres container
cat infra/postgres/migrations/NNNN_new_migration.sql \
  | docker compose exec -T postgres psql -U bigbluebam -d bigbluebam

# Record it in schema_migrations so a future clean boot skips it
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c \
  "INSERT INTO schema_migrations (id, checksum) VALUES ('NNNN_new_migration.sql', 'manual') ON CONFLICT (id) DO NOTHING;"
```

### Health check failures

See [Health Checks and Monitoring](#health-checks-and-monitoring) above for per-service health endpoints and probe semantics.

### Reset everything

To start completely fresh (⚠️ this destroys all data):
```bash
docker compose down -v
./scripts/deploy.sh --reset
```

---

## FAQ

**How does the Railway deploy work?**
The deploy script's Railway path uses Railway's public GraphQL API to provision and configure every service in the stack. You generate a Personal Access Token at https://railway.com/account/tokens, paste it into the script, and it handles the rest: project creation, service creation (linked to the GitHub repo), per-service Dockerfile + healthcheck + environment variable configuration, and triggering the initial deploys. The only manual step is clicking "Add Postgres" and "Add Redis" in the Railway dashboard once, because Railway's public API doesn't expose plugin creation. Total run time: about 5–10 minutes from start to all services queued.

**How much will Railway cost?**
Railway offers a free Starter plan that includes $5 of usage per month. With 19 services + managed Postgres + Redis, expect to land in the Developer plan ($5/month + usage). Most small teams spend $20–40/month total once everything's running.

**Can I migrate between Railway and self-hosted?**
Yes — in either direction. Export your database with `pg_dump`, set up Docker Compose (or Railway) on the destination, import the dump, and update your DNS. The application code is identical.

**Can I use BigBlueBam without Docker?**
While Docker Compose is the recommended deployment, you can run each service natively with Node.js 22, PostgreSQL 16, Redis 7, and nginx. You would configure each service manually.

**What browsers are supported?**
All modern browsers: Chrome, Firefox, Safari, Edge. The UI uses React 19 with TailwindCSS and requires JavaScript enabled.

**How do I back up my data?**
See [Backup and Disaster Recovery](#backup-and-disaster-recovery) above.
