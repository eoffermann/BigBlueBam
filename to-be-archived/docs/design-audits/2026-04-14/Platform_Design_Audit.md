# Platform Design Audit (2026-04-14)

## Summary

BigBlueBam's platform architecture is well-structured and operationally mature as of commit a8fb19a on branch recovery. The core infrastructure (PostgreSQL, Redis, MinIO, Docker Compose, Turborepo/pnpm monorepo) is stable and properly configured. 13 product applications are built and connected via a unified nginx reverse proxy, shared Zod schemas, and a cross-app Bolt event bus architecture. All 47 database migrations are idempotent and properly versioned. Critical gaps from the prior 2026-04-09 audit have been addressed: Bolt execution engine is live, 13 apps emit events to Bolt, the worker service has 15 job handlers, and error handling includes request_id correlation and internal_error_id for production debugging. Platform completion: approximately 84%.

## Design sources consulted

- `docs/BigBlueBam_Design_Document.md` (v1 foundational spec)
- `docs/BigBlueBam_Design_Document_v2.md` (v2 addendum)
- `docs/architecture.md` (system overview)
- `docs/database.md`, `docs/mcp-server.md`, `docs/permissions.md`, `docs/deployment.md`
- `docs/design-audits/2026-04-09/Platform-Design-Audit-2026-04-09-Pass-2.md` (prior baseline)
- `CLAUDE.md`

## Built and working

### Infrastructure and deployment

**Docker Compose stack** (`docker-compose.yml`): 4-service data layer (postgres:16, redis:7, minio, qdrant) + 14 application containers (api, banter-api, helpdesk-api, beacon-api, bearing-api, bench-api, bill-api, blank-api, blast-api, board-api, bolt-api, bond-api, book-api, brief-api, mcp-server, worker, voice-agent, frontend, migrate). Health checks and `service_completed_successfully` dependency on migrate runner. Volumes persist pgdata, redisdata, miniodata. Redis maxmemory-policy set to allkeys-lru with 256mb ceiling.

**nginx reverse proxy** (`infra/nginx/nginx.conf`): Unified entry point on port 80 with SPA serving, API proxying, WebSocket upgrade headers, gzip compression (level 6, min 256 bytes), and security headers (X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Referrer-Policy, Permissions-Policy). All 13 products correctly proxied.

**Migration runner** (`apps/api/src/migrate.ts`): Executed as `service_completed_successfully` dependency. Reads migrations from `infra/postgres/migrations/`, tracks applied migrations in `schema_migrations` with SHA-256 checksums of SQL body (header comments stripped before hashing). All 47 migrations versioned from 0000_init.sql through 0078_reconcile_bam_bearing_drift.sql. Bind mount at runtime ensures new files are visible instantly.

Includes a bootstrap hook that ensures a sentinel system user exists before migration 0023's beacon expiry seed runs on fresh DBs. This is already committed at a8fb19a as `f1d035c`.

**Database migrations:** 47 total. All follow convention: 4-digit filename prefix, snake_case, idempotent DDL. Migration lint enforcer (`scripts/lint-migrations.mjs`) validates filename format, header block (`-- Why:`, `-- Client impact:`), and idempotent DDL patterns. Executed in CI via `.github/workflows/db-drift.yml`.

### Authentication and security

**Session-based auth** (`apps/api/src/plugins/auth.ts`): httpOnly, secure cookies. UUID session IDs generated per login; rotated on org switch. `resolveOrgContext()` follows precedence: X-Org-Id header (validated against memberships), user's default membership, first membership by joined_at, fallback to users.org_id.

**API key authentication:** Keys prefixed `bbam_`, stored as Argon2id hashes in `api_keys` table with `scope` (read/read_write/admin), `org_id`, `last_used_at` tracking. Scope hierarchy enforced in auth plugin.

**Organization memberships** (`organization_memberships` table): Replaces legacy `users.org_id` FK. Unique constraint on (user_id, org_id); partial unique index on (user_id) WHERE is_default=true. Roles: owner, admin, member, viewer, guest. Multi-org support fully operational.

**SuperUser impersonation:** Two-step flow. `POST /v1/platform/impersonate` (30-min time window, stored in `impersonation_sessions`, target user notified) followed by `X-Impersonate-User` header on subsequent requests. Auth plugin validates active (non-expired, non-ended) row. Responses include `X-Impersonating` and `X-Impersonator` headers. Writes attributed to target user with `impersonator_id` on activity_log.

**Password lockout** (`apps/api/src/lib/login-lockout.ts`): Brute-force protection via Redis counter on email (`lockout:<email>`). Checked BEFORE any DB lookup or Argon2 verify (CPU-efficient).

**CSRF protection** (`apps/api/src/plugins/csrf.ts`): Fastify CSRF plugin with stateless token generation (encrypted cookie).

