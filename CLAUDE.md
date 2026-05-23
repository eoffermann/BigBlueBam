# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BigBlueBam is a web-based, multi-user Kanban project planning tool with sprint-based task management. It supports multiple concurrent projects with fully configurable phases, task states, custom fields, and carry-forward mechanics. Target audience is small-to-medium teams (2-50 users).

The authoritative design specification is `docs/reference/BigBlueBam_Design_Document.md` (with the `_v1_Addendum.md` sibling for post-v1 additions). Consult it for detailed data models, API contracts, MCP tool schemas, animation specs, and UI layouts.

## Tech Stack

**Frontend (SPA):** React 19, Motion (v11+, formerly Framer Motion), TanStack Query v5, Zustand, dnd-kit, TailwindCSS v4, Radix UI, Tiptap (rich text), React Hook Form + Zod

**API:** Node.js 22 LTS, Fastify v5, Drizzle ORM, Zod (shared validation schemas with client), Socket.IO or native WebSocket + Redis PubSub, BullMQ

**Data:** PostgreSQL 16 (RLS, JSONB custom fields, partitioned activity log), Redis 7 (sessions, cache, pubsub, queues), MinIO/S3 (attachments), Qdrant (vector search for Beacon, Brief, and Bond semantic retrieval)

**MCP Server:** `@modelcontextprotocol/sdk`, Streamable HTTP + SSE + stdio transports, runs as sidecar container on internal :3001, exposed at `/mcp/` via nginx on port 80

## Architecture

Monorepo managed with **Turborepo** and **pnpm workspaces**.

