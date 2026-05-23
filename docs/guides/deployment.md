# Deployment Guide

BigBlueBam is Docker-native from day one. The architecture supports a progression from a single-machine Docker Compose deployment to a fully orchestrated Kubernetes cluster, with no application code changes required at any tier.

---

## Deployment Tiers

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

---

## Tier 1: Single Machine Docker Compose

The simplest deployment. Everything runs on one machine with `docker compose up`.

### Hardware Requirements

| Component | Minimum | Recommended |
|---|---|---|
| **CPU** | 2 cores | 4 cores |
| **RAM** | 4 GB | 8 GB |
| **Storage** | 20 GB SSD | 50 GB SSD |
| **Network** | 10 Mbps | 100 Mbps |

### Instructions

```bash
# 1. Clone and configure
git clone https://github.com/bigblueceiling/BigBlueBam.git
cd BigBlueBam
cp .env.example .env
# Edit .env with your secrets

# 2. Start the stack — the `migrate` service runs automatically
#    as a dependency of api / helpdesk-api / banter-api / worker
docker compose up -d

# 3. (Optional) Run migrations explicitly if you want to see the output
docker compose run --rm migrate

# 4. Create admin user
docker compose exec api node dist/cli.js create-admin \
  --email admin@yourcompany.com \
  --password your-secure-password \
  --name "Admin" \
  --org "Your Company"

# 5. Access at http://localhost (or your server IP)
```

### Resource Allocation

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

### TLS Configuration

For production, configure TLS in the nginx configuration:

```bash
# Place certificates in infra/nginx/
cp your-cert.pem infra/nginx/cert.pem
cp your-key.pem infra/nginx/key.pem

# Update .env
CORS_ORIGIN=https://your-domain.com
```

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

## Tier 2: Managed Data Layer

Replace self-hosted PostgreSQL, Redis, and MinIO with managed cloud services. Only environment variable changes required -- no code changes.

### Environment Variable Changes

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

### Docker Compose Changes

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

### Benefits

- Automated backups and point-in-time recovery
- High availability and failover
- Managed patching and upgrades
- Monitoring and alerting built in

---

## Tier 3: Horizontal Scaling

Scale application containers behind a load balancer. Data services remain managed.

### Architecture

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

### Load Balancer Configuration

WebSocket connections require sticky sessions or Redis PubSub for cross-instance broadcasting (already built in):

```nginx
# nginx load balancer example
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

### Scaling with Docker Compose

```bash
docker compose up -d --scale api=3 --scale worker=2 --scale mcp-server=2
```

### Key Considerations

- **WebSocket scaling**: Redis PubSub ensures events reach all connected clients regardless of which API instance they are connected to.
- **BullMQ scaling**: Worker instances coordinate via Redis. Jobs are distributed automatically.
- **Session consistency**: Sessions are stored in Redis, so any API instance can serve any user.

---

## Tier 4: Kubernetes

Full orchestration with the Helm chart at `infra/helm/bigbluebam/`.

### Namespace Layout

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

### Helm Chart Installation

```bash
# Add required secrets
kubectl create namespace bigbluebam
kubectl -n bigbluebam create secret generic db-credentials \
  --from-literal=DATABASE_URL="postgresql://..."
kubectl -n bigbluebam create secret generic app-secrets \
  --from-literal=SESSION_SECRET="..." \
  --from-literal=REDIS_URL="..."

# Install
helm install bigbluebam infra/helm/bigbluebam/ \
  --namespace bigbluebam \
  --values infra/helm/bigbluebam/values-production.yaml
```

### Horizontal Pod Autoscaler (HPA)

```yaml
# Example HPA for the API
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

### Disaster Recovery Procedure

1. Provision new infrastructure (or restore from IaC)
2. Restore PostgreSQL from latest backup
3. Restore MinIO/S3 data
4. Update DNS to point to new infrastructure
5. Restart application containers
6. Verify health checks pass

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

### Pipeline Stages

| Trigger | Actions |
|---|---|
| **Every push** | Lint (ESLint + Biome), typecheck (`tsc --noEmit`), unit tests (Vitest) |
| **Pull request** | Above + ephemeral Docker Compose stack for integration tests |
| **Merge to main** | Build Docker images, push to GHCR, deploy to staging |
| **Tag (`v*`)** | Promote staging images to production with zero-downtime rolling update |

---

## Environment Matrix

| Environment | Purpose | Data | URL | Deploy Trigger |
|---|---|---|---|---|
| **Local dev** | Developer workstations | Local Docker volumes | `localhost` | Manual |
| **CI/test** | Automated testing | Ephemeral (destroyed after test) | N/A | Every push/PR |
| **Preview** | PR review with live app | Seeded test data | `pr-123.preview.bigbluebam.io` | PR creation |
| **Staging** | Pre-production validation | Anonymized production copy | `staging.bigbluebam.io` | Merge to main |
| **Production** | Live service | Real data | `app.bigbluebam.io` | Tagged release |

---

## Monitoring Stack

### Recommended Tools

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

### Alerting

Configure alerts in Grafana or your cloud provider's monitoring service for the thresholds above. Critical alerts should page on-call. Warning alerts should notify a Slack channel.

---

## Health Check Endpoints

| Endpoint | Via nginx | Internal Port | Purpose |
|---|---|---|---|
| `GET /b3/api/health` | Port 80 | 4000 (api) | Full health check (DB, Redis, MinIO connectivity) |
| `GET /mcp/health` | Port 80 | 3001 (mcp-server) | MCP server health + API connectivity |
| `GET /b3/api/health/live` | Port 80 | 4000 | Kubernetes liveness probe (is the process running?) |
| `GET /b3/api/health/ready` | Port 80 | 4000 | Kubernetes readiness probe (can it serve requests?) |

### Health Check Response

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