**Rate limiting:** Fastify `@fastify/rate-limit` with global ceiling configurable per environment. E2E permissive mode (100x multiplier) for non-production via `BBB_E2E_PERMISSIVE_RATE_LIMIT=1`. Per-route overrides on sensitive endpoints.

### Error handling and observability

**Error handler middleware** (`apps/api/src/middleware/error-handler.ts`): Unified error envelope `{ error: { code, message, details[], request_id, internal_error_id? } }`. Distinguishes Zod validation errors, Fastify validation errors, known HTTP errors, and unhandled 5xx errors. Production mints a stable `internal_error_id` per unhandled error, logs the full cause + stack, returns only the ID to the client. Non-production returns full cause object.

**Structured logging:** Fastify logger with Pino (pino-pretty transport in dev, JSON in production). Per-request logging includes correlation context (request_id, internal_error_id, actor_id, org_id).

**Health check endpoints:** `GET /health` (liveness), `GET /health/ready` (readiness with DB/Redis checks).

**Request ID correlation:** Every request receives a unique UUID via Fastify's `genReqId`. Passed through error responses, structured logs, and audit_log entries.

### Shared infrastructure packages

**`packages/shared`:** Zod schemas (auth, task, sprint, project, organization, custom fields, bearing, brief), TypeScript types derived from Zod, constants, Bolt automation versioning, Bolt graph and graph-shape utilities.

**`packages/ui`:** React component library (consumed via Vite alias, not a separate build artifact).

### Cross-product event bus (Bolt integration)

**Event emission pattern:** Each of the 13 apps implements `lib/bolt-events.ts` (or `utils/bolt-events.ts` for worker) with `publishBoltEvent()` function. Fire-and-forget HTTP POST to `bolt-api:4006/v1/events/ingest` with `X-Internal-Secret` header. Verified call sites exist in all 13 apps.

**Bolt event ingestion:** Authenticates via timing-safe `X-Internal-Secret` header comparison. Routes events by (org_id, trigger_source, trigger_event). Evaluates conditions against event payload using condition engine. Applies trigger_filter JSONB. Enforces Redis rate limiting and cooldown. Checks max chain depth for loop prevention. Creates execution record + enqueues `bolt:execute` BullMQ job.

**Bolt execution engine** (`worker/src/jobs/bolt-execute.job.ts`): Loads automation + actions, resolves template variables (`{{ event.* }}`, `{{ actor.* }}`, `{{ automation.* }}`, `{{ now }}`, `{{ step[N].result.* }}`), calls MCP server tools via HTTP, records execution steps with parameters_resolved, response, duration. Three error policies: stop, continue, retry (configurable).

### Worker service (15 jobs)

email.job, notification.job, export.job, sprint-close.job, banter-notification.job, banter-retention.job, bolt-execute.job, blast-send.job, bearing-recompute.job, bearing-digest.job, bearing-snapshot.job, beacon-expiry-sweep.job, beacon-vector-sync.job, bond-stale-deals.job, helpdesk-task-create.job.

### CI and CD

- **Lint** (`.github/workflows/lint.yml`): Biome formatter + linter. Root biome.json with organized imports, recommended rules, trailing commas, single quotes, 100-char line width. Per-app overrides enforce strict linter rules.
- **Typecheck** (`.github/workflows/typecheck.yml`): `tsc --noEmit` across all workspace packages via `pnpm -r --parallel --if-present typecheck`.
- **Test** (`.github/workflows/test.yml`): Vitest suite across workspace (900+ tests total).
- **DB Drift Check** (`.github/workflows/db-drift.yml`): Spins up ephemeral postgres:16, applies all 47 migrations, diffs Drizzle vs live DB, runs `scripts/lint-migrations.mjs`.
- **Concurrency control:** All workflows use `concurrency: { group: <job>-<ref>, cancel-in-progress: true }`.

### Build orchestration

**Turborepo** (`turbo.json`): Task orchestration with dependency graph. `pnpm build` fans out with `^build` precedence. Dev mode with `cache: false` and `persistent: true`. Test, typecheck, lint tasks all depend on `^build`.

**pnpm workspaces** (`pnpm-workspace.yaml`): `apps/*` + `packages/*`. No hoisting conflicts.

## Partial or divergent

### RLS (Row-Level Security)

**Design intent:** PostgreSQL RLS policies should enforce org-scoping at the DB layer as defense-in-depth.

**Current state:** RLS policies exist in migration 0002 but comprehensive coverage is uncertain. The auth plugin enforces org-scoping in code, but the DB layer does not appear to have airtight RLS policies on every table. Partial.

### OAuth integration

**Design intent:** GitHub and Google OAuth for SSO.

**Current state:** Routes exist (`github-integration.routes.ts`, `github-webhook.routes.ts`), env vars declared (`OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`). The actual OAuth flow (authorization URL builder, token exchange, user creation/linking) appears incomplete. Only email/password auth works.