```
apps/
  api/              Fastify REST API + WebSocket server (internal :4000, proxied at /b3/api/). 40 route files, 38 Drizzle schema modules, ~119 source files.
  frontend/         React SPA served by nginx at /b3/ (port 80). ~87 source files, 8+ pages, command palette, keyboard shortcuts.
  banter-api/       Banter Fastify REST API + WebSocket (internal :4002, proxied at /banter/api/). 17 route files, 19 schema modules, ~60 source files.
  banter/           Banter React SPA served by nginx at /banter/. ~46 source files, 7 pages (BETA).
  mcp-server/       MCP protocol server (internal :3001, proxied at /mcp/). 340 tools across 43 modules (54 Bam core + 53 Banter + 30 Beacon + 23 Bond + 18 Brief + 16 Bill + 14 Board + 14 Blast + 13 Bolt + 12 Bearing + 11 Helpdesk + 11 Book + 11 Blank + 11 Bench + 49 cross-cutting platform: agent identity/audit/heartbeat, proposals, visibility preflight, unified activity, cross-app search, fuzzy resolver, composite views, entity links, attachments, agent policies, outbound webhooks, bolt observability, dedupe, phrase counts, expertise, pattern subscriptions, mixed availability, ingest fingerprint). Also hosts an internal POST /tools/call route for server-to-server invocations (Wave 0.2). confirm_action tokens are Redis-backed (mcp:confirm_token:<token> with PX TTL) with a graceful in-process fallback; the TTL is dynamic (5 min for human approvers, 60 s for agent-to-agent chains) and the register-tool wrapper enforces the §15 agent_policies kill switch + allowlist check on every service-account invocation.
  worker/           BullMQ background job processor (no exposed port). 16 job handlers (email, notification, export, sprint-close, banter-notification, banter-retention, bond-stale-deals, beacon-expiry-sweep, beacon-vector-sync, bearing-digest, bearing-recompute, bearing-snapshot, blast-send, bolt-execute, bolt-schedule-tick, helpdesk-task-create).
  helpdesk-api/     Helpdesk Fastify API (internal :4001, proxied at /helpdesk/api/). 6 route files, 12 schema modules.
  helpdesk/         Helpdesk React SPA served by nginx at /helpdesk/.
  beacon-api/       Beacon Fastify API (internal :4004, proxied at /beacon/api/). 9 route files, 12 schema modules. Knowledge base, search, graph, policies.
  beacon/           Beacon React SPA served by nginx at /beacon/. Knowledge home, graph explorer, editor.
  brief-api/        Brief Fastify REST API + WebSocket (internal :4005, proxied at /brief/api/). 9 route files, 10 schema modules.
  brief/            Brief React SPA served by nginx at /brief/.
  bolt-api/         Bolt Fastify REST API (internal :4006, proxied at /bolt/api/). 6 route files, 9 schema modules. Workflow automation engine, rules, executions.
  bolt/             Bolt React SPA served by nginx at /bolt/. Visual rule builder, execution log, templates.
  bearing-api/      Bearing Fastify API (internal :4007, proxied at /bearing/api/). 4 route files, 9 schema modules. Goals, key results, progress, reporting.
  bearing/          Bearing React SPA served by nginx at /bearing/. Goal dashboard, timeline, detail views.
  board-api/        Board Fastify REST API + WebSocket (internal :4008, proxied at /board/api/). 9 route files, 10 schema modules. Whiteboard rooms, shapes, assets, conferencing.
  board/            Board React SPA served by nginx at /board/. Infinite canvas, real-time collaboration, audio conferencing.
  bond-api/         Bond Fastify REST API (internal :4009, proxied at /bond/api/). 9 route files, 14 schema modules. Contacts, companies, deals, pipeline, activities, notes.
  bond/             Bond React SPA served by nginx at /bond/. Pipeline board, contact/company detail, deal tracking.
  blast-api/        Blast Fastify REST API (internal :4010, proxied at /blast/api/). 7 route files, 9 schema modules. Email campaigns, templates, segments, tracking, analytics.
  blast/            Blast React SPA served by nginx at /blast/. Campaign manager, template editor, segment builder, analytics dashboard.
  bench-api/        Bench Fastify REST API (internal :4011, proxied at /bench/api/). 4 route files, 7 schema modules. Dashboards, widgets, query execution, scheduled reports, materialized views.
  bench/            Bench React SPA served by nginx at /bench/. Dashboard list, canvas editor, widget wizard, ad-hoc explorer, reports, settings.
  book-api/         Book Fastify REST API (internal :4012, proxied at /book/api/). 8 route files, 10 schema modules. Scheduling, public booking pages, event management.
  book/             Book React SPA served by nginx at /book/.
  blank-api/        Blank Fastify REST API (internal :4013, proxied at /blank/api/). 4 route files, 5 schema modules. Forms, submissions, conditional logic routing.
  blank/            Blank React SPA served by nginx at /blank/.
  bill-api/         Bill Fastify REST API (internal :4014, proxied at /bill/api/). 8 route files, 11 schema modules. Invoicing, expenses, PDF generation, recurring billing.
  bill/             Bill React SPA served by nginx at /bill/.
  voice-agent/      AI voice agent (Python/FastAPI, internal :4003). LiveKit Agents SDK, STT/TTS pipeline (placeholder).
  integration-tests/  Cross-app integration harness (Wave 3). Vitest runner + mock service clients exercising cross-app event flows.
  e2e/              Playwright end-to-end suite.
packages/
  shared/           Shared Zod schemas, types, constants, and the canonical publishBoltEvent helper (@bigbluebam/shared).
  ui/               Shared React component library (@bigbluebam/ui).
  logging/          Structured pino logger factory shared across every Node service (@bigbluebam/logging, added Wave 1.A).
  service-health/   Shared /healthz + /readyz plugin used by every Fastify service (@bigbluebam/service-health, added Wave 1.A).
  db-stubs/         Shared Drizzle stubs and helpers for tests and isolated DB bootstraps (@bigbluebam/db-stubs, added Wave 1.A).
  livekit-tokens/   LiveKit access-token minting shared by board-api and voice-agent callers (@bigbluebam/livekit-tokens, added Wave 1.A).
infra/
  postgres/         migrations/ (numbered, idempotent SQL migrations). 140 files as of tip 0140_agent_runner_webhooks.sql (Wave 5 §20 outbound webhooks).
  nginx/            nginx.conf, certs.
  livekit/          LiveKit SFU configuration (livekit.yaml).
  helm/             Kubernetes Helm chart (bigbluebam/).
scripts/            Utility scripts: deploy adapters, seed-all.mjs master orchestrator, per-app seeders, check-bolt-catalog.mjs drift guard, db-check.mjs, lint-migrations.mjs, and screenshot generators.
```

The entire stack runs via `docker compose up`. All services are accessed through a single nginx container on port 80:

