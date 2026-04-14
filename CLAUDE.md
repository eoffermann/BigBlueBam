# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BigBlueBam is a web-based, multi-user Kanban project planning tool with sprint-based task management. It supports multiple concurrent projects with fully configurable phases, task states, custom fields, and carry-forward mechanics. Target audience is small-to-medium teams (2-50 users).

The authoritative design specification is `BigBlueBam_Design_Document.md` in the repo root. Consult it for detailed data models, API contracts, MCP tool schemas, animation specs, and UI layouts.

## Tech Stack

**Frontend (SPA):** React 19, Motion (v11+, formerly Framer Motion), TanStack Query v5, Zustand, dnd-kit, TailwindCSS v4, Radix UI, Tiptap (rich text), React Hook Form + Zod

**API:** Node.js 22 LTS, Fastify v5, Drizzle ORM, Zod (shared validation schemas with client), Socket.IO or native WebSocket + Redis PubSub, BullMQ

**Data:** PostgreSQL 16 (RLS, JSONB custom fields, partitioned activity log), Redis 7 (sessions, cache, pubsub, queues), MinIO/S3 (attachments), Qdrant (vector search for Beacon, Brief, and Bond semantic retrieval)

**MCP Server:** `@modelcontextprotocol/sdk`, Streamable HTTP + SSE + stdio transports, runs as sidecar container on internal :3001, exposed at `/mcp/` via nginx on port 80

## Architecture

Monorepo managed with **Turborepo** and **pnpm workspaces**.

```
apps/
  api/          — Fastify REST API + WebSocket server (internal :4000, proxied at /b3/api/) — 23 route files, 24 schema tables, ~63 source files
  frontend/     — React SPA served by nginx at /b3/ (port 80) — ~55 source files, 8 pages, command palette, keyboard shortcuts
  banter-api/   — Banter Fastify REST API + WebSocket (internal :4002, proxied at /banter/api/) — 15 route files, 18 schema tables, ~45 source files
  banter/       — Banter React SPA served by nginx at /banter/ — ~39 source files, 7 pages, 14 components (BETA)
  mcp-server/   — MCP protocol server (internal :3001, proxied at /mcp/) — 238 tools (64 Bam + 47 Banter + 29 Beacon + 18 Brief + 12 Bolt + 12 Bearing + 14 Board + 19 Bond + 14 Blast + 9 Bench), 10+ resources, 8 prompts, 21 tool modules
  worker/       — BullMQ background job processor (no exposed port) — 15 job handlers (email, notification, export, sprint-close, banter-notification, banter-retention, bond-stale-deals, …)
  helpdesk-api/ — Helpdesk Fastify API (internal :4001, proxied at /helpdesk/api/)
  helpdesk/     — Helpdesk React SPA served by nginx at /helpdesk/
  beacon-api/   — Beacon Fastify API (internal :4004, proxied at /beacon/api/) — knowledge base, search, graph, policies
  beacon/       — Beacon React SPA served by nginx at /beacon/ — knowledge home, graph explorer, editor
  brief-api/    — Brief Fastify REST API + WebSocket (internal :4005, proxied at /brief/api/) — 8 route files, 11 schema tables
  brief/        — Brief React SPA served by nginx at /brief/
  bolt-api/     — Bolt Fastify REST API (internal :4006, proxied at /bolt/api/) — workflow automation engine, rules, executions
  bolt/         — Bolt React SPA served by nginx at /bolt/ — visual rule builder, execution log, templates
  bearing-api/  — Bearing Fastify API (internal :4007, proxied at /bearing/api/) — goals, key results, progress, reporting
  bearing/      — Bearing React SPA served by nginx at /bearing/ — goal dashboard, timeline, detail views
  board-api/    — Board Fastify REST API + WebSocket (internal :4008, proxied at /board/api/) — whiteboard rooms, shapes, assets, conferencing
  board/        — Board React SPA served by nginx at /board/ — infinite canvas, real-time collaboration, audio conferencing
  bond-api/     — Bond Fastify REST API (internal :4009, proxied at /bond/api/) — contacts, companies, deals, pipeline, activities, notes
  bond/         — Bond React SPA served by nginx at /bond/ — pipeline board, contact/company detail, deal tracking
  blast-api/    — Blast Fastify REST API (internal :4010, proxied at /blast/api/) — 7 route files, 7 schema tables, email campaigns, templates, segments, tracking, analytics
  blast/        — Blast React SPA served by nginx at /blast/ — campaign manager, template editor, segment builder, analytics dashboard
  bench-api/    — Bench Fastify REST API (internal :4011, proxied at /bench/api/) — 4 route files, 5 schema tables, dashboards, widgets, query execution, scheduled reports, materialized views
  bench/        — Bench React SPA served by nginx at /bench/ — dashboard list, canvas editor, widget wizard, ad-hoc explorer, reports, settings
  voice-agent/  — AI voice agent (Python/FastAPI, internal :4003) — LiveKit Agents SDK, STT/TTS pipeline (placeholder)
packages/
  shared/       — Shared Zod schemas, types, constants (@bigbluebam/shared)
infra/
  postgres/     — migrations/ (numbered, idempotent SQL migrations)
  nginx/        — nginx.conf, certs
  livekit/      — LiveKit SFU configuration (livekit.yaml)
  helm/         — Kubernetes Helm chart (bigbluebam/)
scripts/        — Utility scripts (seed-frndo.js)
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
- `http://DOMAIN/bearing/` serves the Bearing Goals & OKRs SPA
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
- `http://DOMAIN/helpdesk/` serves the Helpdesk portal SPA
- `http://DOMAIN/helpdesk/api/` proxies to the Helpdesk API
- `http://DOMAIN/files/` serves uploaded files from MinIO
- `http://DOMAIN/mcp/` proxies to the MCP server