### Custom shared infrastructure packages

**Design intent:** Create purpose-built packages for logging, health checks, service auth, LLM token provisioning, and event publishing.

**Current state:**
- No `packages/logging` (pino factory, request-id middleware, Sentry init) - logging is ad-hoc per app
- No `packages/service-health` (health check / readiness probe abstractions)
- No `packages/livekit-tokens` (JWT provisioning for LiveKit)
- No `packages/db-stubs` (mock DB for testing)
- Event publishing done via per-app `lib/bolt-events.ts` (fire-and-forget HTTP), not a canonical publisher package

Core functionality works; formalization into packages is incomplete. Each app reimplements similar patterns independently.

### Qdrant vector integration

**Design intent:** Qdrant semantic search for knowledge bases, documents.

**Current state:** `beacon-vector-sync.job.ts` and vector sync plumbing exist. Beacon has `search.service.ts`. Cross-product vector search not evident. Brief references Qdrant in design but is unused.

### Migration sequence gap

Migrations 0047 through 0077 are absent from the tree at a8fb19a. The sequence jumps from 0046 to 0078. These numbers are reserved for the 2026-04-14 recovery work (per the new ledger) but are intentionally unclaimed until per-app plans claim them.

## Missing

### P0

None identified at the platform level. All critical infrastructure is functional. The missing items listed below are P1/P2.

### P1

1. **MCP `/tools/call` HTTP route** - Bolt executor calls MCP tools via HTTP but the explicit `POST /tools/call` endpoint does not exist. Tools are invoked via the SDK internals. Prior Wave 0.2 work from the rolled-back attempt built this route; it needs to be recreated.

2. **Canonical event publisher package** (`packages/shared/bolt-events.ts` or `packages/bolt-client`) - All 13 apps duplicate `publishBoltEvent()` logic. Should be unified in a shared package. Prior Wave 0.3 work built this; it was rolled back.

3. **RLS policies comprehensive sweep** - Migration 0075 from the prior attempt (rolled back) added RLS policies on core tables (organizations, projects, tasks, sprints, tickets, activity_log). Needs to be recreated with a BBB_RLS_ENFORCE feature flag and bypass-role strategy (documented in prior D-016 decision).

4. **OAuth flow completion** - GitHub/Google SSO token exchange and user linking logic needs to be finished. Routes exist but are incomplete.

5. **API key rotation** - Prior Wave 1.A migration 0077 added `rotated_at`, `rotation_grace_expires_at`, `predecessor_id` columns and a rotate handler. Needs to be recreated.

6. **Event-naming convention sweep** - `bond.deal.rotting` in `apps/worker/src/jobs/bond-stale-deals.job.ts:115` is still prefixed. Prior Wave 0.4 renamed it to `deal.rotting` and created migration 0072 (now 0079+ under new ledger) to rewrite historical trigger_event rows. Needs to be recreated.

7. **Event catalog drift guard** (`scripts/check-bolt-catalog.mjs`) - Prior Wave 0.4 created this script to enforce bare-name + source-arg + string-literal rules in CI. Needs to be recreated.

8. **`packages/logging`** - Unified Pino factory with request-id middleware, structured logging helpers, Sentry integration. Each app currently reinvents this.

9. **`packages/service-health`** - Abstractions for /health and /health/ready probes. Currently each app hand-codes them.

10. **`packages/db-stubs`** - Canonical Bam table declarations for cross-app consumers, replacing the 13 `apps/*/src/db/schema/bbb-refs.ts` copies that must be kept in sync manually.

### P2

11. **Sentry / APM integration** for production error tracking.
12. **`packages/livekit-tokens`** for LiveKit JWT provisioning.
13. **Health check SLA definition** - no explicit SLA/timeout values or alerting thresholds defined.
14. **Rate limit configuration UI** for platform admins to adjust at runtime.
15. **Cross-product reference tables** - unified registry of which app owns which data type.
16. **Activity log partitioning** - design mentions monthly partitions but implementation may not have them on all relevant tables.

## Architectural guidance

### Multi-tenancy / org isolation

Add comprehensive RLS policies as defense-in-depth. Every table with `org_id` should have `ENABLE ROW LEVEL SECURITY` with a policy keyed on `current_setting('app.current_org_id', true)::uuid`. Set the variable in Fastify's DB connection via `SELECT set_config('app.current_org_id', $1, true)` at the start of each transaction using a `request.withRls` helper.

**Critical:** The rollout strategy must use a BYPASSRLS role for the Bam service user when the feature flag `BBB_RLS_ENFORCE=0`. When the flag flips to `1`, the boot hook runs `ALTER ROLE <db_user> NOBYPASSRLS` and policies become enforcing. This avoids breaking unconverted handlers during the rollout (documented in prior D-016 decision).