- `http://DOMAIN/` redirects to `/helpdesk/`
- `http://DOMAIN/b3/` serves the Bam SPA
- `http://DOMAIN/b3/api/` proxies to the Fastify REST API
- `http://DOMAIN/b3/ws` proxies WebSocket connections
- `http://DOMAIN/banter/` serves the Banter SPA (beta)
- `http://DOMAIN/banter/api/` proxies to the Banter REST API
- `http://DOMAIN/banter/ws` proxies Banter WebSocket connections
- `http://DOMAIN/beacon/` serves the Beacon knowledge base SPA
- `http://DOMAIN/beacon/api/` proxies to the Beacon API
- `http://DOMAIN/brief/` serves the Brief collaborative document editor SPA
- `http://DOMAIN/brief/api/` proxies to the Brief API
- `http://DOMAIN/bolt/` serves the Bolt workflow automation SPA
- `http://DOMAIN/bolt/api/` proxies to the Bolt API
- `http://DOMAIN/bearing/` serves the Bearing Goals and OKRs SPA
- `http://DOMAIN/bearing/api/` proxies to the Bearing API
- `http://DOMAIN/board/` serves the Board visual collaboration SPA
- `http://DOMAIN/board/api/` proxies to the Board API
- `http://DOMAIN/board/ws` proxies Board WebSocket connections
- `http://DOMAIN/bond/` serves the Bond CRM SPA
- `http://DOMAIN/bond/api/` proxies to the Bond API
- `http://DOMAIN/blast/` serves the Blast Email Campaigns SPA
- `http://DOMAIN/blast/api/` proxies to the Blast API
- `http://DOMAIN/t/` proxies Blast tracking endpoints (open pixel, click redirect)
- `http://DOMAIN/unsub/` proxies Blast unsubscribe endpoint
- `http://DOMAIN/bench/` serves the Bench Analytics SPA
- `http://DOMAIN/bench/api/` proxies to the Bench API
- `http://DOMAIN/book/` serves the Book scheduling SPA
- `http://DOMAIN/book/api/` proxies to the Book API
- `http://DOMAIN/blank/` serves the Blank forms SPA
- `http://DOMAIN/blank/api/` proxies to the Blank API
- `http://DOMAIN/bill/` serves the Bill invoicing SPA
- `http://DOMAIN/bill/api/` proxies to the Bill API
- `http://DOMAIN/helpdesk/` serves the Helpdesk portal SPA
- `http://DOMAIN/helpdesk/api/` proxies to the Helpdesk API
- `http://DOMAIN/files/` serves uploaded files from MinIO
- `http://DOMAIN/mcp/` proxies to the MCP server

Application containers (api, banter-api, beacon-api, brief-api, bolt-api, bearing-api, board-api, bond-api, blast-api, bench-api, book-api, blank-api, bill-api, mcp-server, worker, helpdesk-api, frontend, voice-agent) are stateless and scale horizontally. Data services (postgres, redis, minio, qdrant) can be swapped for managed cloud equivalents by changing environment variables only.

## IMPORTANT: Preserving Test Data

**NEVER run `docker compose down -v` unless the user explicitly asks to wipe the database.** The `-v` flag destroys all persistent volumes (PostgreSQL data, Redis data, MinIO uploads). Instead:

- Rebuild and restart individual services: `docker compose build api && docker compose up -d --force-recreate api`
- Restart nginx after rebuilds: `docker compose restart frontend`
- Stop without wiping: `docker compose down` (no `-v`)
- Only target what changed: `docker compose build frontend && docker compose up -d --force-recreate frontend`

The test database contains seeded projects, users, tickets, and conversations that are time-consuming to recreate.

## IMPORTANT: "Pre-existing" is not a dismissal

When running `typecheck`, `test`, `lint`, `db:check`, or any other verification and you encounter errors/warnings/failures that already existed before your current task, **do not wave them away** with "all remaining errors are pre-existing" or "not a regression from this work." The fact that an error existed already is not a reason to leave it alone. It is a reason it has been festering, and every pass that ignores it lets it rot further.

When you find pre-existing issues during a task:

1. **Always record them.** Add each one as a task via `TaskCreate` with enough detail (file, line, exact error message, rough hypothesis) that you or a future agent can pick it up without reconstruction. If you're running under a human's supervision, surface them in your response. Do not bury them.
2. **Fix them if the fix is small and obviously safe** (unused imports, missing type narrowing, straightforward `null` vs `undefined` mismatches). Touch nothing beyond the minimum needed and mention what you fixed.
3. **If a fix is non-trivial** (would expand scope, change behavior, or requires design decisions), leave it in the task list and flag it loudly in your final response. Non-trivial fixes still get recorded; they just don't get silently bundled into the current PR.
4. **Never report a "clean" build when errors remain.** If `tsc --noEmit` exits non-zero, the build is not clean. Say "N errors remain, M are pre-existing and now tracked in tasks X/Y/Z, K are from this work and fixed in commit abc123" rather than "typecheck is clean modulo pre-existing noise."

This rule applies to all verification commands, not just typecheck. Pre-existing test failures, pre-existing lint warnings, pre-existing `db:check` drift, pre-existing CI job failures: record and investigate all of them.

The cost of tracking an existing error is a one-line TaskCreate call. The cost of dismissing it is that it will still be there six months from now, and every future change has to navigate around it.

## Database Schema and Migrations

**Single source of truth:** `infra/postgres/migrations/NNNN_*.sql`, append-only, idempotent numbered migration files. `0000_init.sql` is the canonical baseline; subsequent files layer schema evolution on top. There is no `init.sql`: the postgres container boots with an empty DB and the `migrate` service creates everything. As of this refresh the tree has 140 migration files with tip `0140_agent_runner_webhooks.sql` (Wave 5 §20 outbound agent-runner webhooks).