Application containers (api, banter-api, beacon-api, brief-api, bolt-api, bearing-api, board-api, bond-api, blast-api, bench-api, mcp-server, worker, helpdesk-api, frontend, voice-agent) are stateless and scale horizontally. Data services (postgres, redis, minio, qdrant) can be swapped for managed cloud equivalents by changing environment variables only.

## IMPORTANT: Preserving Test Data

**NEVER run `docker compose down -v` unless the user explicitly asks to wipe the database.** The `-v` flag destroys all persistent volumes (PostgreSQL data, Redis data, MinIO uploads). Instead:

- Rebuild and restart individual services: `docker compose build api && docker compose up -d --force-recreate api`
- Restart nginx after rebuilds: `docker compose restart frontend`
- Stop without wiping: `docker compose down` (no `-v`)
- Only target what changed: `docker compose build frontend && docker compose up -d --force-recreate frontend`

The test database contains seeded projects, users, tickets, and conversations that are time-consuming to recreate.

## IMPORTANT: "Pre-existing" is not a dismissal

When running `typecheck`, `test`, `lint`, `db:check`, or any other verification and you encounter errors/warnings/failures that already existed before your current task, **do not wave them away** with "all remaining errors are pre-existing" or "not a regression from this work." The fact that an error existed already is not a reason to leave it alone — it is a reason it has been festering, and every pass that ignores it lets it rot further.

When you find pre-existing issues during a task:

1. **Always record them.** Add each one as a task via `TaskCreate` with enough detail (file, line, exact error message, rough hypothesis) that you or a future agent can pick it up without reconstruction. If you're running under a human's supervision, surface them in your response — do not bury them.
2. **Fix them if the fix is small and obviously safe** (unused imports, missing type narrowing, straightforward `null` vs `undefined` mismatches). Touch nothing beyond the minimum needed and mention what you fixed.
3. **If a fix is non-trivial** (would expand scope, change behavior, or requires design decisions), leave it in the task list and flag it loudly in your final response. Non-trivial fixes still get recorded — they just don't get silently bundled into the current PR.
4. **Never report a "clean" build when errors remain.** If `tsc --noEmit` exits non-zero, the build is not clean. Say "N errors remain, M are pre-existing and now tracked in tasks X/Y/Z, K are from this work and fixed in commit abc123" rather than "typecheck is clean modulo pre-existing noise."

This rule applies to all verification commands, not just typecheck. Pre-existing test failures, pre-existing lint warnings, pre-existing `db:check` drift, pre-existing CI job failures — record and investigate all of them.

The cost of tracking an existing error is a one-line TaskCreate call. The cost of dismissing it is that it will still be there six months from now, and every future change has to navigate around it.

## Database Schema & Migrations

