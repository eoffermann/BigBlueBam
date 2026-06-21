# Platform Implementation Plan (2026-04-14)

## Scope

Platform is ~84% complete at `f5fb079`. Covers the foundational layer: `apps/api` Bam core, `apps/frontend` BBB SPA, org/user/auth/RBAC, API keys, OAuth SSO, RLS foundation, shared infrastructure packages, CI workflows. This plan closes 4 P0 gaps and 5 P1 gaps, prioritizing defense-in-depth multi-tenancy via RLS, OAuth SSO completion, shared infrastructure package extraction, and API key rotation.

**In scope (P0):** RLS foundation with `BBB_RLS_ENFORCE` feature flag and policies on 12 core tables; API key rotation with 7-day grace period; GitHub/Google OAuth flow; shared infrastructure package extraction (`@bigbluebam/logging`, `@bigbluebam/db-stubs`, `@bigbluebam/service-health`, `@bigbluebam/livekit-tokens`).

**In scope (P1):** shared Pino logger with request-id plugin; unified error handler with internal_error_id minting; Sentry init hook; health/readiness probe plugin; db-stubs package replacing 13 manual copies of Bam core tables; livekit-tokens JWT mint helper.

**Out of scope:** event-naming sweep (owned by Bolt_Plan.md migration 0096); MCP `/tools/call` route (owned by Bolt_Plan.md G1); canonical `publishBoltEvent` module (owned by Cross_Product_Plan.md); activity log partitioning (P2); admin UI for OAuth provider configuration.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §P0 item 1 | RLS foundation with `BBB_RLS_ENFORCE` flag and policies on core tables |
| G2 | P0 | audit §P0 item 2 | OAuth SSO flow for GitHub and Google (authorize, callback, link, provider registry) |
| G3 | P0 | audit §P0 item 3 | API key rotation with 7-day grace period, predecessor chain |
| G4 | P0 | audit §P0 item 4 | Shared infrastructure packages: logging, db-stubs, service-health, livekit-tokens |
| G5 | P1 | audit §P1 item 1 | Unified error handler with internal_error_id minting and structured logs |
| G6 | P1 | audit §P1 item 2 | Health and readiness probe plugin for all API services |
| G7 | P1 | audit §P1 item 3 | db-stubs package replacing 13 manual copies of Bam core table declarations |
| G8 | P1 | audit §P1 item 4 | livekit-tokens JWT mint helper for voice/video services |
| G9 | P1 | audit §P1 item 5 | CI workflows: migration-replay, build-push, lint-migrations |

## Migrations

**Reserved slots: 0116, 0117, 0118, 0119.**

(Helpdesk claims 0109-0115 in the same batch. Platform starts at 0116. Event-naming sweep is owned by Bolt_Plan.md migration 0096, not duplicated here.)

### 0116_rls_foundation.sql

