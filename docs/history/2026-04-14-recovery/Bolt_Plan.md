# Bolt Implementation Plan (2026-04-14)

## Scope

Bolt is 80-85% complete at `f5fb079`. Event routing, execution engine, and template UI are fully functional. This plan closes 4 critical P0 blockers plus 4 P1 enhancements.

**Critical P0 items:** MCP `/tools/call` HTTP transport (currently missing, all Bolt actions 404); cron scheduling processor (bolt_schedules table exists but is never read); event-naming convention sweep (bond.deal.rotting still prefixed); catalog drift guard script.

**P1 items:** real LLM integration for AI assist endpoints; field autocomplete UI; execution cleanup job; failure notification via Banter DM.

**Out of scope:** Bolt graph visual editor enhancements beyond current feature set (already at P5), automation versioning and rollback UI, blueprint marketplace.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §Missing P0 item 1 | MCP `/tools/call` HTTP endpoint restoration (Bolt actions 404 until restored) |
| G2 | P0 | audit §Missing P0 item 2 | Cron scheduler: bolt:schedule queue processor, 60s tick, synthetic cron.fired events |
| G3 | P0 | audit §Missing P0 item 3 | Event-naming sweep: rename bond.deal.rotting to deal.rotting in worker + migrate historical rows |
| G4 | P0 | audit §Missing P0 item 3 | `scripts/check-bolt-catalog.mjs` drift guard |
| G5 | P1 | audit §Missing P1 item 1 | Real LLM integration for /ai/generate and /ai/explain endpoints |
| G6 | P1 | audit §Missing P1 item 2 | Field autocomplete UI for FieldPicker and TemplateVariableHelper |
| G7 | P1 | audit §Missing P1 item 3 | Execution cleanup job (nightly purge of executions older than 90 days) |
| G8 | P1 | audit §Missing P1 item 4 | Execution owner notification via Banter DM on failures |

## Migrations

**Reserved slots: 0096, 0097, 0098.**

### 0096_bolt_event_naming_migration.sql

**Body:**
```sql
-- 0096_bolt_event_naming_migration.sql
-- Why: Normalize historical trigger_event JSONB in bolt_executions from bond.deal.rotting (prefixed) to deal.rotting (bare name) per Wave 0.4 naming convention. Fixes automation trigger matching after the worker is updated to emit the bare name.
-- Client impact: rewrites JSONB field in bolt_executions rows. No schema change.

UPDATE bolt_executions
SET trigger_event = jsonb_set(
  trigger_event,
  '{event_type}',
  to_jsonb('deal.rotting'::text),
  false
)
WHERE trigger_event->>'event_type' = 'bond.deal.rotting';

UPDATE bolt_automations
SET trigger_event = 'deal.rotting'
WHERE trigger_event = 'bond.deal.rotting';
```

**Verification:** apply; `SELECT COUNT(*) FROM bolt_executions WHERE trigger_event->>'event_type' = 'bond.deal.rotting'` returns 0.

### 0097_bolt_notify_owner_on_failure.sql

**Body:**
```sql
-- 0097_bolt_notify_owner_on_failure.sql
-- Why: Add opt-in flag to notify automation owner via Banter DM when execution fails.
-- Client impact: additive only. Default false; opt-in per automation.

ALTER TABLE bolt_automations
  ADD COLUMN IF NOT EXISTS notify_owner_on_failure BOOLEAN NOT NULL DEFAULT false;
```

### 0098 — reserved

Reserved for future Bolt schema extension.

## API routes and services

### New routes

**`apps/mcp-server/src/routes/tools-call.ts`** (new, G1):

Extracted as a named exported `handleToolsCall(req, res, deps)` function for testability. Dispatched from `apps/mcp-server/src/server.ts` when `url.pathname === '/tools/call' && req.method === 'POST'`.