The `migrate` service (reuses the api image, runs `node dist/migrate.js`) is a `service_completed_successfully` dependency of every DB-using service: api, helpdesk-api, banter-api, beacon-api, brief-api, bolt-api, bearing-api, board-api, bond-api, blast-api, bench-api, book-api, blank-api, bill-api, worker. It runs automatically on every `docker compose up`, tracks applied migrations in the `schema_migrations` table with SHA-256 checksums, and is a no-op once the DB is current.

**When you change the schema:**

1. Update the Drizzle schema file in `apps/*/src/db/schema/`.
2. Add a **new** numbered file in `infra/postgres/migrations/` that applies the change idempotently (use `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP TRIGGER IF EXISTS ... ; CREATE TRIGGER ...`, or guarded `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` blocks). **Never edit an existing migration**: the runner records a SHA-256 checksum per file and aborts on mismatch.
3. Run `docker compose run --rm migrate` to apply it. The `migrate` service bind-mounts `./infra/postgres/migrations` into `/app/migrations` at runtime, so the new file is picked up instantly. **No rebuild is required** on developer hosts. Then rebuild and restart whichever app container now depends on the new schema (`docker compose build <app> && docker compose up -d --force-recreate <app>`). Production deployments (k8s/Helm) still bake the migrations into the image via `apps/api/Dockerfile`, so `docker compose build api` is only needed when shipping.

Every migration must be idempotent so the same migration file is safe to run against both empty DBs and DBs that may already have the object (e.g., from the historical init.sql bootstrap).

### Drift guard

`pnpm db:check` runs `scripts/db-check.mjs`, which parses every Drizzle `pgTable(...)` declaration across `apps/api`, `apps/helpdesk-api`, and `apps/banter-api`, then diffs the union against the live database pointed to by `DATABASE_URL`. It prints any table/column declared in Drizzle but missing in the DB, or present in the DB but not declared in any Drizzle schema, and exits 1 on drift (type mismatches are warnings only). Start the stack first: `docker compose up -d postgres migrate`.

CI runs it on every PR and every push to `main` via `.github/workflows/db-drift.yml`, against a fresh `postgres:16-alpine` service container with `init.sql` + all migrations applied. **When it fails: do not edit an existing migration.** Update the Drizzle schema file and add a new numbered migration in `infra/postgres/migrations/` with the same change in idempotent form, then rerun.

### Migration conventions

Every file in `infra/postgres/migrations/` MUST:

1. **Filename**: match `^[0-9]{4}_[a-z][a-z0-9_]*\.sql$` (4-digit sequence + snake_case).
2. **Header**: the first ~20 lines must contain a comment block with the filename marker, a `-- Why:` line (1-3 sentences on motivation), and a `-- Client impact:` line (`none` / `additive only` / `expand-contract step N/M` / etc).
3. **Idempotency**: use `CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP TABLE/INDEX/COLUMN IF EXISTS`. `CREATE TRIGGER` must be preceded by `DROP TRIGGER IF EXISTS ... ;` or wrapped in a `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` block.
4. **Destructive ALTERs** (`DROP COLUMN`, `SET NOT NULL`, etc.) must be wrapped in a guarded `DO $$` block that tolerates re-runs.

Enforced by `pnpm lint:migrations` (`scripts/lint-migrations.mjs`), run in CI by `.github/workflows/db-drift.yml` (job `migration-lint`). Rare exceptions may be silenced per-line with an inline `-- noqa: <rule-name>` comment **while the migration has not yet been applied in any environment**. After the migration has run anywhere, see the immutability rule below.

**⚠ Migration files are IMMUTABLE once applied.** The migrate runner (`apps/api/src/migrate.ts`) hashes the SQL *body* and stores the hash in `schema_migrations.checksum`. On every subsequent boot it re-hashes the file and aborts if the hash drifts — protecting every environment from silent body changes on a file that already ran. The header comment block (leading `--` lines) is stripped before hashing, so `-- Why:` / `-- Client impact:` edits are free, but **every other byte of the file counts**, including inline `-- noqa:` tags or any other inline comment on a body line.

This means: if `pnpm lint:migrations` flags a violation on a migration that has ALREADY been applied anywhere (even your own dev DB), **do not add an inline `-- noqa:` tag and do not edit the body in any way**. Instead, register the suppression in `scripts/lint-migrations.mjs::OFF_FILE_SUPPRESSIONS` (shape: `{ filename: { lineNumber: [ruleName, ...] } }`). The linter consults that map alongside inline tags, so the suppression still applies without mutating the file.

Incident of record: 2026-04-18 saw production migrations stall at 0124 for ~24h after an inline `-- noqa:` tag was added to silence two pre-existing lint false-positives. The tags were semantically harmless (they are SQL comments Postgres ignores) but the body hash diverged, and every Railway `migrate` redeploy failed with CHECKSUM MISMATCH — which in turn blocked migrations 0125-0140 from ever applying, which in turn left `users.kind` missing in prod and broke the new bootstrap endpoint. Recovery required setting `MIGRATE_ALLOW_HEADER_RESTAMP=1` on the migrate service to re-stamp the stored checksum to the edited body. The `OFF_FILE_SUPPRESSIONS` mechanism exists so that fix never has to happen again.