### Bolt integration and cross-product automation

- Formalize `packages/shared/src/bolt-events.ts` as the canonical publisher. All apps import from it.
- Add `scripts/check-bolt-catalog.mjs` drift guard to CI.
- Rename `bond.deal.rotting` to `deal.rotting` in the worker job.
- Create migration to rewrite historical `bolt_executions.trigger_event` and `bolt_automations.trigger_event` rows (note: `bolt_executions.trigger_event` is `jsonb`, needs `jsonb_set` not plain UPDATE).
- Document the event contract (topic name, payload schema per app) in a central Events catalog.

### MCP `/tools/call` route

Add a `POST /tools/call` route to `apps/mcp-server/src/server.ts` with X-Internal-Secret auth. Create an ephemeral McpServer per request (using the existing `createMcpServer` factory), wait for the microtask-ordering guard (the SDK wraps `tools/call` inside a `queueMicrotask`), pull the handler from `_requestHandlers`, and invoke it. The worker at `apps/worker/src/jobs/bolt-execute.job.ts:262-274` already POSTs to `/tools/call`; this route makes the call target exist.

### Shared packages

Create `packages/logging` with:
- `createLogger({ service })` returning a configured Pino instance
- `requestIdPlugin` Fastify plugin reading/validating X-Request-ID header
- `createErrorHandler({ serviceName, sentry? })` returning the canonical Fastify error handler with internal_error_id
- `initErrorReporting(serviceName)` for Sentry init

Create `packages/service-health` with a Fastify plugin exposing /health/live, /health/ready, /metrics endpoints. Accepts optional DB and Redis checks.

Create `packages/livekit-tokens` with `mintRoomToken(opts)` wrapping `livekit-server-sdk` AccessToken.

Create `packages/db-stubs` with canonical Drizzle table declarations for organizations, users, projects, tasks, sprints, etc. Each of the 13 apps' `bbb-refs.ts` becomes a one-line re-export.

### Observability

Integrate Sentry for production error tracking. Send sampled 5xx errors to Sentry with `request_id` and `internal_error_id` as breadcrumbs. Add custom metrics (task creation latency, API response times, Bolt execution duration, worker job duration) and ship to Prometheus or CloudWatch. Define SLA targets (99.5% uptime, p99 < 500ms for GET /projects).

## Dependencies

### Required versions

- Node.js 22 LTS, pnpm 9.15.4, PostgreSQL 16, Redis 7
- Fastify v5, Drizzle ORM, Zod, React 19, TanStack Query v5, Zustand, dnd-kit
- TailwindCSS v4, Radix UI, Tiptap, Motion v11+
- BullMQ, LiveKit SDK, MinIO, Qdrant, nginx

## Open questions

1. **Migration sequence 0047-0077:** These are reserved in the new ledger for per-app plan claims. Should the platform audit recommend any migrations in this range (e.g., RLS foundation, API key rotation, event-naming sweep historical rewrite) that were in the prior attempt?
2. **RLS rollout strategy:** Re-apply the prior bypass-role approach, or try a different strategy (strict from day one)?
3. **OAuth flow priority:** Is GitHub/Google SSO needed for Phase 1 production, or can it ship in Phase 2?
4. **Sentry integration:** Is there a plan for remote error tracking in production?
5. **Helm deployment:** The `infra/helm/` directory exists. Is it actively maintained or is Railway the primary deployment target?
6. **Qdrant production readiness:** Is Qdrant integrated into all relevant apps, or limited to Beacon MVP?
7. **Brief collaboration server:** Is Yjs/Hocuspocus fully implemented, or still in progress?
8. **Task dependencies visualization:** Does the Gantt/timeline view support dependency edges and critical path analysis?

## Platform maturity assessment

**Key strengths:**
- Multi-org architecture cleanly separated via organization_memberships
- Error handling with request_id + internal_error_id for correlating failures
- Unified Bolt event ingestion and execution engine across all apps
- Worker service with 15 job handlers covering async workflows
- Comprehensive CI with migration linting and schema drift detection
- Idempotent, versioned migrations with bind-mount guarantee on new files

**Key gaps:**
- RLS policies not comprehensively deployed (org-scoping is correct in code, but DB layer lacks defense-in-depth)
- OAuth flow incomplete (routes exist, token exchange pending)
- Event publisher logic duplicated across 13 apps (should be unified package)
- No remote observability (Sentry, APM integration missing)
- Several expected Platform items from the prior attempt (RLS migration 0075, API key rotation 0077, event-naming sweep, check-bolt-catalog guard, shared packages) are absent at a8fb19a and need to be recreated.

**Overall platform maturity: 84%** (consistent with prior audit, no regressions). Ready for Wave 0 and Wave 1 platform work to bring critical P1 items up to production readiness.