Pipeline:
1. **Auth:** read `X-Internal-Secret` header. Length-check short-circuit, then `crypto.timingSafeEqual`. 401 on mismatch.
2. **Body parse:** JSON body `{ name, arguments }`. 400 on invalid JSON or missing `name`.
3. **Read** optional `X-Org-Id` and `X-Actor-Id` headers. Log both in audit entry.
4. **Build ApiClient** using 3-arg constructor: `new ApiClient(env.API_INTERNAL_URL, env.MCP_INTERNAL_API_TOKEN, logger)`. **Do NOT** extend ApiClient; org scoping comes from the service account's bearer token.
5. **Create ephemeral McpServer:** `const mcpServer = createMcpServer(apiClient, \`internal-${randomUUID()}\`)`.
6. **Microtask-ordering guard:** `await new Promise((r) => queueMicrotask(() => r(undefined)))`. **This is required** — the SDK wraps `tools/call` inside a `queueMicrotask` in `server.ts:125`; synchronous read would capture the unwrapped handler.
7. **Pull handler:** `const handlers = (mcpServer.server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers; const handler = handlers?.get('tools/call');`.
8. **Invoke:** `const result = await handler({ params: { name, arguments: args ?? {} } }, { requestId: randomUUID(), sessionId });`. Return raw `CallToolResult` as JSON 200.
9. **Error handling:** wrap in try/catch; 500 with `{ error: { code: 'INTERNAL_ERROR', message } }` on throw.

**Env vars** (update `apps/mcp-server/src/env.ts`):
- `INTERNAL_SERVICE_SECRET: z.string().min(32).optional()`
- `MCP_INTERNAL_API_TOKEN: z.string().min(1).optional()`

**Docker compose wiring:** add both env vars to mcp-server AND worker service blocks in `docker-compose.yml`. Use `${INTERNAL_SERVICE_SECRET}` and `${MCP_INTERNAL_API_TOKEN}` references.

### New CLI command

**`apps/api/src/cli.ts`** (new `create-service-account` subcommand):

Pre-check: read `apps/api/src/plugins/auth.ts` to verify prefix-slicing. The auth plugin uses `token.slice(0, 8)` for lookup, and `bbam_svc` (exactly 8 chars) works transparently. The `bbam_svc_` prefix is safe — do NOT modify `auth.ts`.

Pipeline: create a service-account user (locked password, email `svc+<name>@system.local` or similar), mint an API key with prefix `bbam_svc_`, scope `read_write`, org-bound to the creating org. Print the key once.

### New services

**`apps/worker/src/services/bolt-scheduler.service.ts`** (new, G2):

`processBoltScheduleTick(boltApiUrl, internalSecret, logger)`:
1. Query `bolt_schedules` WHERE `next_run_at <= now()` JOIN `bolt_automations`.
2. For each due schedule, build synthetic `cron.fired` event: `{ schedule_id, fired_at, automation_id, cron_expression }`.
3. POST to `${boltApiUrl}/v1/events/ingest` with `X-Internal-Secret` header.
4. Update `next_run_at` using `cron-parser` to compute next firing time.
5. Update `last_run_at = now()`.

Log: processed count, errors, next check time.

### Service updates

**`apps/worker/src/jobs/bond-stale-deals.job.ts`** (G3):
- Change event name emitted from `'bond.deal.rotting'` to `'deal.rotting'`. Source remains `'bond'`.
- Remove the `// event name normalized in wave 0.4` stale comment if present.

**`apps/bolt-api/src/routes/ai-assist.routes.ts`** (G5):
- Replace stubs at `/ai/generate` and `/ai/explain` with `@anthropic-ai/sdk` calls.
- Add `@anthropic-ai/sdk` to `apps/bolt-api/package.json`.
- System prompt built from event catalog (list of triggers + payload fields) and MCP tool registry (list of actions + parameters).
- Use prompt caching (`cache_control: { type: 'ephemeral' }`) on the large system prompt.
- `/ai/generate`: user description -> automation JSON matching the automation schema.
- `/ai/explain`: automation JSON -> natural language summary.

**`apps/worker/src/jobs/bolt-execute.job.ts`** (G8):
- After execution fails, check `automation.notify_owner_on_failure` (migration 0097).
- If true, POST to Banter API `/messages/direct` with DM to `automation.created_by`: `Automation **${auto.name}** failed:\n\n${execution.error_message}`.
- Use `X-Internal-Secret` for auth.

## Worker jobs

### `apps/worker/src/jobs/bolt-schedule-tick.job.ts` (new, G2)

Entry point for `bolt:schedule` queue. Register as BullMQ repeating job with pattern `*/1 * * * *` (every minute). Calls `processBoltScheduleTick()` from the service. Logs count and errors.

### `apps/worker/src/jobs/bolt-cleanup.job.ts` (new, G7)

Daily at 3 AM UTC via BullMQ repeating job or cron trigger:
1. `DELETE FROM bolt_execution_steps WHERE execution_id IN (SELECT id FROM bolt_executions WHERE started_at < NOW() - INTERVAL '90 days')`
2. `DELETE FROM bolt_executions WHERE started_at < NOW() - INTERVAL '90 days'`
3. Log purged row counts.