**Checksum behavior detail.** The leading `--` comment header is stripped before hashing; any other body change (including inline `-- ...` comments on SQL-bearing lines) still trips the immutability guard. For the one-time rollout where headers were added to already-applied migrations, rerun the migrate container with `MIGRATE_ALLOW_HEADER_RESTAMP=1` to re-stamp stored checksums. **Do not use this flag as a routine escape hatch** — it re-stamps every file whose hash has drifted, which can paper over accidental body edits you did not intend to land.

### Applying a new migration to a long-running stack (gotchas)

The "just run `docker compose up -d`" flow has one trap that still bites, plus one trap that used to bite but has been mitigated. Read this before adding a migration to an existing stack:

1. **The `migrate` sidecar is cached via `service_completed_successfully`.** Once it has run to completion on the first boot, subsequent `docker compose up -d <service>` invocations see the cached completion and **do not re-run it**. Simply rebuilding `bolt-api` (or any other dependent service) will not trigger the migration, even if the new migration file is present. You must explicitly run `docker compose run --rm migrate` yourself after adding a new migration file.

2. **(Fixed, historical context only.)** Docker Desktop's WSL2 file sync used to silently drop newly-added migration files from the build context on Windows hosts, so a `docker compose build api` would produce an image that had every migration *except* the new one, and the `migrate` sidecar happily reported "N applied, N already up-to-date" without ever seeing the new file. This produced hours of confusing "column does not exist" / "stats shows 13 / list shows nothing" debugging across the Bolt `template_strict`, `bolt_graph_column`, and `bond_deal_rotting_alerted` incidents. **The fix is in `docker-compose.yml`**: the `migrate` service now bind-mounts `./infra/postgres/migrations:/app/migrations:ro` at runtime, so the host directory is read live every time the container starts. New migration files are visible to the runner instantly, without a rebuild and without going through any COPY / BuildKit / WSL2 sync layers. The `apps/api/Dockerfile` still `COPY`s the migrations into the production image as a fallback for Helm/k8s deployments where no compose bind mount exists.

**Standard sequence after adding a migration** (no rebuild of the api image needed unless you are shipping to prod):

```sh
docker compose run --rm migrate                            # applies the new migration
docker compose build <app-that-uses-the-new-column>         # rebuild the affected app
docker compose up -d --force-recreate <app-that-uses-it>    # restart it
```

**Verify the migration actually applied:**

```sh
# 1. Confirm the runner sees the new file (bind mount makes this instant)
docker compose run --rm migrate sh -c "ls /app/migrations | tail -5"

# 2. Confirm the column/table actually exists in the live DB
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "\d <table>"

# 3. Confirm schema_migrations has the new row
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c \
  "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 5;"
```

**Manual psql fallback (should no longer be necessary, retained for emergencies).** If something does go wrong and the migrate runner refuses to apply a file that's clearly present, you can still bypass it:

```sh
# Apply the migration SQL directly against the running postgres container
cat infra/postgres/migrations/NNNN_new_migration.sql \
  | docker compose exec -T postgres psql -U bigbluebam -d bigbluebam

# Record it in schema_migrations so the next clean boot's migrate service
# knows to skip it. The id column is the filename (with .sql extension);
# the runner re-verifies checksums against on-disk files, so use a real
# SHA-256 of the SQL body (post-header) or, if you just need to get
# unblocked, 'manual' and accept you'll have to fix it on the next boot.
docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c \
  "INSERT INTO schema_migrations (id, checksum) VALUES ('NNNN_new_migration.sql', 'manual') ON CONFLICT (id) DO NOTHING;"
```

**When debugging "it works for stats but not for list" symptoms**, always check for schema drift FIRST:

```sh
docker compose logs --tail=50 <affected-api> 2>&1 | grep -iE "column.*does not exist|42703|PostgresError"
```

If you see `PostgresError: column "X" does not exist` (SQLSTATE `42703`), you have drift. Not a query bug, not a filter bug, not an org-scoping bug. Fix the drift first, then see if the symptom remains.

## Branch model

BigBlueBam uses a two-branch model for deployments:

- **`stable`**: the production branch. Every commit here has been validated on `main` first and, where possible, exercised against a real deployment. This is the **default** branch for `./scripts/deploy.sh` and the branch you should normally merge feature work into (via `main` to `stable` promotion). Treat it as protected: no direct pushes of unvalidated work.
- **`main`**: the bleeding-edge integration branch. New features land here first. Most development PRs target `main`. A separate promotion step (a merge commit from `main` to `stable`) happens when work is judged production-ready.