**Body:**
```sql
-- 0116_rls_foundation.sql
-- Why: Row-level security foundation. Defines policies on 12 core tables gated by current_setting('app.current_org_id'). Inactive by default; API sets the setting in rls plugin on every request. Defense-in-depth against code-level org-scoping bugs.
-- Client impact: additive only. Policies are created but initially the app role has BYPASSRLS, so behavior is unchanged. When BBB_RLS_ENFORCE=1 is set and the boot hook alters the role to NOBYPASSRLS, policies become enforcing.

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY['organizations', 'projects', 'tasks', 'sprints', 'phases',
                         'activity_log', 'organization_memberships', 'api_keys',
                         'sessions', 'custom_field_definitions', 'custom_field_values',
                         'attachments'])
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = tbl) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    END IF;
  END LOOP;
END $$;

-- Policies: one per table. Each checks that the row belongs to current_org_id.
-- Direct org_id tables:
DROP POLICY IF EXISTS organizations_org_isolation ON organizations;
CREATE POLICY organizations_org_isolation ON organizations
  FOR ALL USING (id = current_setting('app.current_org_id', true)::uuid);

DROP POLICY IF EXISTS projects_org_isolation ON projects;
CREATE POLICY projects_org_isolation ON projects
  FOR ALL USING (org_id = current_setting('app.current_org_id', true)::uuid);

DROP POLICY IF EXISTS tasks_org_isolation ON tasks;
CREATE POLICY tasks_org_isolation ON tasks
  FOR ALL USING (org_id = current_setting('app.current_org_id', true)::uuid);

DROP POLICY IF EXISTS sprints_org_isolation ON sprints;
CREATE POLICY sprints_org_isolation ON sprints
  FOR ALL USING (org_id = current_setting('app.current_org_id', true)::uuid);

DROP POLICY IF EXISTS activity_log_org_isolation ON activity_log;
CREATE POLICY activity_log_org_isolation ON activity_log
  FOR ALL USING (org_id = current_setting('app.current_org_id', true)::uuid);

DROP POLICY IF EXISTS organization_memberships_org_isolation ON organization_memberships;
CREATE POLICY organization_memberships_org_isolation ON organization_memberships
  FOR ALL USING (org_id = current_setting('app.current_org_id', true)::uuid);

DROP POLICY IF EXISTS api_keys_org_isolation ON api_keys;
CREATE POLICY api_keys_org_isolation ON api_keys
  FOR ALL USING (org_id = current_setting('app.current_org_id', true)::uuid);

-- Indirect (project-scoped) tables:
DROP POLICY IF EXISTS phases_org_isolation ON phases;
CREATE POLICY phases_org_isolation ON phases
  FOR ALL USING (project_id IN (SELECT id FROM projects WHERE org_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS custom_field_definitions_org_isolation ON custom_field_definitions;
CREATE POLICY custom_field_definitions_org_isolation ON custom_field_definitions
  FOR ALL USING (project_id IN (SELECT id FROM projects WHERE org_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS custom_field_values_org_isolation ON custom_field_values;
CREATE POLICY custom_field_values_org_isolation ON custom_field_values
  FOR ALL USING (task_id IN (SELECT id FROM tasks WHERE org_id = current_setting('app.current_org_id', true)::uuid));

DROP POLICY IF EXISTS attachments_org_isolation ON attachments;
CREATE POLICY attachments_org_isolation ON attachments
  FOR ALL USING (task_id IN (SELECT id FROM tasks WHERE org_id = current_setting('app.current_org_id', true)::uuid));

-- User-scoped: sessions joins through organization_memberships
DROP POLICY IF EXISTS sessions_org_isolation ON sessions;
CREATE POLICY sessions_org_isolation ON sessions
  FOR ALL USING (
    user_id IN (
      SELECT user_id FROM organization_memberships
      WHERE org_id = current_setting('app.current_org_id', true)::uuid
    )
  );
```

### 0117_api_key_rotation.sql

**Body:**
```sql
-- 0117_api_key_rotation.sql
-- Why: Enable API key rotation with grace period. Users can rotate a key (invalidate old, issue new) with a configurable grace window during which both keys work.
-- Client impact: additive only. Existing keys have NULL in new columns; rotation logic is opt-in.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rotation_grace_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS predecessor_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_rotation_grace ON api_keys(rotation_grace_expires_at)
  WHERE rotation_grace_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_predecessor ON api_keys(predecessor_id);
```

### 0118_oauth_providers.sql

**Body:**
```sql
-- 0118_oauth_providers.sql
-- Why: OAuth provider registry. Stores client credentials and configuration for GitHub, Google, and future providers.
-- Client impact: additive only. New table.

CREATE TABLE IF NOT EXISTS oauth_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name VARCHAR(50) NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  authorization_url TEXT NOT NULL,
  token_url TEXT NOT NULL,
  user_info_url TEXT NOT NULL,
  scopes TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_providers_name ON oauth_providers(provider_name);
```

### 0119_oauth_user_links.sql

**Body:**
```sql
-- 0119_oauth_user_links.sql
-- Why: Track links between local users and their external OAuth accounts. Supports multi-provider linking per user.
-- Client impact: additive only. New table.

CREATE TABLE IF NOT EXISTS oauth_user_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_name VARCHAR(50) NOT NULL,
  external_id TEXT NOT NULL,
  external_email TEXT NOT NULL,
  external_login TEXT,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider_name, external_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_user_links_provider_external
  ON oauth_user_links(provider_name, external_id);
CREATE INDEX IF NOT EXISTS idx_oauth_user_links_user
  ON oauth_user_links(user_id);
```

## Schemas and shared types

- `apps/api/src/db/schema/oauth-providers.ts` (new) — Drizzle table matching 0118.
- `apps/api/src/db/schema/oauth-user-links.ts` (new) — Drizzle table matching 0119.
- `apps/api/src/db/schema/api-keys.ts` (update, G3) — add `rotated_at`, `rotation_grace_expires_at`, `predecessor_id`.
- `packages/shared/src/schemas/platform.ts` (new) — `OAuthProviderSchema`, `OAuthUserLinkSchema`, `ApiKeyRotationSchema`, `RlsContextSchema`.

