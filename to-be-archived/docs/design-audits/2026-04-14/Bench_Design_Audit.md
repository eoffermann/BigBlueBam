# Bench Design Audit (2026-04-14)

## Summary

Bench is 85% complete with core dashboard, widget, and query execution functionality working end-to-end. All five schema tables (dashboards, widgets, materialized-views, scheduled-reports, saved-queries) are in place with migrations, Drizzle schemas, and services. Four route files handle CRUD for dashboards, widgets, reports, and data sources. Eight frontend pages implement the full user workflow (list, view, edit, explore, reports, widget-wizard, widget-edit, settings). Permission enforcement is integrated across all endpoints. Primary gaps: (1) worker jobs for scheduled report generation and delivery, (2) Puppeteer export functionality stubbed, (3) a small number of MCP tools present but some handlers partial. Frontend tests absent. Estimated completion: 2 to 3 weeks to add worker jobs, export pipeline, and polish.

## Design sources consulted

- `docs/early-design-documents/Bench_Design_Document.md` (436 lines, primary spec)
- `CLAUDE.md` (project-level Bench description)
- No prior audit document found (first audit pass)

## Built and working

### API Routes (4 files)

- **dashboards.routes.ts** - listDashboards, createDashboard, getDashboard, updateDashboard, deleteDashboard, duplicateDashboard, exportDashboard (stub)
- **widgets.routes.ts** - listWidgets, createWidget, getWidget, updateWidget, deleteWidget, executeWidgetQuery, refreshWidgetQuery
- **data-sources.routes.ts** - listDataSources, getDataSource, previewQuery (ad-hoc executor)
- **reports.routes.ts** - listReports, createReport, updateReport, deleteReport, sendReportNow (stub)

All routes include Zod validation schemas, auth guards (requireAuth, requireScope, requireMinRole), and rate limiting.

### Database Schema (5 tables + 3 materialized views)

- **bench_dashboards** - id, org_id, project_id, name, description, layout (JSONB), visibility, is_default, auto_refresh_seconds, created_by, updated_by, timestamps
- **bench_widgets** - id, dashboard_id, name, widget_type, data_source, entity, query_config (JSONB), viz_config, kpi_config, cache_ttl_seconds, timestamps
- **bench_scheduled_reports** - id, dashboard_id, org_id, name, cron_expression, cron_timezone, delivery_method, delivery_target, export_format, enabled, last_sent_at, created_by, timestamps
- **bench_materialized_views** - id, view_name (unique), description, refresh_cron, last_refreshed_at, refresh_duration_ms, created_at
- **bench_saved_queries** - id, org_id, name, description, data_source, entity, query_config, created_by, timestamps
- **Materialized views** - bench_mv_daily_task_throughput (Bam), bench_mv_pipeline_snapshot (Bond), bench_mv_campaign_engagement (Blast), all idempotently created in 0035_bench_tables.sql

All Drizzle schema files at `apps/bench-api/src/db/schema/` match the migration SQL and include proper indexes.

### Services (6 modules)

- **dashboard.service.ts** - listDashboards, getDashboard, createDashboard, updateDashboard, deleteDashboard, duplicateDashboard; cache invalidation on layout changes
- **widget.service.ts** - listWidgets, getWidget, createWidget, updateWidget, deleteWidget, executeWidgetQuery, refreshWidgetQuery (via redis caching)
- **query.service.ts** - executeQuery with parameterized SQL builder (guards against SQL injection), supports measures, dimensions, filters, sorts, limits, time dimensions, date range presets
- **report.service.ts** - listReports, createReport, updateReport, deleteReport, sendReportNow (enqueue stub)
- **materialized-view.service.ts** - listMaterializedViews, refreshView (CONCURRENT or fallback)
- **cache.service.ts** - Redis-backed TTL caching with per-widget and per-dashboard invalidation

### Frontend (8 pages)

- **dashboard-list.tsx** - List dashboards with visibility icons, create new, duplicate, delete via dropdown menu
- **dashboard-view.tsx** - Grid layout rendering with auto-refresh, fullscreen mode, date range picker, widget query execution
- **dashboard-edit.tsx** - Drag-and-drop grid editor using react-grid-layout
- **widget-wizard.tsx** - 4-step creation flow (data source, measures/dimensions, chart type, name/style)
- **widget-edit.tsx** - Update widget query and visualization config
- **explorer.tsx** - Ad-hoc query builder with dynamic source selection, preview execution, SQL display
- **reports.tsx** - Scheduled reports list, create/edit/delete with cron UI, delivery method selector
- **settings.tsx** - Organization-level dashboard settings (stub)

All pages import from use-dashboards, use-widgets, use-reports, use-data-sources hooks.