When `./scripts/deploy.sh` runs, it prompts the operator to choose between `stable` and `main` (default `stable`). The choice is persisted in `.deploy-state.json` and re-used on subsequent runs. Both the Docker Compose and Railway adapters honor it. See `scripts/deploy/shared/branch-select.mjs` for the prompt and `scripts/deploy/main.mjs` for how it's threaded through to the platform adapters.

Day-to-day development: work on feature branches off `main`, merge to `main` via PR, then promote `main` to `stable` when the change is production-ready (typically fast-forward or a `--ff-only` merge to avoid extra merge noise on `stable`).

## Common Commands

```bash
# First-time setup
cp .env.example .env   # Edit secrets before starting
pnpm install           # Install all dependencies

# Start full stack (production mode)
docker compose up -d

# Start full stack (dev mode with hot reload)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Run database migrations (schema lives in infra/postgres/migrations/*.sql, applied by the migrate service)
docker compose run --rm migrate

# Create initial admin user
docker compose exec api node dist/cli.js create-admin \
  --email admin@example.com --password your-password-here \
  --name "Admin" --org "My Organization"

# Create a locked service account with a bbam_svc_-prefixed API key
# (used for internal service-to-service calls, e.g. MCP /tools/call)
docker compose exec api node dist/cli.js create-service-account \
  --name "mcp-internal" --org-slug my-org

# Seed the current stack with demo data (runs Phase A platform,
# Phase B per-app seeders, Phase C banter + helpdesk, Phase D acme scenario)
docker compose --profile seed run --rm seed

# View logs
docker compose logs -f api mcp-server worker

# Build a specific app
pnpm --filter @bigbluebam/shared build
pnpm --filter @bigbluebam/api build

# Run tests
pnpm test                                    # All packages
pnpm --filter @bigbluebam/shared test        # Shared schemas only
pnpm --filter @bigbluebam/api test           # API unit tests
pnpm --filter @bigbluebam/frontend test      # Frontend component tests
pnpm --filter @bigbluebam/banter-api test    # Banter API unit tests
pnpm --filter @bigbluebam/banter test        # Banter frontend component tests
pnpm --filter @bigbluebam/integration-tests test   # Cross-app integration harness (Wave 3)
```

### CI Pipeline

- **Every push:** lint (Biome), typecheck (`tsc --noEmit`), unit tests (Vitest)
- **PR:** ephemeral Docker Compose stack for integration tests
- **Merge to main:** build images, push to GHCR, deploy to staging
- **Tag (`v*`):** promote to production with zero-downtime rolling update

## Key Design Decisions