## Shared infrastructure packages

### `packages/logging` (new, G5)

**`packages/logging/src/index.ts`:**
- `createLogger({ service, level?, isDev?, sentryDsn? })` — Pino factory with `pino-pretty` transport in dev.
- `requestIdPlugin` — Fastify plugin that reads `X-Request-ID` or generates UUID, attaches to `request.id`, and creates child logger.
- `createErrorHandler({ serviceName, sentry? })` — unified error handler:
  - Zod errors → 400 with field-level details.
  - Fastify validation errors → 400.
  - 429 → structured rate-limit envelope.
  - 4xx with statusCode → passthrough.
  - 5xx → mint `internal_error_id`, log full error, return sanitized envelope in prod (full cause in dev).
- `initErrorReporting(serviceName)` — Sentry init hook (reads `SENTRY_DSN` env).

**`packages/logging/package.json`:** exports `./dist/index.js`, deps on `pino`, `pino-pretty`, `fastify`, `fastify-plugin`.

### `packages/service-health` (new, G6)

**`packages/service-health/src/index.ts`:**
- `healthCheckPlugin(fastify, { db?, redis?, readinessTimeout? })` — registers:
  - `GET /health` — liveness (always 200).
  - `GET /health/ready` — readiness. Probes db and redis with configurable timeout (default 5s). Returns 200 if all ok, 503 if any fail.
  - `GET /metrics` — basic process metrics (uptime, memory).

All 14 API services register the plugin in their `server.ts`.

### `packages/db-stubs` (new, G7)

**`packages/db-stubs/src/index.ts`:** canonical Drizzle table declarations for `users`, `organizations`, `organization_memberships`, `projects`, `tasks`, `sprints`, `phases`, `activity_log`, `api_keys`, `sessions`. Each app currently declares these locally; after this package is created, the 13 non-Bam services replace their local `bbb-refs.ts` with `export * from '@bigbluebam/db-stubs'`.

### `packages/livekit-tokens` (new, G8)

**`packages/livekit-tokens/src/index.ts`:**
- `mintRoomToken(apiKey, apiSecret, { identity, roomName, metadata?, permissions? })` — wraps `livekit-server-sdk` `AccessToken` with default grants.

Used by Banter (voice calls), Board (audio conferencing), and voice-agent.

## API routes and services

### New routes (apps/api)

- `GET /auth/oauth/providers` (G2) — list configured providers.
- `GET /auth/oauth/:provider/authorize` (G2) — generate state token (Redis 5min TTL), build authorization URL, return to client.
- `POST /auth/oauth/:provider/callback` (G2) — verify state, exchange code, fetch user info. If external account linked, create session. If email collision, return 409 with link-prompt. Otherwise create new user+org, link account, create session.
- `POST /auth/oauth/:provider/link` (G2) — link external account to existing user (requires auth).
- `POST /api-keys/:id/rotate` (G3) — generate new key, set 7-day grace, mark predecessor.

### New plugins

- `apps/api/src/plugins/rls.ts` (new, G1) — Fastify plugin running `preHandler` on every request. Reads `request.user.active_org_id`, executes `SELECT set_config('app.current_org_id', <uuid>, true)` so RLS policies see the current org. Gated by `BBB_RLS_ENFORCE` env var: when `0`, no-op; when `1`, the boot hook has already run `ALTER ROLE bam_app NOBYPASSRLS` so policies become enforcing.
- `apps/api/src/boot/rls-boot.ts` (new, G1) — boot-time hook: if `BBB_RLS_ENFORCE=1`, run `ALTER ROLE bam_app NOBYPASSRLS`; else `ALTER ROLE bam_app BYPASSRLS`. Runs once per process start.

### Service updates

- `apps/api/src/services/auth.service.ts` (G3) — `verifyApiKey(token)` honors grace period: accept predecessor keys until `rotation_grace_expires_at`. Reject after.
- All 14 API services (G5, G6) — register `requestIdPlugin`, `healthCheckPlugin`, and unified error handler from `@bigbluebam/logging`.

## Frontend pages and components (apps/frontend)

- `apps/frontend/src/pages/LoginPage.tsx` (update, G2) — fetch `/auth/oauth/providers`, render OAuth provider buttons alongside email/password form. Button click calls `/auth/oauth/:provider/authorize` and redirects to returned URL.
- `apps/frontend/src/pages/oauth/CallbackPage.tsx` (new, G2) — receives `?code=...&state=...`, POSTs to `/auth/oauth/:provider/callback`, handles success (redirect to dashboard) and 409 email collision (prompt to sign in and link).
- `apps/frontend/src/pages/settings/AccountPage.tsx` (update, G2, G3) — "Linked accounts" section shows OAuth links and unlink button; "API keys" section adds "Rotate" button per key.