### Data Source Registry

- Compile-time static registry (`lib/data-source-registry.ts`) defining Bam (tasks), Bond (deals, pipeline_stages), Blast (campaigns), Bearing (goals, objectives), Helpdesk (tickets), Beacon (documents)
- Each source declares measures (count, sum, avg, min, max), dimensions, filters, join definitions
- `getDataSource(product, entity)` validator ensures Bench only queries registered entities

### MCP Tools (8 registered, partially complete)

bench_list_dashboards, bench_get_dashboard, bench_query_widget, bench_query_ad_hoc, bench_summarize_dashboard, bench_detect_anomalies, bench_generate_report (maps to sendReportNow stub), bench_list_data_sources, bench_list_widgets, bench_list_scheduled_reports.

All in `apps/mcp-server/src/tools/bench-tools.ts` with Zod input/output schemas.

### Tests

- **dashboard.test.ts** (213 lines) - mocked DB, tests for listDashboards, getDashboard, createDashboard, updateDashboard, deleteDashboard
- **widget.test.ts** (162 lines) - tests for listWidgets, getWidget, createWidget, updateWidget, executeWidgetQuery
- **query.test.ts** (174 lines) - parameterized query builder tests
- **security.test.ts** (116 lines) - permission tests for dashboard visibility and widget data source validation
- **data-source-registry.test.ts** (71 lines) - registry coverage tests
- Total: 736 lines of unit tests covering core logic; no frontend component tests

### Infrastructure

- **Port 4011** (docker-compose bench-api service)
- **Auth plugin** - requireAuth, requireScope, requireMinRole
- **Redis plugin** - fastify.redis for session, cache, rate limiting
- **Health endpoints** - /health, /health/ready with DB and Redis checks
- **Rate limiting** - global 100 req/min, overridden per-route

## Partial or divergent

- **Dashboard export endpoint** (`dashboards.routes.ts:126-145`) - POST /dashboards/:id/export returns queued status but does not enqueue Puppeteer job. Spec calls for PDF/PNG render via Puppeteer. No worker job exists to handle queue.
- **Report sendReportNow** (`reports.routes.ts:93-104`, `report.service.ts:138-155`) - Route handler calls sendReportNow which logs a TODO comment ("In production, this would enqueue a BullMQ job") but does not actually enqueue. No bench-owned worker job for scheduled report generation, cron parsing, or delivery (email/banter/brief).
- **Widget cache invalidation scope** - Dashboard-level layout changes call invalidateWidgetsForDashboard but no cascade on organization visibility changes. Spec implies org-wide broadcast; current impl is per-widget.
- **Materialized view refresh** - `materialized-view.service.ts refreshView()` is on-demand only. No scheduled worker job to run `refresh_cron` expressions.
- **Permissions model** - Routes enforce admin-only for report list/create (requireMinRole). Spec says Managers may configure reports; current implementation blocks Managers.

## Missing

### P0 (Blocking)

- **Worker job for scheduled report generation** - No `apps/worker/src/jobs/` entry for cron-driven report execution, dashboard render, and delivery. Blocks all scheduled report functionality.
- **Puppeteer export pipeline** - Dashboard export endpoint enqueues but has no handler. Spec requires PDF/PNG server-side render. Blocks export feature.

### P1 (Feature-complete but incomplete)

- **Materialized view refresh scheduler** - No worker job to execute `bench_materialized_views.refresh_cron` on BullMQ schedule. Materialized views are only refreshed on-demand via API.
- **Report delivery handlers** - sendReportNow acknowledges email, banter_channel, brief_document but has no downstream delivery logic. No integration with banter-api, brief-api, or email service.
- **Saved queries routes and UI** - `bench_saved_queries` table created but no CRUD routes or frontend pages to manage saved ad-hoc queries.
- **Widget gallery / templates** - Spec section 6.3 mentions pre-built widget templates (Bam velocity, Bond funnel, etc.). No template registry or seed data.
- **Query timeout enforcement** - `env.QUERY_TIMEOUT_MS` declared but not enforced in `query.service.ts`. Spec mandates 10s default with kill on overflow.
- **Result caching by date range** - `query.service.ts` caches by widget ID only. Dashboard date range picker accepts filter but does not vary cache key by range, so filter state may serve stale cross-date results.

### P2 (Nice-to-have)

- **Frontend unit and integration tests** - No `.test.tsx` or `.spec.tsx` files in `apps/bench/src`. Zero frontend test coverage.
- **Materialized view admin UI** - No route or page to monitor/trigger manual refresh of MVs or view refresh history.
- **Anomaly detection scheduling** - `bench_detect_anomalies` MCP tool exists but no scheduled worker invocation. Spec envisions weekly anomaly digest.
- **Custom field support** - Query builder does not reference `custom_field_definitions` table for per-project fields. Static registry only.
- **Bolt event emission** - Spec section 7 lists `bench.report.generated` and `bench.anomaly.detected` events. No Bolt integration to emit or ingest these.