- **Zod schemas are shared** between client and API (`@bigbluebam/shared`). Single source of truth for validation.
- **Optimistic updates** via TanStack Query for all mutations. Rollback on failure with animated revert.
- **Cursor-based pagination** on all list endpoints. Filter pattern: `?filter[field]=value`. Sort: `?sort=-field`.
- **Conflict resolution** is last-write-wins with `updated_at` stale check (HTTP 409). Board position conflicts resolved server-side with authoritative broadcast.
- **Task positions** use float values for cheap reordering without renumbering siblings.
- **Custom fields** stored as JSONB on tasks, with definitions in `custom_field_definitions` table per project.
- **Carry-forward** is a first-class concept: tasks track `carry_forward_count` and `original_sprint_id`. Cards display a badge when carried forward.
- **Activity log** is append-only, partitioned monthly by `created_at`.
- **MCP destructive actions** (delete task, complete sprint, remove member) require a two-step confirmation flow via `confirm_action` tool with time-limited action tokens. Tokens live in a Redis-backed store (`apps/mcp-server/src/lib/confirm-token-store.ts`, key prefix `mcp:confirm_token:`) with a graceful in-process fallback; TTL is dynamic (5 min for human approvers, 60 s for agent-to-agent chains) so the staging and confirm legs can land on different MCP instances and tokens survive rolling deploys.
- **API keys** are prefixed `bbam_` (user keys) or `bbam_svc_` (service-account keys, Wave 0.2), stored as Argon2id hashes, and scoped to read/read_write/admin with optional project restriction. Key rotation (migration 0117) supports a 7-day grace window where both the predecessor and the current secret authenticate, enabling zero-downtime secret rollover.
- **Service accounts** are minted via `docker compose exec api node dist/cli.js create-service-account` and carry a `bbam_svc_` token prefix. They are locked users (no login) and are used for internal service-to-service calls such as the MCP server's internal `POST /tools/call` route (apps/mcp-server/src/routes/tools-call.ts).
- **Bolt event naming** is bare-name-plus-explicit-source (Wave 0.4). Every publisher calls `publishBoltEvent({ event, source, payload })` from `@bigbluebam/shared` with the event name as `deal.rotting` (not `bond.deal.rotting`) and `source: 'bond'` as a separate field. Migration 0120 back-fills historical rows to match, and `scripts/check-bolt-catalog.mjs` is the CI drift guard that rejects source-prefixed event names.
- **Row-level security** uses PostgreSQL policies gated by the `app.current_org_id` GUC (migration 0116, Wave 1.A). The GUC is set per-request by `apps/api/src/plugins/rls.ts`; the role's RLS bypass flag is toggled at boot by `apps/api/src/boot/rls-boot.ts` based on the `BBB_RLS_ENFORCE` env var. Set `BBB_RLS_ENFORCE=1` to bind policies on every query (prod posture); leave it unset to keep the role NOBYPASSRLS-off for legacy development while policies are still being authored.
- **OAuth SSO** (migrations 0118 / 0119, Wave 1.A) is wired in `apps/api/src/routes/oauth.routes.ts` with provider records in `oauth_providers` and per-user linkage rows in `oauth_user_links`.
- **First-run SuperUser bootstrap**. `POST /auth/bootstrap` atomically creates the first org, user, membership, and session when no non-sentinel SuperUser exists (rate-limited 5/5min per IP, audited). `isBootstrapRequired()` in `apps/api/src/services/bootstrap-status.service.ts` is the gate; `/public/config` surfaces `bootstrap_required`, and `/root-redirect` overrides any configured redirect to `/b3/bootstrap` until the first account is minted. The frontend auto-redirects unauthenticated visitors to the bootstrap page via `usePublicConfig`. The deploy script accepts `--skip-admin` / `BBB_SKIP_ADMIN_SETUP=1` / an interactive defer option and prints a handoff URL instead of prompting for credentials inline.
- **Task templates** allow creating reusable task blueprints with title patterns, default fields, and auto-generated subtasks.
- **Saved views** persist filter/sort/swimlane configurations per user or shared across the project.
- **Time entries** are separate rows (not just a counter on tasks), enabling per-user per-day time tracking reports.
- **Comment reactions** use toggle semantics with a unique constraint on `(comment_id, user_id, emoji)`.
- **iCal feed** exports tasks with due dates as an .ics calendar feed, authenticated via API key in query string.
- **Import system** supports CSV, Trello, Jira, and GitHub Issues, with automatic phase/label creation for unmatched values.
- **WebSocket realtime** uses Redis PubSub for cross-instance broadcasting; rooms are scoped to org, project, and user levels.
- **Keyboard shortcuts** and a **command palette** (Cmd+K) are built into the frontend for power-user navigation.
- **User and member management** is consolidated at `/b3/people` (org admins/owners) and `/b3/superuser/people` (platform SuperUsers), not under Settings. Tabbed user-detail pages cover profile, projects, access (API keys/sessions/passwords), and activity.
- **Bond stale-deal detection** runs as a daily 2 AM UTC worker job that finds deals where `days_in_stage > rotting_days` and emits `deal.rotting` events to Bolt ingest (source `bond`). `bond_deals.rotting_alerted_at` is the per-stage-entry idempotency marker (reset naturally when `stage_entered_at` changes).
- **Agent visibility preflight** (AGENTIC_TODO §11, Wave 2). Agents posting cross-app results into shared surfaces MUST call the MCP `can_access(asker_user_id, entity_type, entity_id)` tool (or `POST /v1/visibility/can_access`) for every cited entity and drop anything not allowed. The authoritative visibility rules and the canonical `entity_type` allowlist live in `apps/api/src/services/visibility.service.ts`; the full agent protocol including `asker_user_id` selection, handling of unsupported types, and HITL routing is in `docs/reference/agent-conventions.md`.
- **Agentic platform capabilities** (AGENTIC_TODO Waves 1-5, migrations 0127-0140). The platform ships a self-contained set of cross-cutting agent surfaces on top of the per-app tool catalogs:
  - **Identity, audit, heartbeat** (§10, Wave 1, migration 0127): `users.kind` enum (`human`/`agent`/`service`) mirrored onto `activity_log.actor_type` at write time; `agent_runners` table records `last_heartbeat_at`, version, and advertised capabilities. MCP tools: `agent_heartbeat`, `agent_audit`, `agent_self_report`.
  - **Approval queues** (§9, Wave 2, migration 0128): durable `agent_proposals` table + `proposal_create` / `proposal_list` / `proposal_decide` MCP tools. Emits `proposal.created` and `proposal.decided` Bolt events on the `platform` source.
  - **Unified activity view** (§5, Wave 3, migration 0129): `v_activity_unified` view UNIONs Bam `activity_log`, `bond_activities`, and `ticket_activity_log` with normalized columns. Helpdesk `actor_type='agent'` (human support agent) is remapped to the §10 `'human'` kind so the semantics do not collide.
  - **Read plane** (Wave 3): `search_everything` (cross-app fan-out with normalized scoring and optional asker-mode `can_access` filtering), `resolve_references` (deterministic mention extraction plus per-app search, canonical syntax in `packages/shared/src/mention-syntax.ts`), `activity_query` + `activity_by_actor`, composite `account_view` / `project_view` / `user_view`.
  - **Write plane** (Wave 4, migrations 0130-0133): scheduled Banter posts with per-channel quiet hours (`banter_schedule_post`), idempotent upserts (`bond_upsert_contact`, `beacon_upsert_by_slug`, `helpdesk_upsert_user`, `task_upsert_by_external_id` — each emits a `*.upserted` event with a `created` flag), the `entity_links` durable cross-app linking table with backfill from known per-app FKs, and a federated `attachment_get` / `attachment_list` dispatcher.
  - **Agent policies and outbound webhooks** (§15 + §20, Wave 5, migrations 0139 + 0140): `agent_policies` drives per-agent kill switches and glob-prefix tool allowlists (`banter.*`, `bond.*`, etc.). A policy-check middleware in `apps/mcp-server/src/lib/register-tool.ts` fail-closes every service-account tool invocation with a short-TTL in-process cache plus Redis PubSub (`agent_policies:invalidate`) for fast propagation. Always-permitted core set: `get_server_info`, `get_me`, `agent_heartbeat`. Outbound webhooks push subscribed Bolt events to agent runners via HMAC-signed POSTs with a 0s/30s/2m/10m/30m/2h/6h/dead-letter backoff schedule, SSRF guards, 256KB payload cap, and auto-disable at 20 consecutive failures.
  - **Long tail** (Wave 5): dedupe primitives (`bond_find_duplicates`, `helpdesk_find_similar_tickets`, `dedupe_record_decision` / `dedupe_list_pending` backed by `dedupe_decisions`), trend queries (`helpdesk_ticket_count_by_phrase`, `bam_task_count_by_phrase`), `expertise_for_topic`, Bolt observability (`bolt_event_trace`, `bolt_recent_events`, runtime `catalog.drift_detected`), Banter agent-pattern subscriptions with `can_access`-gated worker fan-out, mixed-roster availability (`book_find_meeting_time_for_users`), and Redis-backed ingest-fingerprint dedup.