## Worker jobs

No new worker jobs from Platform. Existing jobs consume the new shared packages (`@bigbluebam/logging` for request IDs, `@bigbluebam/db-stubs` for Bam core tables).

## CI workflows

### `.github/workflows/migration-replay.yml` (new, G9)

Trigger: push to `main` or `stable`, or any change under `infra/postgres/migrations/`. Spins up `postgres:16-alpine` service, runs `node apps/api/dist/migrate.js`, then `pnpm db:check`. Verifies migrations apply cleanly on a fresh DB.

### `.github/workflows/build-push.yml` (update, G9)

Trigger: push to `main` or `stable`. Builds all images, pushes to GHCR with branch-based tags.

### `.github/workflows/lint-migrations.yml` (new, G9)

Trigger: PR touching `infra/postgres/migrations/`. Runs `pnpm lint:migrations`.

### `.github/workflows/db-drift.yml` (update)

After existing `pnpm db:check`, add `node scripts/check-bolt-catalog.mjs` call (Bolt_Plan G4 owns the script).

## Tests

- `apps/api/test/rls.test.ts` (new, G1) — enable RLS, set `app.current_org_id` to orgA, verify orgB rows invisible; flip back, verify visibility restored.
- `apps/api/test/oauth.routes.test.ts` (new, G2) — mock provider token and user-info responses; test authorize URL generation, callback flow (new user, existing link, email collision), link endpoint.
- `apps/api/test/api-key-rotation.test.ts` (new, G3) — rotate key, verify both work during grace, verify old rejected after grace.
- `packages/logging/src/__tests__/logger.test.ts` (new, G5) — request ID plugin, error handler envelope shape for each error class.
- `packages/service-health/src/__tests__/health.test.ts` (new, G6) — liveness always 200; readiness 503 on dependency failure.
- `packages/db-stubs/src/__tests__/schema.test.ts` (new, G7) — exported tables match expected column sets.
- `packages/livekit-tokens/src/__tests__/tokens.test.ts` (new, G8) — JWT grants match permission flags.

## Verification steps

```bash
pnpm --filter @bigbluebam/shared build
pnpm --filter @bigbluebam/logging build
pnpm --filter @bigbluebam/service-health build
pnpm --filter @bigbluebam/db-stubs build
pnpm --filter @bigbluebam/livekit-tokens build
pnpm --filter @bigbluebam/api build
pnpm --filter @bigbluebam/api typecheck
pnpm --filter @bigbluebam/api test
pnpm --filter @bigbluebam/frontend typecheck
pnpm --filter @bigbluebam/frontend test
pnpm lint:migrations
pnpm lint
pnpm typecheck

docker run --rm -d --name bbb-platform-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55498:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55498/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55498/verify' pnpm db:check
docker exec -T bbb-platform-verify psql -U verify -d verify -c "SELECT tablename, policyname FROM pg_policies WHERE policyname LIKE '%org_isolation%';"
docker rm -f bbb-platform-verify
```

**Live smoke tests:** register via GitHub OAuth, verify new user+org created; link GitHub account to existing user via `/auth/oauth/github/link`; rotate API key, verify both keys work within grace window; set `BBB_RLS_ENFORCE=1` and restart api, verify cross-org queries return 0 rows; hit `/health/ready` on every service, verify 200 when postgres+redis reachable; trigger an uncaught error, verify structured log with `internal_error_id`.

## Out of scope

Event-naming sweep (Bolt_Plan.md 0096), MCP `/tools/call` route (Bolt_Plan.md G1), canonical `publishBoltEvent` (Cross_Product_Plan.md G1), `scripts/check-bolt-catalog.mjs` (Bolt_Plan.md G4), Sentry cloud project provisioning, OAuth provider admin UI, rate limit runtime configuration UI, activity log partitioning, Qdrant semantic search cross-product setup.

## Dependencies

- `pino`, `pino-pretty` — logging package.
- `livekit-server-sdk` — token mint package.
- Existing `drizzle-orm`, `fastify`, `fastify-plugin`, `zod`.
- Redis (existing) for OAuth state token storage.
- Postgres 16 with RLS (existing).

**Migration numbers claimed: 0116, 0117, 0118, 0119.**
