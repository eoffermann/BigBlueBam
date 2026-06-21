# Bench Design Audit

**Date:** 2026-04-09
**Auditor:** Claude (automated)
**Design Document:** `docs/DO_NOT_CHECK_IN_YET/Bench_Design_Document.md` v1.0
**Implementation:** `apps/bench-api/src/` (24 files), `apps/bench/src/` (23 files), `apps/mcp-server/src/tools/bench-tools.ts`

---

## Executive Summary

Bench (Dashboards & Analytics) has a **solid foundational implementation** covering the core CRUD surfaces, query execution engine, data source registry, and MCP tooling. The API layer is the strongest area, with all designed endpoints implemented and functional. The frontend provides the necessary page structure but lacks chart rendering (using raw data tables instead of Recharts) and the drag-and-drop grid layout (using a simple CSS grid instead of react-grid-layout). MCP tools cover all 9 designed tools. Key gaps are in the widget wizard (does not actually create widgets), widget edit page (placeholder only), chart visualizations, grid layout, caching integration, worker jobs, Bearing/Beacon data sources, and the report creation UI form.

**Overall Completion: ~68%**

| Area | Completion |
|------|-----------|
| Data Model / Schema | 95% |
| API Endpoints | 90% |
| Query Execution Engine | 85% |
| Data Source Registry | 75% |
| MCP Tools | 88% |
| Frontend - Pages / Routing | 80% |
| Frontend - Visualizations | 25% |
| Frontend - Interactions | 45% |
| Worker / Background Jobs | 5% |
| Permissions | 70% |
| Infrastructure (Docker, nginx) | 95% |

---

## Feature Rating Table

Rating scale: P0 = not implemented, P1 = stub/placeholder only, P2 = partial (major gaps), P3 = mostly done (minor gaps), P4 = complete with minor deviations, P5 = fully matches design.

### Data Model

| Feature | Rating | Notes |
|---------|--------|-------|
| `bench_dashboards` table | P5 | Exact match to design spec. All columns, indexes, CHECK constraints present in migration 0035 and Drizzle schema. |
| `bench_widgets` table | P5 | All 16 widget types in CHECK, all columns match. |
| `bench_scheduled_reports` table | P4 | Missing partial index `WHERE enabled = true` in Drizzle schema (present in migration SQL). All columns match. |
| `bench_materialized_views` table | P5 | Matches design. |
| `bench_saved_queries` table | P5 | Bonus table not in design spec -- added for explorer saved queries. |
| MV: `bench_mv_daily_task_throughput` | P3 | Created but columns differ from design: uses `total_tasks`/`with_state`/`total_points` instead of `completed`/`in_progress`/`points_completed`. References `state_id` instead of `state = 'done'`. |
| MV: `bench_mv_pipeline_snapshot` | P5 | Exact match. |
| MV: `bench_mv_campaign_engagement` | P5 | Exact match. |