- **Bolt catalog drift guard** is `scripts/check-bolt-catalog.mjs`. It scans every `publishBoltEvent(...)` call site under `apps/` and fails CI if the `(source, event_type)` pair is missing from `apps/bolt-api/src/services/event-catalog.ts`. 109 events registered as of Wave 5 with zero violations.
- **Seeding** is orchestrated by `scripts/seed-all.mjs`, invoked via the `docker compose --profile seed run --rm seed` sidecar (see `docker-compose.yml`). The orchestrator reads `SEED_ORG_SLUG` from the environment and runs seeders in four dependency phases: Phase A `seed-platform.mjs` (fatal on failure, seeds users/projects/tasks), Phase B per-app seeders (non-fatal, serial for log clarity), Phase C `seed-banter.mjs` + `seed-helpdesk.mjs` (depend on Phase A users), Phase D `seed-acme-scenario.mjs` (the cross-app "Acme lead to delivery" chain). Per-app seeders resolve the org dynamically via `SEED_ORG_SLUG`, so no script hardcodes a UUID. See `docs/history/2026-04-15-seeding/seeding-recovery-plan.md` for the gap analysis and the human-tester checklist that shaped the current seed set.

## Error Response Envelope

All API errors follow this structure:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "...",
    "details": [{ "field": "title", "issue": "required" }],
    "request_id": "req_abc123"
  }
}
```

## Environment Configuration

Required env vars: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `SESSION_SECRET`, `INTERNAL_SERVICE_SECRET`, `MCP_INTERNAL_API_TOKEN`. See `.env.example` for the full list including optional OAuth, SMTP, and port overrides.

Optional test/dev knobs on the Bam api: set `BBB_E2E_PERMISSIVE_RATE_LIMIT=1` to multiply the global Fastify rate limit ceiling by `RATE_LIMIT_E2E_MULTIPLIER` (default 100x), unblocking parallel Playwright workers on `/auth/login`. Already on by default in `docker-compose.dev.yml` and any non-production `NODE_ENV`; production stays strict unless the flag is set explicitly. Per-route rate limits (org admin, llm-provider, change-password, switch-org, guest-invite) are unaffected.

RLS posture is controlled by `BBB_RLS_ENFORCE` (default off during the staged Wave 1.A rollout). Set to `1` to force the api role into NOBYPASSRLS mode so policies bind on every query. Seeding respects `SEED_ORG_SLUG`, which resolves the target org via slug rather than a hardcoded UUID.

## Development Phases

The project is planned in 7 phases over ~30 weeks. Phase 1 (Foundation) covers monorepo scaffolding, Docker stack, auth, org/user/project CRUD, basic board with drag-and-drop. Refer to Section 26 of the design document for the full breakdown.
