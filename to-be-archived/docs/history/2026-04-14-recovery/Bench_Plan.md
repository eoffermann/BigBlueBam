# Bench Implementation Plan (2026-04-14)

## Scope

Closes gaps from the 2026-04-14 Bench Design Audit. Bench is 85% complete at `a8fb19a`. Core CRUD (dashboards, widgets, data sources, reports), query execution, widget rendering, and MCP tools are functional end-to-end. This plan completes the remaining infrastructure gaps required for scheduled reporting and export functionality.

**In scope (P0):** worker jobs for scheduled report generation and delivery; Puppeteer (or client-side) export pipeline. **In scope (P1):** materialized view refresh scheduler; report delivery handlers (email/Banter/Brief); saved queries CRUD routes and UI; date-range-aware result caching; permission alignment for Manager role.

**Out of scope:** anomaly detection scheduling (Wave 3 cross-product); materialized view admin UI; custom field support in query builder; Bolt event emission for Bench events; widget gallery / templates.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §Missing P0 item 1 | Worker job `bench-report-generation.job.ts` for scheduled report delivery |
| G2 | P0 | audit §Missing P0 item 2 | Dashboard export pipeline (Puppeteer PDF/PNG, MinIO upload) |
| G3 | P1 | audit §Missing P1 item 1 | Materialized view refresh scheduler via BullMQ |
| G4 | P1 | audit §Missing P1 item 2 | Report delivery handlers: email, Banter, Brief |
| G5 | P1 | audit §Missing P1 item 3 | Saved queries CRUD routes and frontend |
| G6 | P1 | audit §Missing P1 item 5 | Query timeout enforcement verification (audit may have been a false positive) |
| G7 | P1 | audit §Missing P1 item 6 | Date-range-aware result caching in widget query |
| G8 | P1 | audit §Partial report permissions | Manager role access to reports (currently admin-only) |

## Migrations

**Reserved slots: 0084, 0085.**

### 0084_bench_report_delivery_tracking.sql

**Body:**
```sql
-- 0084_bench_report_delivery_tracking.sql
-- Why: Enable worker jobs to track scheduled report delivery attempts without overwriting prior results. Allow admin UI to show send status.
-- Client impact: additive only. New nullable columns, no schema breaks.

ALTER TABLE bench_scheduled_reports
  ADD COLUMN IF NOT EXISTS last_delivery_attempt_at TIMESTAMPTZ;

ALTER TABLE bench_scheduled_reports
  ADD COLUMN IF NOT EXISTS last_delivery_status VARCHAR(20);

ALTER TABLE bench_scheduled_reports
  ADD COLUMN IF NOT EXISTS last_delivery_error TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bench_reports_delivery_status_check') THEN
    ALTER TABLE bench_scheduled_reports
      ADD CONSTRAINT bench_reports_delivery_status_check
      CHECK (last_delivery_status IS NULL OR last_delivery_status IN ('pending', 'sent', 'failed', 'queued'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bench_reports_scheduled_enabled
  ON bench_scheduled_reports (enabled, last_sent_at)
  WHERE enabled = true;
```

**Verification:** scratch-DB apply + `\d bench_scheduled_reports`.

### 0085_bench_materialized_view_refresh_tracking.sql

**Body:**
```sql
-- 0085_bench_materialized_view_refresh_tracking.sql
-- Why: Track materialized view refresh attempts, failures, and next scheduled time for the refresh scheduler worker.
-- Client impact: additive only. New nullable columns.

ALTER TABLE bench_materialized_views
  ADD COLUMN IF NOT EXISTS last_refresh_attempt_at TIMESTAMPTZ;

ALTER TABLE bench_materialized_views
  ADD COLUMN IF NOT EXISTS last_refresh_status VARCHAR(20);

ALTER TABLE bench_materialized_views
  ADD COLUMN IF NOT EXISTS last_refresh_error TEXT;

ALTER TABLE bench_materialized_views
  ADD COLUMN IF NOT EXISTS next_scheduled_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bench_mv_refresh_status_check') THEN
    ALTER TABLE bench_materialized_views
      ADD CONSTRAINT bench_mv_refresh_status_check
      CHECK (last_refresh_status IS NULL OR last_refresh_status IN ('success', 'failed', 'in_progress'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bench_mv_scheduled
  ON bench_materialized_views (next_scheduled_at)
  WHERE next_scheduled_at IS NOT NULL;
```

**Verification:** scratch-DB apply + `\d bench_materialized_views`.

## Schemas and shared types