### API Endpoints (Section 4)

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /dashboards` | P5 | Supports `project_id` and `visibility` filters. Returns widget counts. |
| `POST /dashboards` | P5 | Full validation, is_default toggle logic. |
| `GET /dashboards/:id` | P5 | Returns dashboard with all widgets. |
| `PATCH /dashboards/:id` | P5 | All fields updatable. |
| `DELETE /dashboards/:id` | P5 | Org-scoped deletion. |
| `POST /dashboards/:id/duplicate` | P5 | Clones widgets and remaps layout IDs. Well implemented. |
| `POST /dashboards/:id/export` | P1 | Stub -- returns `{status: 'queued'}` but does not actually enqueue Puppeteer job. |
| `POST /dashboards/:id/widgets` | P5 | Validates data source exists. |
| `GET /widgets/:id` | P5 | Org-scoped via dashboard join. |
| `PATCH /widgets/:id` | P5 | Partial update, validates data source if changed. |
| `DELETE /widgets/:id` | P5 | Org-scoped. |
| `POST /widgets/:id/query` | P4 | Works, but does not use Redis cache (CacheService exists but is not wired in). |
| `POST /widgets/:id/refresh` | P3 | Calls same path as `/query` -- does not invalidate cache because cache is not wired in. |
| `GET /data-sources` | P5 | Returns full registry. |
| `GET /data-sources/:product/:entity` | P5 | Returns single source with measures/dimensions/filters. |
| `POST /query/preview` | P5 | Full structured query builder with parameterized SQL, statement timeout, date presets. |
| `GET /reports` | P4 | Works but restricted to `admin` role; design says Manager should also have access. |
| `POST /reports` | P4 | Same role issue -- requires `admin`, design allows Manager. |
| `PATCH /reports/:id` | P4 | Same role issue. |
| `DELETE /reports/:id` | P5 | Matches. |
| `POST /reports/:id/send-now` | P2 | Updates `last_sent_at` but does not enqueue a BullMQ job for actual report generation. |

### Query Execution Engine (Section 2.3)

| Feature | Rating | Notes |
|---------|--------|-------|
| Parameterized SQL generation | P5 | Proper `$N` parameterized queries, injection prevention via identifier validation regex. |
| Tenant isolation (org_id filter) | P5 | Always injects `organization_id = $1` as first WHERE clause. |
| Statement timeout | P5 | Uses `SET LOCAL statement_timeout` inside transaction. Configurable via `QUERY_TIMEOUT_MS` env. |
| Read replica support | P5 | `DATABASE_READ_URL` env var, separate connection pool for queries. |
| Result caching (Redis) | P1 | `CacheService` class exists with get/set/invalidate methods, but is never instantiated or called from widget/query services. |
| Materialized view refresh | P3 | `materialized-view.service.ts` can refresh views with concurrent fallback, but no cron scheduler invokes it (no BullMQ worker job). |
| Date range presets | P5 | Supports `today`, `last_7_days`, `last_30_days`, `last_90_days`, `this_month`, `this_quarter`, `this_year`. |
| Filter operators | P5 | All 11 operators implemented: eq, neq, gt, gte, lt, lte, in, is_null, is_not_null, between, like. |

### Data Source Registry (Section 2.4)

| Feature | Rating | Notes |
|---------|--------|-------|
| Bam tasks | P5 | Comprehensive measures, dimensions, filters. |
| Bond deals | P5 | value, weighted_value, pipeline/stage dimensions. |
| Bond contacts | P5 | lead_score, lifecycle_stage. |
| Blast campaigns | P5 | Send/open/click metrics. |
| Helpdesk tickets | P4 | Present but missing resolution time measure mentioned in design widget gallery. |
| Beacon (knowledge base) | P0 | Design mentions Beacon as a data source but it is not in the registry. |
| Bearing (goals/OKRs) | P0 | Design mentions Bearing goal progress in widget gallery but no Bearing data source registered. |
| Cross-product MVs | P5 | 3 materialized view data sources registered. |
| Join definitions | P0 | `JoinDefinition` interface exists but no data source uses it. Design mentions joins. |

### MCP Tools (Section 5)

| Tool | Rating | Notes |
|------|--------|-------|
| `bench_list_dashboards` | P5 | Full filter support. |
| `bench_get_dashboard` | P5 | Returns widgets. |
| `bench_query_widget` | P5 | Executes query, returns rows + SQL + duration. |
| `bench_query_ad_hoc` | P5 | Structured query with measures, dimensions, filters, limit. |
| `bench_summarize_dashboard` | P4 | Fetches all widget data for AI summarization. Does not generate a natural-language summary itself (returns structured data for the agent to summarize). Reasonable approach. |
| `bench_detect_anomalies` | P4 | Compares current vs previous period with >30% threshold. Fixed to `created_at` field only. |
| `bench_generate_report` | P3 | Calls send-now endpoint which is itself a stub. |
| `bench_list_data_sources` | P5 | Returns full registry. |
| `bench_compare_periods` | P5 | Custom period comparison with percentage change. |

### Frontend Routes (Section 6.1)

| Route | Rating | Notes |
|-------|--------|-------|
| `/bench` (dashboard list) | P4 | Cards with name, description, updated_at, visibility icon, widget count. Missing "shared icon" mentioned in design (has visibility icon which serves same purpose). |
| `/bench/dashboards/:id` (canvas) | P3 | Renders widgets but uses simple CSS grid, not react-grid-layout 12-column grid. No drag-and-drop layout. |
| `/bench/dashboards/:id/edit` | P3 | Edit metadata and list widgets, but no drag-and-drop reordering or resize handles. |
| `/bench/widgets/new` (wizard) | P2 | 4-step wizard UI works (source, measures, chart, name) but final "Create Widget" button navigates home instead of calling the API. |
| `/bench/widgets/:id/edit` | P1 | Placeholder page -- displays widget ID but has no edit functionality. |
| `/bench/reports` | P3 | Lists reports with send-now and delete. "New Report" button exists but has no onClick handler (does nothing). |
| `/bench/explorer` | P3 | Functional query runner but uses hardcoded first measure + first 2 dimensions instead of letting user choose. No save query feature. |
| `/bench/settings` (bonus) | P4 | Not in design spec but useful -- shows data source registry, cache TTL, query timeout. |

### Frontend Visualizations (Section 6.2-6.3)

| Feature | Rating | Notes |
|---------|--------|-------|
| react-grid-layout 12-column grid | P0 | Not implemented. Uses CSS `grid-cols-3` layout. |
| Recharts chart rendering | P0 | No Recharts integration. Widgets display raw data in table rows or a single KPI number. |
| Widget Gallery (pre-built templates) | P0 | Not implemented. |
| Global date range picker | P0 | Not implemented. |
| Fullscreen mode | P4 | Implemented with toggle button, applies fixed positioning. |
| Auto-refresh | P5 | Dashboard-level auto-refresh with configurable interval, uses `setInterval` + `refetch()`. |
| PDF export via Puppeteer | P0 | API stub exists but no Puppeteer integration server-side. |

### Permissions (Section 8)

| Permission | Rating | Notes |
|-----------|--------|-------|
| View shared dashboards (all roles) | P4 | Auth required, org-scoped. No specific visibility-based filtering enforced (a member can see any dashboard in their org). |
| Create dashboards (Admin/Manager/Member) | P4 | Uses `requireScope('read_write')` which allows Member+. Viewer blocked. |
| Edit any dashboard (Admin/Manager) | P3 | No ownership check -- any authenticated user with read_write scope can edit any dashboard in their org. Design says Members should only edit their own. |
| Delete dashboards (Admin/Manager own-only) | P3 | Same gap as edit -- no ownership check. |
| Configure scheduled reports (Admin/Manager) | P3 | Requires `admin` role, but design allows Manager too. Currently blocks Managers. |
| Ad-hoc explorer (Admin/Manager/Member) | P5 | Only requires auth. |
| Set org-default dashboard (Admin only) | P3 | No admin-only guard on `is_default` field -- any dashboard creator can set it. |
| Row-level data visibility | P0 | Not implemented. Bench queries use org_id filtering but do not apply per-user row-level permissions from underlying products. A Member sees all org data, not just their own deals/tasks. |

### Events / Bolt Integration (Section 7)

| Event | Rating | Notes |
|-------|--------|-------|
| `bench.report.generated` | P0 | No event emission implemented. |
| `bench.anomaly.detected` | P0 | No event emission implemented. |

### Worker / Background Jobs

| Feature | Rating | Notes |
|---------|--------|-------|
| Scheduled report generation (BullMQ) | P0 | No bench-related job handler in the worker service. |
| Materialized view scheduled refresh | P0 | Service exists to refresh views but no cron/BullMQ trigger. |
| Heavy query background execution | P0 | Not implemented. |

### Infrastructure

| Feature | Rating | Notes |
|---------|--------|-------|
| Docker Compose service | P5 | `bench-api` service with proper environment, health check, dependencies. Port 4011. |
| nginx routing | P5 | `/bench/` serves SPA, `/bench/api/` proxies to bench-api:4011. |
| Dockerfile | P5 | Standard multi-stage Node build. |
| Migration (0035) | P5 | Idempotent, all tables + MVs + seed data. |

---

## Detailed Findings (P0-P3)

### P0: Not Implemented

1. **react-grid-layout Dashboard Canvas** (Section 6.2)
   The design calls for a 12-column responsive grid layout (Grafana-style) with drag-and-drop widget placement and resize handles. The implementation uses a static `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` CSS grid. The `layout` JSONB field on dashboards (with `x, y, w, h` per widget) is stored but never rendered as a positioned grid.

2. **Recharts Chart Rendering** (Section 6.2)
   No chart library is integrated. Widgets render raw data as a list of key-value rows, or a single large number for KPI cards. Bar charts, line charts, area charts, pie charts, funnels, gauges, and scatter plots all render the same table-of-rows view.

3. **Widget Gallery / Pre-built Templates** (Section 6.3)
   The design describes pre-built widget templates for each product (sprint velocity, pipeline funnel, campaign engagement, etc.). None exist. The wizard starts from a blank data source selection.

4. **Global Date Range Picker** (Section 6.2)
   No dashboard-level date range filter UI. Individual widgets have `date_range` in their query config, but there is no shared picker that overrides all time-aware widgets.

5. **PDF/PNG Export via Puppeteer** (Section 6.2)
   The export endpoint returns `{status: 'queued'}` but there is no Puppeteer or headless browser integration to actually render dashboards.

6. **Row-Level Data Visibility** (Section 8)
   Design states "Bench respects the same data access rules as the underlying products." The query engine filters by org_id only. A Member who should only see their own Bond deals will see all org deals in Bench.

7. **Bolt Events** (Section 7)
   `bench.report.generated` and `bench.anomaly.detected` events are not emitted anywhere.

8. **BullMQ Worker Jobs** (Section 2.2)
   No bench-related job handlers exist in `apps/worker/src/`. Scheduled report generation and materialized view refresh have no automated trigger.

9. **Beacon Data Source** (Section 2.4)
   Beacon is mentioned as a data source in the design but is not registered in the data source registry.

10. **Bearing Data Source** (Section 6.3)
    Widget gallery mentions "Goal progress bars, KR completion rates" but Bearing has no data source registered.

11. **Join Definitions** (Section 2.4)
    The `JoinDefinition` interface is defined but no data source uses joins. Cross-table queries (e.g., tasks with project names) are not possible.

### P1: Stub / Placeholder Only

1. **Widget Edit Page** (`/bench/widgets/:id/edit`)
   Renders only the widget ID and a description paragraph. No form, no data source selection, no save functionality.

2. **Result Caching** (`cache.service.ts`)
   `CacheService` class is fully coded with Redis get/set/invalidate, but it is never imported, instantiated, or called from any route or service. The `CACHE_TTL_SECONDS` env var is parsed but unused.

### P2: Partial (Major Gaps)

1. **Widget Wizard** (`/bench/widgets/new`)
   The 4-step UI (source -> measures -> chart -> style) is well-built but the final "Create Widget" step calls `onNavigate('/')` instead of calling the `useCreateWidget` hook. No widget is actually created. The wizard also lacks: filter configuration, time dimension selection, aggregation function selection per measure, and viz_config/kpi_config editing.

2. **Send Report Now**
   Updates `last_sent_at` timestamp and returns `{status: 'queued'}` but does not enqueue a BullMQ job. No actual report generation or delivery occurs.

### P3: Mostly Done (Minor Gaps)

1. **Dashboard View Canvas**
   Auto-refresh, fullscreen mode, refresh button, and widget data fetching all work. Missing: grid layout positioning, drag-and-drop, date range picker, export button functionality.

2. **Dashboard Edit Page**
   Metadata editing (name, description, visibility) works and saves. Widget list with delete works. Missing: drag-and-drop widget reordering, resize handles, auto_refresh_seconds editing, is_default toggle.

3. **Reports Page**
   Lists reports with status indicators, send-now, and delete. Missing: "New Report" button has no onClick (opens nothing), no edit functionality, no create report form/dialog.

4. **Explorer Page**
   Functional query execution with data source selection and result table. Missing: custom measure/dimension selection (hardcodes first measure + first 2 dimensions), filter builder, time dimension selection, save query capability.

5. **Materialized View Refresh Service**
   Can refresh views with CONCURRENTLY fallback. Missing: no scheduled trigger (no cron, no BullMQ job).

6. **Scheduled Reports Permissions**
   Reports require `admin` role, but design says Manager should also access. The `requireMinRole('admin')` check blocks managers (hierarchy is viewer < member < admin < owner, but "manager" is not in the hierarchy).

7. **Dashboard Ownership Enforcement**
   Any authenticated user with `read_write` scope can edit/delete any dashboard in their org. Design says Members should only edit/delete their own. No `created_by` check in update/delete services.

8. **MV: Daily Task Throughput**
   Column names and logic differ from design. Uses `total_tasks`/`with_state`/`total_points` vs design's `completed`/`in_progress`/`points_completed`. Uses `state_id IS NOT NULL` vs `state = 'done'`.

---

## P4-P5 Summary (Well-Implemented)

These areas closely match or fully match the design:

- **P5:** bench_dashboards schema, bench_widgets schema, bench_materialized_views schema, pipeline snapshot MV, campaign engagement MV, all dashboard CRUD endpoints, widget CRUD endpoints, data source list/detail endpoints, query preview endpoint, parameterized query builder, tenant isolation, statement timeout, read replica support, date range presets, filter operators, Docker service, nginx routing, migration 0035, auto-refresh, fullscreen mode, MCP tools (list_dashboards, get_dashboard, query_widget, query_ad_hoc, list_data_sources, compare_periods)
- **P4:** bench_scheduled_reports schema (minor index gap in Drizzle), dashboard list page, settings page, MCP summarize_dashboard, MCP detect_anomalies, dashboard create/update/delete permissions (close but missing ownership check)

---

## Recommendations

### High Priority (blocks usability)

1. **Wire up widget creation in the wizard.** The wizard UI is 80% done but the final step does not call the API. Connect `useCreateWidget` hook, pass `dashboardId` (needs to be selected or passed via URL param), and build the `query_config` from selected measures/dimensions.

2. **Add Recharts chart rendering.** Install `recharts` and create a `WidgetRenderer` component that switches on `widget_type` to render `BarChart`, `LineChart`, `AreaChart`, `PieChart`, `FunnelChart`, etc. This is the single most impactful visual improvement.

3. **Wire Redis cache into query execution.** The `CacheService` class is complete. Instantiate it in `server.ts` with the Redis client, pass it to `widget.service.ts`, and wrap `executeWidgetQuery` with cache-check-first logic. The `/refresh` endpoint should call `invalidate()` before re-querying.

4. **Implement the report creation form.** Add an onClick to the "New Report" button that opens a dialog/form for dashboard selection, cron expression, delivery method, delivery target, and export format.

### Medium Priority (functionality gaps)

5. **Integrate react-grid-layout** for the dashboard canvas. Read the `layout` JSONB (already stored with `x, y, w, h` fields) and render widgets in positioned grid cells. Add resize handles and drag-and-drop in edit mode.

6. **Add ownership checks** to dashboard update/delete. Compare `request.user.id` against `dashboard.created_by` when the user's role is `member`.

7. **Add Bearing and Beacon data sources** to the registry. At minimum: Bearing goals/key_results tables, Beacon articles/categories.

8. **Fix Manager access to scheduled reports.** Either add `manager` to the role hierarchy or change from `requireMinRole('admin')` to `requireMinRole('manager')`.

9. **Build the widget edit page.** Load the widget, populate a form similar to the wizard, and save changes via `useUpdateWidget`.

10. **Add a global date range picker** to the dashboard view header that overrides `date_range` for all time-aware widgets.

### Lower Priority (polish and completions)

11. Add BullMQ worker jobs for scheduled report generation and materialized view refresh.
12. Emit `bench.report.generated` and `bench.anomaly.detected` events for Bolt integration.
13. Implement row-level data visibility by injecting user-specific filters (e.g., `assignee_id = $user` for Bam tasks when the user is a Member).
14. Fix the `bench_mv_daily_task_throughput` MV to match design column names and filter logic.
15. Add join support to the query builder so widgets can show project names, user names, etc.
16. Add pre-built widget templates (widget gallery) for common use cases.
17. Enhance the explorer with custom measure/dimension selection, filter builder, and saved queries.
18. Add PDF export via Puppeteer (or a lighter alternative like html-to-image + jsPDF).

---

## File Inventory

### Backend (bench-api) -- 24 source files

| Path | Purpose |
|------|---------|
| `apps/bench-api/src/server.ts` | Fastify server setup, plugin registration, route mounting |
| `apps/bench-api/src/env.ts` | Zod-validated environment configuration |
| `apps/bench-api/src/db/index.ts` | Primary + read replica DB connections |
| `apps/bench-api/src/db/schema/bench-dashboards.ts` | Drizzle schema for dashboards |
| `apps/bench-api/src/db/schema/bench-widgets.ts` | Drizzle schema for widgets |
| `apps/bench-api/src/db/schema/bench-scheduled-reports.ts` | Drizzle schema for scheduled reports |
| `apps/bench-api/src/db/schema/bench-materialized-views.ts` | Drizzle schema for MV tracking |
| `apps/bench-api/src/db/schema/bench-saved-queries.ts` | Drizzle schema for saved queries (bonus) |
| `apps/bench-api/src/routes/dashboards.routes.ts` | 7 dashboard endpoints |
| `apps/bench-api/src/routes/widgets.routes.ts` | 6 widget endpoints |
| `apps/bench-api/src/routes/data-sources.routes.ts` | 3 data source / query endpoints |
| `apps/bench-api/src/routes/reports.routes.ts` | 5 report endpoints |
| `apps/bench-api/src/services/dashboard.service.ts` | Dashboard CRUD + duplicate logic |
| `apps/bench-api/src/services/widget.service.ts` | Widget CRUD + query execution |
| `apps/bench-api/src/services/query.service.ts` | Parameterized SQL builder + executor |
| `apps/bench-api/src/services/report.service.ts` | Report CRUD + send-now stub |
| `apps/bench-api/src/services/cache.service.ts` | Redis caching (coded but unwired) |
| `apps/bench-api/src/services/materialized-view.service.ts` | MV refresh with concurrent fallback |
| `apps/bench-api/src/lib/data-source-registry.ts` | Static registry with 8 data sources |
| `apps/bench-api/src/plugins/auth.ts` | Session + API key auth, multi-org, impersonation |

### Frontend (bench) -- 23 source files

| Path | Purpose |
|------|---------|
| `apps/bench/src/app.tsx` | Router, auth gate, layout wrapper |
| `apps/bench/src/pages/dashboard-list.tsx` | Dashboard cards with CRUD |
| `apps/bench/src/pages/dashboard-view.tsx` | Widget rendering, auto-refresh, fullscreen |
| `apps/bench/src/pages/dashboard-edit.tsx` | Metadata editing, widget list |
| `apps/bench/src/pages/widget-wizard.tsx` | 4-step widget creation (incomplete) |
| `apps/bench/src/pages/widget-edit.tsx` | Placeholder |
| `apps/bench/src/pages/explorer.tsx` | Ad-hoc query runner |
| `apps/bench/src/pages/reports.tsx` | Scheduled reports list |
| `apps/bench/src/pages/settings.tsx` | Data source registry view (bonus) |
| `apps/bench/src/hooks/use-dashboards.ts` | TanStack Query hooks for dashboards |
| `apps/bench/src/hooks/use-widgets.ts` | TanStack Query hooks for widgets |
| `apps/bench/src/hooks/use-reports.ts` | TanStack Query hooks for reports |
| `apps/bench/src/hooks/use-data-sources.ts` | TanStack Query hooks for data sources |

### MCP Tools -- 1 file, 9 tools

`apps/mcp-server/src/tools/bench-tools.ts`

### Migration -- 1 file

`infra/postgres/migrations/0035_bench_tables.sql`