Consider adding `retention_days` column to `bolt_automations` in future migration for per-automation retention.

### Job registration

`apps/worker/src/index.ts` (update) — register `bolt:schedule` repeating job with minute pattern, register `bolt:cleanup` daily job.

## Scripts

### `scripts/check-bolt-catalog.mjs` (new, G4)

Drift guard that validates active automations reference events defined in the catalog.

Pipeline:
1. Parse `apps/bolt-api/src/services/event-catalog.ts` (AST walk or regex) to extract event definitions.
2. Query live database `SELECT DISTINCT trigger_source, trigger_event FROM bolt_automations WHERE enabled = true`.
3. Flag any automation triggers not in the catalog. Exit 1 if any missing; exit 0 if clean.
4. Also enforce: first argument of `publishBoltEvent(...)` calls in `apps/*/src/**/*.ts` must be a string literal not starting with a source prefix. Use a hand-rolled top-level-comma-aware parser since multi-line calls break regex approaches.

CI integration: add to `.github/workflows/db-drift.yml` alongside existing `pnpm db:check`.

Local: `node scripts/check-bolt-catalog.mjs`.

Wire `check:bolt-catalog` script into root `package.json`.

## MCP tools

No new tools. Existing tools continue to work once `/tools/call` route is restored.

## Tests

- `apps/mcp-server/test/tools-call.test.ts` (new, G1) — three cases: missing X-Internal-Secret returns 401; valid call (`task_list` with real project UUID) returns 200 with `content: [...]`; invalid arguments return 200 with `isError: true`. Mock `req`/`res` via EventEmitter, do not spawn real http listener.
- `apps/worker/src/jobs/__tests__/bolt-schedule-tick.test.ts` (new, G2) — due schedules processed, next_run_at updated, cron-parser integration.
- `apps/worker/src/jobs/__tests__/bolt-cleanup.test.ts` (new, G7) — executions older than 90 days purged, newer ones retained.
- `apps/bolt-api/src/routes/__tests__/ai-assist.test.ts` (update, G5) — Anthropic SDK mock, prompt caching, response parsing.
- `scripts/check-bolt-catalog.test.mjs` (new, G4) — test fixture with good and bad automations, verify exit codes.

## Verification steps

```bash
pnpm --filter @bigbluebam/mcp-server build
pnpm --filter @bigbluebam/mcp-server typecheck
pnpm --filter @bigbluebam/mcp-server test
pnpm --filter @bigbluebam/bolt-api build
pnpm --filter @bigbluebam/bolt-api typecheck
pnpm --filter @bigbluebam/bolt-api test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations
node scripts/check-bolt-catalog.mjs

docker run --rm -d --name bbb-bolt-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55492:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55492/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55492/verify' pnpm db:check
docker rm -f bbb-bolt-verify
```

**Live smoke tests:**
- Call `POST /tools/call` with valid X-Internal-Secret and `{ name: 'task_list', arguments: { project_id: '...' } }`. Verify 200 response.
- Create a schedule-triggered automation with cron `* * * * *`. Wait 60s. Verify `cron.fired` event reaches Bolt ingest and automation executes.
- Check that `deal.rotting` event (bare name) matches automations expecting it.
- Run `node scripts/check-bolt-catalog.mjs` against live DB. Expect clean exit.

## Out of scope

Automation versioning and rollback UI, blueprint marketplace, advanced debugging features (step-through execution, breakpoints), visual execution flow diagrams beyond current graph editor.

## Dependencies

- **`@anthropic-ai/sdk`:** new dep for G5 LLM integration.
- **`cron-parser`:** new dep for G2 scheduler (`apps/worker/package.json`).
- **Banter API:** for G8 failure notifications (internal :4002).
- **`ANTHROPIC_API_KEY` env var:** for G5.
- **`INTERNAL_SERVICE_SECRET` env var:** for G1 auth (32+ chars, random, rotatable).

**Bootstrap command** (needed on fresh stacks to create service account for MCP `/tools/call`):
```bash
docker compose exec api node dist/cli.js create-service-account \
  --email svc+bolt@system.local --name "Bolt worker" --org-slug <org-slug>
```
Paste the returned `bbam_svc_*` token into `MCP_INTERNAL_API_TOKEN`, generate `INTERNAL_SERVICE_SECRET` via `openssl rand -hex 32`, restart mcp-server and worker.

**Migration numbers claimed: 0096, 0097. Reserved unused: 0098.**