No new shared schemas. Bench's `QueryConfig`, `DashboardLayout`, `KpiConfig` interfaces remain local to `apps/bench-api/src/`.

## API routes and services

### New routes

**`apps/bench-api/src/routes/saved-queries.routes.ts`** (new, G5):
- GET `/saved-queries?search=...` - list org's saved queries
- POST `/saved-queries` - create with name, description, data_source, entity, query_config
- GET `/saved-queries/:id` - fetch
- PATCH `/saved-queries/:id` - update
- DELETE `/saved-queries/:id` - delete

### Route updates

**`apps/bench-api/src/routes/reports.routes.ts`** (G8):
- Change `requireMinRole('admin')` on report list/create/update/delete/send-now to `requireMinRole('manager')`.

**`apps/bench-api/src/routes/dashboards.routes.ts`** (G2):
- `POST /dashboards/:id/export` — change from stub to enqueue `bench-export-dashboard` BullMQ job; return `{ job_id, status: 'queued' }`.

**`apps/bench-api/src/routes/widgets.routes.ts`** (G7):
- `POST /widgets/:id/query` — accept optional `dateRange` in body, pass to `widgetService.executeWidgetQuery`.

### Service changes

**`apps/bench-api/src/services/saved-queries.service.ts`** (new, G5):
- `listSavedQueries(orgId, search?)`, `getSavedQuery(id, orgId)`, `createSavedQuery(orgId, userId, input)`, `updateSavedQuery(id, orgId, input)`, `deleteSavedQuery(id, orgId)`.

**`apps/bench-api/src/services/query.service.ts`** (G7):
- Modify `executeQuery` to accept optional `dateRange` parameter.
- Cache key: `bench:query:${widgetId}:${hashDateRange(dateRange)}` where `hashDateRange` is stable string hash of (preset + start + end).

**`apps/bench-api/src/services/widget.service.ts`** (G7):
- `executeWidgetQuery` accepts optional dateRange from the request and passes through.

**`apps/bench-api/src/services/report.service.ts`** (G4):
- `sendReportNow(reportId, orgId, userId)` — enqueue `bench-report-generation` BullMQ job instead of logging TODO. Return `{ report_id, job_id, status: 'queued' }`.

**`apps/bench-api/src/services/query.service.ts`** (G6 verification):
- Re-verify that `SET LOCAL statement_timeout = env.QUERY_TIMEOUT_MS` is applied at the start of every query. Audit noted this was a gap, but codebase inspection may show it is already enforced. Add a test either way.

## Frontend pages and components

**New pages:**
- `apps/bench/src/pages/saved-queries-list.tsx` (G5) — list view with cards, delete action, edit links.
- `apps/bench/src/pages/saved-queries-edit.tsx` (G5) — form for create/edit saved queries.

**Page updates:**
- `apps/bench/src/pages/explorer.tsx` (G5) — add "Save query" button that routes to saved-queries-edit with current state. Support loading by `?query_id=...` to hydrate form from saved query.
- `apps/bench/src/pages/dashboard-view.tsx` (G7) — pass `state.dateRange` to widget query POST body so cache varies correctly.

## Worker jobs

### New job: `apps/worker/src/jobs/bench-report-generation.job.ts` (G1, G4)

Payload: `{ report_id, org_id }`.

Pipeline:
1. Fetch report by ID, verify enabled and due.
2. Fetch dashboard and widgets.
3. Call bench-api internally for each widget's query.
4. Render dashboard via Puppeteer (or client-less HTML-to-PDF).
5. Route to delivery handler based on `delivery_method`:
   - `email`: call SMTP via Nodemailer, attach rendered PDF
   - `banter_channel`: call Banter API `POST /channels/:id/messages` with rendered HTML + file attachment
   - `brief_document`: call Brief API `POST /documents` with rendered content
6. Update `bench_scheduled_reports` row: `last_sent_at=now`, `last_delivery_status='sent'`, or `'failed'` with error message.

### New job: `apps/worker/src/jobs/bench-export-dashboard.job.ts` (G2)

Payload: `{ dashboard_id, format: 'pdf' | 'png', org_id, user_id }`.

Pipeline:
1. Fetch dashboard.
2. Hydrate all widgets via queryService.
3. Render to Puppeteer headless browser (PDF via `generatePdf()`, PNG via `screenshot()`).
4. Upload to MinIO at `bench/{org_id}/{dashboard_id}/{format}/{timestamp}.{ext}`.
5. Return `{ file_url: signed MinIO URL, expires_in_seconds: 3600 }`.

### New job: `apps/worker/src/jobs/bench-materialized-view-refresh.job.ts` (G3)