**Single source of truth:** `infra/postgres/migrations/NNNN_*.sql` — append-only, idempotent numbered migration files. `0000_init.sql` is the canonical baseline; subsequent files layer schema evolution on top. There is no `init.sql` — the postgres container boots with an empty DB and the `migrate` service creates everything.

The `migrate` service (reuses the api image, runs `node dist/migrate.js`) is a `service_completed_successfully` dependency of every DB-using service — api, helpdesk-api, banter-api, beacon-api, brief-api, bolt-api, bearing-api, board-api, bond-api, worker. It runs automatically on every `docker compose up`, tracks applied migrations in the `schema_migrations` table with SHA-256 checksums, and is a no-op once the DB is current.

**When you change the schema:**

1. Update the Drizzle schema file in `apps/*/src/db/schema/`.
2. Add a **new** numbered file in `infra/postgres/migrations/` that applies the change idempotently (use `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP TRIGGER IF EXISTS ... ; CREATE TRIGGER ...`, or guarded `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` blocks). **Never edit an existing migration** — the runner records a SHA-256 checksum per file and aborts on mismatch.
3. Run `docker compose run --rm migrate` to apply it. The `migrate` service bind-mounts `./infra/postgres/migrations` into `/app/migrations` at runtime, so the new file is picked up instantly — **no rebuild is required** on developer hosts. Then rebuild and restart whichever app container now depends on the new schema (`docker compose build <app> && docker compose up -d --force-recreate <app>`). Production deployments (k8s/Helm) still bake the migrations into the image via `apps/api/Dockerfile`, so `docker compose build api` is only needed when shipping.

Every migration must be idempotent so the same migration file is safe to run against both empty DBs and DBs that may already have the object (e.g., from the historical init.sql bootstrap).

### Drift guard

`pnpm db:check` runs `scripts/db-check.mjs`, which parses every Drizzle `pgTable(...)` declaration across `apps/api`, `apps/helpdesk-api`, and `apps/banter-api`, then diffs the union against the live database pointed to by `DATABASE_URL`. It prints any table/column declared in Drizzle but missing in the DB, or present in the DB but not declared in any Drizzle schema, and exits 1 on drift (type mismatches are warnings only). Start the stack first: `docker compose up -d postgres migrate`.

CI runs it on every PR and every push to `main` via `.github/workflows/db-drift.yml`, against a fresh `postgres:16-alpine` service container with `init.sql` + all migrations applied. **When it fails: do not edit an existing migration.** Update the Drizzle schema file and add a new numbered migration in `infra/postgres/migrations/` with the same change in idempotent form, then rerun.

### Migration conventions

Every file in `infra/postgres/migrations/` MUST:

1. **Filename**: match `^[0-9]{4}_[a-z][a-z0-9_]*\.sql$` (4-digit sequence + snake_case).
2. **Header**: the first ~20 lines must contain a comment block with the filename marker, a `-- Why:` line (1-3 sentences on motivation), and a `-- Client impact:` line (`none` / `additive only` / `expand-contract step N/M` / …).
3. **Idempotency**: use `CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP TABLE/INDEX/COLUMN IF EXISTS`. `CREATE TRIGGER` must be preceded by `DROP TRIGGER IF EXISTS ... ;` or wrapped in a `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` block.
4. **Destructive ALTERs** (`DROP COLUMN`, `SET NOT NULL`, etc.) must be wrapped in a guarded `DO $$` block that tolerates re-runs.

Enforced by `pnpm lint:migrations` (`scripts/lint-migrations.mjs`), run in CI by `.github/workflows/db-drift.yml` (job `migration-lint`). Rare exceptions may be silenced per-line with an inline `-- noqa: <rule-name>` comment.

**Checksum behavior:** the runner hashes the SQL *body* only — the leading `--` comment header is stripped before hashing, so editing `-- Why:` / `-- Client impact:` text never invalidates an applied migration. Any change to executable SQL still trips the immutability guard. For the one-time rollout where headers were added to already-applied migrations, rerun the migrate container with `MIGRATE_ALLOW_HEADER_RESTAMP=1` to re-stamp stored checksums.

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

If you see `PostgresError: column "X" does not exist` (SQLSTATE `42703`), you have drift — not a query bug, not a filter bug, not an org-scoping bug. Fix the drift first, then see if the symptom remains.

## Branch model

BigBlueBam uses a two-branch model for deployments:

- **`stable`** — the production branch. Every commit here has been validated on `main` first and, where possible, exercised against a real deployment. This is the **default** branch for `./scripts/deploy.sh` and the branch you should normally merge feature work into (via `main` → `stable` promotion). Treat it as protected — no direct pushes of unvalidated work.
- **`main`** — the bleeding-edge integration branch. New features land here first. Most development PRs target `main`. A separate promotion step (a merge commit from `main` to `stable`) happens when work is judged production-ready.

When `./scripts/deploy.sh` runs, it prompts the operator to choose between `stable` and `main` (default `stable`). The choice is persisted in `.deploy-state.json` and re-used on subsequent runs. Both the Docker Compose and Railway adapters honor it. See `scripts/deploy/shared/branch-select.mjs` for the prompt + `scripts/deploy/main.mjs` for how it's threaded through to the platform adapters.

Day-to-day development: work on feature branches off `main`, merge to `main` via PR, then promote `main` → `stable` when the change is production-ready (typically fast-forward or a `--ff-only` merge to avoid extra merge noise on `stable`).

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

# View logs
docker compose logs -f api mcp-server worker

# Build a specific app
pnpm --filter @bigbluebam/shared build
pnpm --filter @bigbluebam/api build

# Run tests (~900+ tests total)
pnpm test                                    # All packages
pnpm --filter @bigbluebam/shared test        # Shared schemas only
pnpm --filter @bigbluebam/api test           # API unit tests
pnpm --filter @bigbluebam/frontend test      # Frontend component tests
pnpm --filter @bigbluebam/banter-api test    # Banter API unit tests (54 tests)
pnpm --filter @bigbluebam/banter test        # Banter frontend component tests (14 tests)
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
- **MCP destructive actions** (delete task, complete sprint, remove member) require a two-step confirmation flow via `confirm_action` tool with time-limited action tokens.
- **API keys** prefixed `bbam_`, stored as Argon2id hashes, scoped to read/read_write/admin with optional project restriction.
- **Task templates** allow creating reusable task blueprints with title patterns, default fields, and auto-generated subtasks.
- **Saved views** persist filter/sort/swimlane configurations per user or shared across the project.
- **Time entries** are separate rows (not just a counter on tasks), enabling per-user per-day time tracking reports.
- **Comment reactions** use toggle semantics with a unique constraint on `(comment_id, user_id, emoji)`.
- **iCal feed** exports tasks with due dates as an .ics calendar feed, authenticated via API key in query string.
- **Import system** supports CSV, Trello, Jira, and GitHub Issues, with automatic phase/label creation for unmatched values.
- **WebSocket realtime** uses Redis PubSub for cross-instance broadcasting; rooms are scoped to org, project, and user levels.
- **Keyboard shortcuts** and a **command palette** (Cmd+K) are built into the frontend for power-user navigation.
- **User and member management** is consolidated at `/b3/people` (org admins/owners) and `/b3/superuser/people` (platform SuperUsers) — not under Settings — with tabbed user-detail pages covering profile, projects, access (API keys/sessions/passwords), and activity.
- **Bond stale-deal detection** runs as a daily 2 AM UTC worker job that finds deals where `days_in_stage > rotting_days` and emits `deal.rotting` events (source `bond`) to Bolt ingest; `bond_deals.rotting_alerted_at` is the per-stage-entry idempotency marker (reset naturally when `stage_entered_at` changes).

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

Required env vars: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `SESSION_SECRET`. See `.env.example` for the full list including optional OAuth, SMTP, and port overrides.

Optional test/dev knobs on the Bam api: set `BBB_E2E_PERMISSIVE_RATE_LIMIT=1` to multiply the global Fastify rate limit ceiling by `RATE_LIMIT_E2E_MULTIPLIER` (default 100x), unblocking parallel Playwright workers on `/auth/login`. Already on by default in `docker-compose.dev.yml` and any non-production `NODE_ENV`; production stays strict unless the flag is set explicitly. Per-route rate limits (org admin, llm-provider, change-password, switch-org, guest-invite) are unaffected.

## Development Phases

The project is planned in 7 phases over ~30 weeks. Phase 1 (Foundation) covers monorepo scaffolding, Docker stack, auth, org/user/project CRUD, basic board with drag-and-drop. Refer to Section 26 of the design document for the full breakdown.