## Architectural guidance

### Adding worker jobs for reports and export

1. Create `apps/worker/src/jobs/bench-report-generation.job.ts` following the pattern in `apps/worker/src/jobs/blast-send.job.ts` or `bolt-execute.job.ts`. Import cronParser and schedule. Register in `apps/worker/src/index.ts`.
2. Job handler: (a) fetch enabled `bench_scheduled_reports`, (b) evaluate `cron_expression` + `cron_timezone`, (c) if due, call bench-api `POST /dashboards/:id/query` to hydrate all widgets, (d) render to PDF via Puppeteer, (e) post to banter-api or brief-api or SMTP, (f) update `last_sent_at` on the report record.
3. Export handler: separate job or shared. On receipt of dashboard ID, iterate widgets, aggregate query results, render to Puppeteer headless browser, save PDF/PNG to MinIO, return signed URL.

### Result caching with date range awareness

1. Modify `query.service.ts executeQuery` to accept optional dateRange parameter and fold it into the cache key. Current key: `bench:query:${widgetId}`. New: `bench:query:${widgetId}:${hashDateRange(dateRange)}`.
2. Update `widget.service.ts executeWidgetQuery` to extract dateRange from dashboard context and pass through.
3. `dashboard-view.tsx` already has `state.dateRange`; pass it via new optional body param in POST `/widgets/:id/query` route.

### Scheduled materialized view refresh

1. Create `apps/worker/src/jobs/bench-materialized-view-refresh.job.ts`. On startup, register repeating job for each row in `bench_materialized_views` with its `refresh_cron`.
2. Handler: call `materialized-view.service.ts refreshView(view_name)`, catch exceptions, log duration and errors.
3. Consider alerting if refresh duration exceeds threshold (e.g., > 30s) to indicate schema drift or performance regression.

### Saved queries CRUD

1. Create `apps/bench-api/src/routes/saved-queries.routes.ts` with GET, POST, PATCH, DELETE following `dashboards.routes.ts` pattern.
2. Create `apps/bench-api/src/services/saved-queries.service.ts` with CRUD ops.
3. Add frontend pages: `saved-queries-list.tsx`, `saved-query-edit.tsx`. Link from `explorer.tsx` "Save" button.
4. Update `explorer.tsx` to load saved query by ID from route params and hydrate the form.

### Permission alignment (Manager access to reports)

1. Update `reports.routes.ts requireMinRole` from 'admin' to 'manager'.
2. Verify in CLAUDE.md section 8 which roles should configure reports. Current code enforces admin-only; spec allows admin + manager.

## Dependencies

### Inbound

- Bench-api depends on postgres (schema), redis (cache), banter-api (report delivery), brief-api (report delivery), email service (SMTP, report delivery)
- Bench-api calls `BBB_API_INTERNAL_URL` (http://api:4000) to resolve user org context and permissions
- MCP server depends on bench-api (all tools proxy to /v1/ routes)

### Outbound

- Bam, Bond, Blast, Bearing, Beacon, Helpdesk all register data sources with Bench's static registry but do not depend on Bench
- Worker job to be added will call back to bench-api and banter-api / brief-api for delivery

## Open questions

- **Query timeout enforcement:** `env.QUERY_TIMEOUT_MS` is parsed but never read. Should `query.service.ts` use PostgreSQL `SET statement_timeout`? Current implementation has no kill switch for runaway queries.
- **Cross-org visibility of dashboards:** Design doc specifies visibility = private | project | organization. Routes enforce org_id filtering but do not enforce project_id row-level access. A Manager in project A viewing org-wide dashboards could see project B data if visibility = organization. Is RLS required or is this acceptable?
- **MCP anomaly detection scheduling:** `bench_detect_anomalies` tool exists but spec (section 5.1) mentions "weekly scheduled Bolt automation triggers agent." No Bolt job entry point. Should Bolt call the MCP tool or should a bench worker job emit events for Bolt to ingest?
- **Custom field queryability:** Data source registry is static. Custom fields (per-project in Bam) are stored as JSONB. Should Bench expose custom fields in the registry or require users to query raw JSONB paths?
- **Materialized view concurrency:** `refreshView()` uses CONCURRENT if a unique index exists, else falls back. But `bench_mv_*` views are created without indexes. Should we add unique indexes post-hoc, or accept non-concurrent refresh with potential read locks?