Payload: `{ view_name }`.

Pipeline:
1. Call `materialized-view.service.ts refreshView(view_name)`.
2. Record duration, success/failure, error.
3. Update `bench_materialized_views` row: `last_refreshed_at=now`, `last_refresh_status=...`, `last_refresh_error=...`.
4. Compute next_scheduled_at from refresh_cron using a cron parser.

**Scheduler:** on worker startup, query `bench_materialized_views` and register a BullMQ repeating job for each with its `refresh_cron`. Alternatively, a 1-minute tick job queries for views where `next_scheduled_at <= now()` and enqueues refresh.

### Job registration

`apps/worker/src/index.ts` (update) — register the three new job handlers. If using scheduler-tick pattern, add a BullMQ repeating job at 60-second intervals that drives both report generation and materialized view refresh queues.

## MCP tools

`apps/mcp-server/src/tools/bench-tools.ts` (updates):
- `bench_generate_report` — change from stub to call `POST /reports/:id/send-now`, return `{ report_id, job_id, status: 'queued' }`.
- `bench_query_widget` — add optional `dateRange` parameter, pass through.

No new tools required.

## Tests

- `apps/bench-api/src/services/__tests__/saved-queries.service.test.ts` (new) — CRUD tests with org filtering.
- `apps/bench-api/src/routes/__tests__/saved-queries.routes.test.ts` (new) — 200/404/403 cases, auth guards.
- `apps/bench-api/src/routes/__tests__/reports.routes.test.ts` (update, G8) — Manager role can list/create/update, non-Manager returns 403.
- `apps/bench-api/src/services/__tests__/query.service.test.ts` (update, G7) — cache key variation by dateRange; hit/miss across date boundaries. Also verify statement_timeout is applied (G6).
- `apps/worker/src/jobs/__tests__/bench-report-generation.test.ts` (new) — mock BullMQ, bench-api HTTP, SMTP/Banter/Brief handlers. Test cron eval and delivery routing.
- `apps/worker/src/jobs/__tests__/bench-export-dashboard.test.ts` (new) — mock Puppeteer, MinIO. Test PDF and PNG paths.
- `apps/worker/src/jobs/__tests__/bench-materialized-view-refresh.test.ts` (new) — mock refreshView, verify status updates.

## Verification steps

```bash
pnpm --filter @bigbluebam/bench-api build
pnpm --filter @bigbluebam/bench-api typecheck
pnpm --filter @bigbluebam/bench-api test
pnpm --filter @bigbluebam/bench typecheck
pnpm --filter @bigbluebam/bench test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations
# scratch DB:
docker run --rm -d --name bbb-bench-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55497:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55497/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55497/verify' pnpm db:check
docker exec -T bbb-bench-verify psql -U verify -d verify -c "\d bench_scheduled_reports" | grep last_delivery_status
docker exec -T bbb-bench-verify psql -U verify -d verify -c "\d bench_materialized_views" | grep last_refresh_status
docker rm -f bbb-bench-verify
```

**End-to-end in live stack:**
- Create scheduled report with cron expression, wait for worker to pick up, verify last_sent_at updates.
- Trigger dashboard export, verify signed MinIO URL, download file.
- Trigger materialized view refresh, verify row-level statistics update.

## Out of scope

- **Anomaly detection scheduling (P2):** `bench_detect_anomalies` MCP tool exists but weekly Bolt automation trigger is deferred to Wave 3 cross-product plan.
- **Materialized view admin UI (P2):** no dashboard to manually trigger or monitor. Deferred to Phase 2 analytics refinement.
- **Custom field support in query builder (P2):** `custom_field_definitions` table is static in the registry.
- **Bolt event emission (P2):** `bench.report.generated`, `bench.anomaly.detected` events not published. Deferred to Wave 3.
- **Widget gallery / pre-built templates (P1):** deferred pending template storage + UI design.
- **Frontend unit and integration tests (P2):** the `apps/bench/src/` tree has zero test files; addition is out of scope for this plan.

## Dependencies

- **Puppeteer:** new dependency for `apps/worker/`. Alternative: use a lighter HTML-to-PDF library if Puppeteer is too heavy.
- **MinIO:** existing infra. Bench needs bucket `bench-exports` or reuse of existing buckets.
- **Banter API client:** for G4 delivery. Pattern from other apps.
- **Brief API client:** for G4 delivery.
- **SMTP server:** for G4 email delivery. Existing SMTP env config.

**Migration numbers claimed: 0084, 0085.** No unused slots.
