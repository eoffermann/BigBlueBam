# Bench — App Dossier

Research dossier for the writer. Everything below is cited to real files in the repo.
Where a claim comes from docs/marketing rather than code, it is marked **[doc-only]**.

---

## 1. App identity

- **App key:** `bench`
- **Display name:** Bench
- **Category:** Analytics & dashboards
- **SPA path:** `/bench/` (React SPA in `apps/bench/src`)
- **API path:** `/bench/api/` → bench-api Fastify service (internal :4011). All routes under `/v1` (`apps/bench-api/src/server.ts:111-118`).
- **Frontend router:** hand-rolled, keyed off `window.location.pathname`, base `/bench` (`apps/bench/src/app.tsx:28-66`). No React Router.
- **API client base:** `/bench/api` (`apps/bench/src/lib/api.ts:17`); sends `X-Org-Id` header from the auth store + cookie session (`credentials:'include'`).
- **Prerequisites:**
  - Must be logged in to BigBlueBam (Bam at `/b3/`). Unauthenticated gate: heading "Bench Analytics", text "Please log in to BigBlueBam first to access Bench.", button "Go to BigBlueBam Login" → `/b3/` (`apps/bench/src/app.tsx:129-141`).
  - Auth by session cookie or Bearer API key (`apps/bench-api/src/plugins/auth.ts:184-257`); active org from memberships, overridable via `X-Org-Id`.
- **Worker dependencies:** `apps/worker/src/jobs/bench-report-deliver.job.ts` (report delivery, emits `report.delivered` Bolt event source `bench`) and `apps/worker/src/jobs/bench-mv-refresh.job.ts` (MV refresh ~every 5 min).
- **RBAC:** API-key scope hierarchy `read < read_write < admin` (`auth.ts:330-360`); per-action `fastify.requireCan(...)` gates on reports + MV refresh (`apps/bench-api/src/plugins/permissions.ts`).

---

## 2. Key concepts and vocabulary

- **Dashboard** (`bench_dashboards`, schema `apps/bench-api/src/db/schema/bench-dashboards.ts`): named container of widgets with `layout` (JSONB grid placements), `visibility`, optional `project_id`, `is_default`, optional `auto_refresh_seconds`.
  - **visibility** enum: `private | project | organization` (`dashboards.routes.ts:14`; DB default `private`). UI icons Lock/Users/Globe (`dashboard-list.tsx:10-14`).
  - **is_default:** setting default clears siblings' default in the org (`dashboard.service.ts:128-134`).
- **Widget** (`bench_widgets`, schema `bench-widgets.ts`): one visualization on a dashboard. Fields: `name`, `widget_type`, `data_source` (product), `entity`, `query_config` (JSONB), `viz_config`, `kpi_config`, `cache_ttl_seconds`.
  - **widget_type** enum (route, `widgets.routes.ts:46-52`): bar_chart, line_chart, area_chart, pie_chart, donut_chart, scatter_plot, heatmap, funnel, table, pivot_table, kpi_card, counter, gauge, progress_bar, text, markdown.
  - **Renderer reality** (`apps/bench/src/components/widgets/chart-renderer.tsx:45-209`): only bar/line/area/pie/donut/kpi_card/counter/table render distinctly; all others fall through to a table. UI type pickers offer only 11 types (`widget-wizard.tsx:14-26`, `widget-edit.tsx:13-25`).
- **Query config** (compiled to SQL by `apps/bench-api/src/services/query.service.ts`):
  - measures `{field,agg,alias?}`, agg ∈ count|sum|avg|min|max (≥1 required).
  - dimensions `{field,alias?}` (group-by).
  - filters `{field,op,value}`, op ∈ eq|neq|gt|gte|lt|lte|in|is_null|is_not_null|between|like.
  - sort `[{field,dir}]` asc|desc; limit ≤10000 (default 1000).
  - time_dimension `{field,granularity}` granularity ∈ hour|day|week|month|quarter|year → `date_trunc` as `time_bucket`.
  - date_range `{preset?,start?,end?}`. Presets: today, last_1_days, last_2_days, last_7_days, last_30_days, last_90_days, this_month, this_quarter, this_year (`query.service.ts:124-157`).
- **Data source** (registry, compile-time allowlist, `apps/bench-api/src/lib/data-source-registry.ts`): a `(product,entity)` → `baseTable` with declared measures/dimensions/filters and a tenant `orgColumn`. Identifiers regex-validated `^[a-z_][a-z0-9_]*$` (`query.service.ts:53-63`). Bench can only query approved tables/columns.
  - **orgColumn:** per-source tenant column; default `organization_id` (`DEFAULT_ORG_COLUMN`); Bureau overrides to `org_id`. Builder always injects `<orgColumn> = $org` first (`query.service.ts:227-228`).
- **Saved query** (`bench_saved_queries`, schema `bench-saved-queries.ts`): reusable `(data_source,entity,query_config)`.
- **Scheduled report** (`bench_scheduled_reports`, schema `bench-scheduled-reports.ts`): cron-driven dashboard snapshot delivered to a target.
  - delivery_method ∈ email | banter_channel | brief_document (`reports.routes.ts:15`).
  - export_format ∈ pdf | png | csv (default pdf).
  - delivery status lifecycle: API send-now → `queued` (`report.service.ts:160`); worker → `delivered`/`failed` (`bench-report-deliver.job.ts:80,101`); `recordDeliveryOutcome` knows sent|failed|pending|queued (`report.service.ts:176-211`); frontend badge colors sent/queued/failed (`reports.tsx:318-337`). Mismatch — see §7.
- **Materialized view** (`bench_materialized_views`, schema `bench-materialized-views.ts`): pre-computed `bench_mv_*` rollups with `refresh_cron`, refresh state, `next_scheduled_at`. Three registered as queryable sources (product `bench`): daily_task_throughput, pipeline_snapshot, campaign_engagement.
- **Cache:** widget + ad-hoc results cached in Redis; default TTL 60s (Settings). Statement timeout default 10,000ms (`SET LOCAL statement_timeout`, `query.service.ts:326`).

### Registered data sources

`apps/bench-api/src/lib/data-source-registry.ts`. product:entity (baseTable, orgColumn):

| product | entity | label | baseTable | orgColumn |
|---|---|---|---|---|
| bam | tasks | Tasks | tasks | default organization_id — BROKEN |
| bond | deals | Deals | bond_deals | organization_id |
| bond | contacts | Contacts | bond_contacts | organization_id |
| blast | campaigns | Campaigns | blast_campaigns | organization_id |
| helpdesk | tickets | Tickets | tickets | default organization_id — BROKEN |
| beacon | articles | Knowledge Base Articles | beacon_entries | organization_id |
| bearing | goals | Goals | bearing_goals | organization_id |
| bureau | floor_analytics | Bureau Floor Analytics (Daily) | bureau_floor_analytics | org_id (overridden) |
| bench | daily_task_throughput | Daily Task Throughput | bench_mv_daily_task_throughput | organization_id |
| bench | pipeline_snapshot | Pipeline Snapshot | bench_mv_pipeline_snapshot | organization_id |
| bench | campaign_engagement | Campaign Engagement | bench_mv_campaign_engagement | organization_id |

---

## 3. Feature inventory

Sidebar nav labels (apps/bench/src/components/layout/bench-sidebar.tsx:18-24): Dashboards, Explorer, Reports, Saved Queries, Bench Settings. Header has Launchpad app-switcher, breadcrumbs, OrgSwitcher, notifications bell, user menu (bench-layout.tsx). Pressing the question-mark key outside inputs opens in-app Help (app.tsx:103-114).

### 3.1 Dashboards list (view title: "Dashboards")
- Page /bench/ to DashboardListPage (apps/bench/src/pages/dashboard-list.tsx).
- Heading "Dashboards", subtitle "Build and share analytics dashboards across the BigBlueBam suite." Primary button "New Dashboard" (Plus icon).
- Cards: name, optional description, visibility pill (Private/Project/Organization with Lock/Users/Globe icon), "N widgets", relative updated time. Kebab menu: View, Duplicate, Delete (destructive).
- Empty state: "No dashboards yet" / "Create your first dashboard to start visualizing data."
- Actions: New Dashboard -> POST /v1/dashboards with name "Untitled Dashboard", visibility private, then navigate /dashboards/:id/edit. Card/View -> /dashboards/:id. Duplicate -> POST /v1/dashboards/:id/duplicate. Delete -> DELETE /v1/dashboards/:id.

### 3.2 Dashboard view
- Page /dashboards/:id to DashboardViewPage (apps/bench/src/pages/dashboard-view.tsx).
- Toolbar: DateRangePicker, Refresh button (RefreshCw), fullscreen toggle (Maximize2, no text label), Edit button.
- Widget grid; each WidgetCard shows name, type pill, chart, and query duration_ms.
- Auto-refresh when auto_refresh_seconds is set (dashboard-view.tsx:54-59).
- Empty state: "This dashboard has no widgets yet." plus "Add widgets" link to edit.
- Routes: GET /v1/dashboards/:id; per-widget POST /v1/widgets/:id/query.
- DateRangePicker (apps/bench/src/components/dashboards/date-range-picker.tsx): tabs Presets / Custom Range; presets Today, Last 7 days, Last 30 days, Last 90 days, This month, This quarter, This year; custom From/To plus Apply. NOTE: the range is NOT passed into widget queries (decorative) - see Section 7.

### 3.3 Dashboard edit (view title: "Edit Dashboard")
- Page /dashboards/:id/edit to DashboardEditPage (apps/bench/src/pages/dashboard-edit.tsx).
- Back arrow, heading "Edit Dashboard", Save button.
- Metadata fields: Name (id bench-dashboard-name), Description (id bench-dashboard-description), Visibility select (Private/Project/Organization).
- Widgets section buttons: Templates (Sparkles icon, toggles gallery) and Custom Widget (Plus icon to wizard).
- Each widget row: drag handle (GripVertical, visual only - no reorder wired), name, "data_source / entity - type" subline, Edit link, trash delete.
- Empty-state text says "Add Widget" (label drift; real buttons are Templates / Custom Widget).
- Actions: Save -> PATCH /v1/dashboards/:id with name/description/visibility. Templates select -> POST /v1/dashboards/:id/widgets. Custom Widget -> /dashboards/:id/widgets/new. Widget Edit -> /widgets/:id/edit. Trash -> DELETE /v1/widgets/:id.
- Sets Bureau presence label to dashboard name via useBureauLocationLabel (dashboard-edit.tsx:6,20).

### 3.4 Widget Gallery (view title: "Widget Templates")
- apps/bench/src/components/widgets/widget-gallery.tsx, rendered inline in Dashboard Edit when Templates is toggled.
- Heading "Widget Templates", Close, category filter pills (All, Project Management, CRM, Email Marketing, Support, Cross-Product), preset card grid (icon, type pill, name, description, category).
- Presets (id / name / type / source:entity): bam_sprint_velocity / Sprint Velocity / bar_chart / bam:tasks; bam_tasks_by_state / Tasks by State / donut_chart / bam:tasks; bam_task_count / Total Open Tasks / kpi_card / bam:tasks; bam_tasks_by_priority / Tasks by Priority / bar_chart / bam:tasks; bond_pipeline_value / Pipeline Value / kpi_card / bond:deals; bond_deals_by_stage / Deals by Stage / bar_chart / bond:deals; bond_pipeline_funnel / Pipeline Funnel / funnel / bond:deals; blast_open_rate / Avg Open Rate / kpi_card / blast:campaigns; blast_engagement_trend / Engagement Trend / line_chart / blast:campaigns; helpdesk_open_tickets / Open Tickets / kpi_card / helpdesk:tickets; helpdesk_by_priority / Tickets by Priority / pie_chart / helpdesk:tickets; mv_daily_throughput / Daily Task Throughput / area_chart / mv:daily_task_throughput.
- Action: select preset -> POST /v1/dashboards/:id/widgets. WARNING: several presets reference fields/sources that do not exist in the registry (points, sprint_name, state_name, total_tasks, and data_source mv) - see Section 7.

### 3.5 Widget Wizard (view title: "New Widget")
- Page /dashboards/:id/widgets/new to WidgetWizardPage (apps/bench/src/pages/widget-wizard.tsx).
- Back arrow, heading "New Widget", 4-step indicator: Data Source, Measures & Dimensions, Chart Type, Name & Style.
  - Step 1 Data Source: button list of registered sources (product pill + label + description) from GET /v1/data-sources.
  - Step 2: checkbox columns Measures (with allowed aggregations) and Dimensions (with dim type).
  - Step 3 Chart Type: 3-col grid of 11 types - Bar Chart, Line Chart, Area Chart, Pie Chart, Donut Chart, KPI Card, Counter, Table, Funnel, Gauge, Progress Bar.
  - Step 4 Name & Style: Widget Name input (placeholder e.g. Task Completion by Priority) plus a summary panel (Source / Measures / Dimensions / Type).
  - Footer: Cancel/Back, Next / Create Widget (shows Creating...).
- Create: builds query_config (first allowed aggregation per chosen measure; dimensions as group-by) and calls POST /v1/dashboards/:id/widgets, then returns to /dashboards/:id/edit (widget-wizard.tsx:216-242).

### 3.6 Widget Edit (view title: "Edit Widget") with live preview
- Page /widgets/:id/edit to WidgetEditPage (apps/bench/src/pages/widget-edit.tsx).
- Heading "Edit Widget", Save. Two columns.
  - Left: Widget Name, Data Source select, Chart Type grid (11 types), Measures/Dimensions checkboxes, Display Options checkboxes Show legend and Stacked.
  - Right: Preview panel with a Refresh button rendering live query results via ChartRenderer; shows Query took Nms - M rows.
- Save -> PATCH /v1/widgets/:id with name, widget_type, data_source, entity, query_config, viz_config show_legend + stacked; then returns to /dashboards/:dashboard_id/edit.
- Routes: GET /v1/widgets/:id, POST /v1/widgets/:id/query (preview), GET /v1/data-sources, PATCH /v1/widgets/:id.

### 3.7 Ad-Hoc Explorer (view title: "Ad-Hoc Explorer")
- Page /explorer to ExplorerPage (apps/bench/src/pages/explorer.tsx).
- Heading "Ad-Hoc Explorer", subtitle Query any data source interactively. Left panel: Data Source dropdown (shows [product] label), read-only Measures and Dimensions lists, Run Query button (Play icon). Right panel: error banner, generated SQL (dev only), N rows in Xms, results table.
- Behavior: Run builds a fixed query - first measure with its first aggregation plus the first two dimensions, limit 50 - and calls POST /v1/query/preview (explorer.tsx:25-53). It is NOT a freeform builder.
- Saved-query handoff: Saved Queries Run navigates here with query params source and saved_query_id, but the Explorer ignores them - see Section 7.
- Route: POST /v1/query/preview (rate-limited 30/min).

### 3.8 Scheduled Reports (view title: "Scheduled Reports")
- Page /reports to ReportsPage (apps/bench/src/pages/reports.tsx).
- Heading "Scheduled Reports", subtitle Automated dashboard snapshots delivered on a schedule. Primary button "New Report".
  - Each row: delivery-method icon (Mail/MessageCircle/FileText), name, cron (timezone) - FORMAT subline, last-sent text (Last sent X or Never sent), optional delivery-status pill (sent/queued/failed colors), Active/Paused pill, Send now play button, delete trash.
  - Empty state: No scheduled reports / Set up automated dashboard exports delivered via email or Banter.
- New Report dialog title "New Scheduled Report". Fields: Report Name (placeholder Weekly sprint summary); Dashboard select; Schedule preset select (Every day at 9 AM, Every Monday at 9 AM, First of every month at 9 AM, Every Friday at 5 PM, Custom) plus a custom cron text input and a detected timezone line; Delivery Method select (Email / Banter Channel / Brief Document, with the target field label and placeholder switching to Email Address, Channel, or Document accordingly); Export Format radio (PDF / PNG / CSV); Enable immediately checkbox; buttons Cancel / Create Report.
- Actions: Create -> POST /v1/reports (requires bench.report.create permission + admin scope). Send now -> POST /v1/reports/:id/send-now (requires bench.report_send_now.create). Delete -> DELETE /v1/reports/:id (requires bench.report.delete + admin).
- Other routes: GET /v1/reports with optional search (bench.report.list); PATCH /v1/reports/:id (bench.report.update + admin; NO UI calls it).
- Delivery is a STUB: the worker logs simulating delivery (stub) and stamps status only (bench-report-deliver.job.ts:88-108); the dashboard export route POST /v1/dashboards/:id/export is also a stub returning status queued, format pdf (dashboards.routes.ts:127-145).

### 3.9 Saved Queries (view title: "Saved Queries")
- Page /saved-queries to SavedQueriesPage (apps/bench/src/pages/saved-queries.tsx).
- Heading "Saved Queries", subtitle Reusable query definitions you can run from the ad-hoc explorer. Primary button "New Query".
  - Each row: name, optional description, data_source/entity - Created DATE subline, Run button, Edit (pencil), Delete (trash).
  - Empty state: No saved queries / Create a query to save and re-run later from the explorer.
- Dialog title "New Saved Query" or "Edit Saved Query". Fields Name (placeholder Monthly revenue breakdown), Description, Data Source select; buttons Cancel / Create or Update. query_config is an empty object on create and only preserved on edit - there is no in-UI measure/dimension builder for saved queries.
- Routes: GET /v1/saved-queries, POST /v1/saved-queries, PATCH /v1/saved-queries/:id, DELETE /v1/saved-queries/:id. (GET /v1/saved-queries/:id exists but is unused by the UI.)

### 3.10 Bench Settings (view title: "Settings")
- Page /settings to SettingsPage (apps/bench/src/pages/settings.tsx).
- Heading "Settings", subtitle Configure Bench data sources and preferences. Three read-only sections: Data Source Registry (grouped by product, each shows label/description and N measures / N dimensions / N filters), Cache (Default Cache TTL = 60 seconds), Query Execution (Statement Timeout = 10,000 ms). Nothing is editable.

### 3.11 Materialized Views (admin; no dedicated UI)
- Routes: GET /v1/materialized-views (list with refresh state), POST /v1/materialized-views/:viewName/refresh (requires bench.materialized_view_refresh.create) (apps/bench-api/src/routes/materialized-views.routes.ts).
- No page in apps/bench/src/pages/ calls these. MVs surface to users only as the three bench:* queryable data sources; refresh runs automatically via the worker. Routes exist for admin/agent/manual use.

### REST route catalog (full, prefix /v1)

Dashboards (dashboards.routes.ts): GET /dashboards (filters project_id, visibility; adds widget_count); POST /dashboards (read_write, rate 20/min); GET /dashboards/:id (with widgets); PATCH /dashboards/:id (read_write; members own-only); DELETE /dashboards/:id (read_write; members own-only); POST /dashboards/:id/duplicate (clones widgets, remaps layout, forces visibility private); POST /dashboards/:id/export (STUB).

Widgets (widgets.routes.ts): GET /widgets (optional dashboard_id, joins dashboard name); POST /dashboards/:id/widgets (read_write, validates source against registry); GET /widgets/:id; PATCH /widgets/:id (read_write, invalidates cache); DELETE /widgets/:id (read_write); POST /widgets/:id/query (Redis-cached by widget TTL); POST /widgets/:id/refresh (invalidate cache + re-query).

Data sources / ad-hoc (data-sources.routes.ts): GET /data-sources; GET /data-sources/:product/:entity (404 if unknown); POST /query/preview (rate 30/min).

Reports (reports.routes.ts): GET /reports; POST /reports; PATCH /reports/:id; DELETE /reports/:id; POST /reports/:id/send-now.

Saved queries (saved-queries.routes.ts): GET /saved-queries; GET /saved-queries/:id; POST /saved-queries; PATCH /saved-queries/:id; DELETE /saved-queries/:id (read_write on writes).

Materialized views (materialized-views.routes.ts): GET /materialized-views; POST /materialized-views/:viewName/refresh.

Health: /healthz, /readyz (DB + Redis).

---

## 4. Candidate user stories

1. Build a leadership dashboard from scratch. Dashboards -> New Dashboard -> opens in edit -> set Name/Description/Visibility -> Save -> add widgets via Templates or Custom Widget (wizard) -> open /dashboards/:id to view.
2. Add a widget with the wizard. From a dashboard edit page -> Custom Widget -> pick Data Source -> check Measures & Dimensions -> pick Chart Type -> Name -> Create Widget.
3. Drop in a prebuilt widget. Edit page -> Templates -> filter by category -> click a preset card -> widget appears. (Caveat: bam/helpdesk and mv: presets are broken; see Section 7.)
4. Tune a widget and preview it live. Widget row -> Edit -> adjust source/type/measures/dimensions/legend/stacked -> watch the Preview -> Save.
5. Explore data ad-hoc. Explorer -> choose a Data Source -> Run Query -> read the table + SQL + timing. Works for Bond/Blast/Beacon/Bearing/Bureau/bench-MV sources.
6. Save and re-run a query. Saved Queries -> New Query -> name + data source -> Create; later click Run (intended to open in Explorer).
7. Schedule a recurring report. Reports -> New Report -> pick dashboard, schedule preset/cron, delivery method + target, export format -> Create Report; optionally Send now; watch the status/Active pill. (Delivery is a stub today.)
8. Duplicate a dashboard as a template. Dashboards -> card kebab -> Duplicate -> edit the copy.
9. Set a wall-board / auto-refresh dashboard. Create dashboard with auto_refresh_seconds (API/seed today; no field in the edit UI), open the view, use fullscreen toggle.
10. Agent-driven: summarize a dashboard / detect anomalies / compare periods. Via MCP tools (Section 5).

---

## 5. Agent flows (MCP tools)

File: apps/mcp-server/src/tools/bench-tools.ts. 11 tools, all calling bench-api over HTTP with the caller bearer token.

| Tool | What it does | Human feature | Backing route |
|---|---|---|---|
| bench_list_dashboards | List dashboards (filter project_id/visibility) | Dashboards list | GET /dashboards |
| bench_get_dashboard | Dashboard + widgets + layout | Dashboard view | GET /dashboards/:id |
| bench_list_widgets | List widgets org-wide or per dashboard (resolver addressability) | Edit page widget list | GET /widgets |
| bench_query_widget | Execute one widget query (rows/sql/duration) | Widget render/preview | POST /widgets/:id/query |
| bench_query_ad_hoc | Structured query against any source (measures/dimensions/filters/limit) | Ad-Hoc Explorer | POST /query/preview |
| bench_summarize_dashboard | Fetch dashboard + run every widget query, bundle for AI summary | (no direct UI button) | GET /dashboards/:id + per-widget POST /widgets/:id/query |
| bench_detect_anomalies | Most-recent vs previous period; flags change over 30%; severity high/medium/low | (no UI - agent only) | two POST /query/preview |
| bench_compare_periods | Two arbitrary date ranges; returns both values + percent change + direction | (no UI - agent only) | two POST /query/preview |
| bench_generate_report | Trigger immediate report delivery | Reports Send now | POST /reports/:id/send-now |
| bench_list_scheduled_reports | List reports (fuzzy name search); normalizes to schedule/recipients shape | Reports list | GET /reports |
| bench_list_data_sources | List sources + schemas (discovery) | Settings registry / wizard source list | GET /data-sources |

Notes:
- Anomaly detection and period comparison are MCP-only (no UI) and both hard-code a created_at filter (bench-tools.ts:204,214,383-386). They therefore only work for sources whose baseTable has created_at AND a correct org column - i.e. NOT bureau (uses day), NOT bam:tasks / helpdesk:tickets (org column broken), NOT the MVs (no created_at).
- bench_summarize_dashboard is the canonical read-this-dashboard-for-me entrypoint; broken-source widgets come back as {error: query failed} per widget rather than failing the whole call.
- No Bench tools are destructive/confirm-gated. There are no create/delete dashboard/widget MCP tools - agents can read and run queries and trigger an existing report, but cannot build dashboards via MCP.

---

## 6. Screenshots available

Directory: docs/apps/bench/screenshots/{light,dark}/. Catalog: docs/apps/bench/meta.json (catalogs only the first 6 per theme; the widget-wizard pair is on disk but NOT in meta.json). Generator: scripts/screenshots-bench.js.

| File (in both light/ and dark/) | Depicts | Best illustrates |
|---|---|---|
| 01-dashboard-list.png | Dashboards list grid | Story 1; Section 3.1 |
| 02-dashboard-view.png | A rendered dashboard with widgets | Section 3.2 |
| 03-explorer.png | Ad-Hoc Explorer (source + results) | Story 5; Section 3.7 |
| 04-reports.png | Scheduled Reports list | Story 7; Section 3.8 |
| 05-settings.png | Settings (registry, cache, timeout) | Section 3.10 |
| 06-saved-queries.png | Saved Queries list | Story 6; Section 3.9 |
| 06-widget-wizard.png | Widget Wizard steps | Story 2; Section 3.5 (NOT in meta.json; shares the 06- prefix) |

---

## 7. Discrepancies (code vs docs/marketing vs itself)

1. BROKEN data sources - bam:tasks and helpdesk:tickets query the wrong org column. The registry leaves orgColumn unset for bam:tasks (baseTable tasks) and helpdesk:tickets (baseTable tickets), so the builder emits organization_id = $1. Neither table HAS an organization_id column - tasks is scoped by project_id only, tickets by project_id only (infra/postgres/migrations/0000_init.sql, confirmed by column inspection). Every query against these two sources throws Postgres 42703 column organization_id does not exist and returns nothing. Same bug class the Bureau fix addressed (Bureau correctly overrides orgColumn to org_id). Impact: the seeded Engineering Overview dashboard task widgets (Open Tasks, Tasks by Priority, Task State Distribution in scripts/seed-bench.sql) silently show No data; helpdesk gallery presets are dead too. There is no single-string fix in the registry (these tables genuinely have no org column) - they need a join to projects for org scoping, not just an orgColumn override. (The JoinDefinition interface exists in the registry but is never consumed by query.service.ts.)

2. Widget Gallery presets reference non-existent sources/fields. widget-gallery.tsx uses data_source mv (registry product is bench, not mv) for mv_daily_throughput, and field names absent from the registry: points / sprint_name (bam has story_points, no sprint_name), state_name (registry dim is state), total_tasks (MV measures are completed/in_progress/points_completed). Selecting these presets fails registry validation (mv unknown source) or fails at query time. The seed SQL by contrast uses the correct data_source bench for MVs - so seed and gallery disagree.

3. Report delivery-status string mismatch. API send-now writes last_delivery_status queued then sent semantics (report.service.ts), the frontend badge only colors sent/queued/failed (reports.tsx:318-337), but the worker writes delivered (bench-report-deliver.job.ts:101). A delivered report shows the gray default badge, not green, because delivered is not in the frontend known set. recordDeliveryOutcome (report.service.ts:176-211) speaks sent/failed/pending/queued - a third vocabulary. Needs to be unified.

4. DateRangePicker on the dashboard view is inert. The view holds dateRange state and renders the picker, but never passes it into useWidgetQuery or the widget query body (dashboard-view.tsx:13-46,90). Changing the range does nothing. Field-name drift too: the picker emits from/to while the server date_range schema expects start/end (date-range-picker.tsx:4-8 vs query.service.ts:33-37).

5. Saved-query Run to Explorer handoff is not wired. handleRun navigates to /explorer with source and saved_query_id params (saved-queries.tsx:222-226) but ExplorerPage ignores query params and never loads a saved query - it always runs its own canned shape. The GET /v1/saved-queries/:id route is unused.

6. Reports PATCH route has no UI. PATCH /v1/reports/:id exists but no UI hook calls it; reports can only be created, sent-now, or deleted from the UI. Editing requires the API/MCP.

7. Marketing claims vs reality.
   - Guide/marketing call it a drag-and-drop canvas / Dashboard Builder with a drag-and-drop canvas (docs/apps/bench/guide.md:16, marketing.md:12). The edit page has a GripVertical handle but NO drag-and-drop reordering is implemented; layout is JSONB set by seed/duplicate logic, not by dragging in the UI.
   - Guide lists widgets including text (guide.md:16); the type is route-valid but unrenderable (falls to table) and absent from UI type pickers.
   - Marketing: Scheduled Reports that email dashboard snapshots - delivery is a logging stub; no email/PDF is actually produced (bench-report-deliver.job.ts, dashboards.routes.ts:135).
   - README line 411 and guide.md list anomaly detection and period compare as Bench features - true, but MCP-only, no human UI.

8. README MCP count drift. README line 862 says 11 Bench within a total of 340; CLAUDE.md says 360 total. Bench own count (11) matches the tool file. Platform totals are inconsistent between README and CLAUDE.md (not Bench-specific).

9. meta.json omits the widget-wizard screenshot though 06-widget-wizard.png exists in both themes; both 06-saved-queries.png and 06-widget-wizard.png share the 06- prefix.

10. Bureau source is a nightly rollup, not live (documented in the registry comment, data-source-registry.ts:246-259): a 1-day window is usually blank mid-day; widgets should use last_7_days. By design but a footgun, and bench_detect_anomalies/bench_compare_periods will not work on it (they filter created_at, which the table lacks).

11. Explorer is not the freeform SQL-like tool the guide implies. guide.md/narrative call it running SQL-like queries; the actual Explorer only runs one canned shape per source (first measure + first two dimensions, limit 50) with no measure/dimension/filter controls.

---

## 8. Open questions

1. What is the intended fix for bam:tasks and helpdesk:tickets org scoping? They have no org column at all - does Bench need a joins definition (the JoinDefinition interface exists but is unused) to reach org via projects, or should these sources be replaced by MVs?
2. Are the broken widget-gallery presets (mv source, points, state_name, total_tasks) meant to be fixed to match the registry, or is the gallery slated for replacement?
3. Which delivery-status vocabulary is canonical - queued/sent/failed/pending (service) or delivered/failed (worker)? The UI badge must agree.
4. Should the dashboard-view DateRangePicker actually filter widgets, or is it decorative? If functional, the from/to to start/end mapping needs wiring and the range needs to reach POST /widgets/:id/query (which currently takes no body).
5. Is real report rendering/delivery (PDF, email, Banter post, Brief doc) planned? All code paths are stubs/log-only today.
6. Is the saved-query to explorer Run handoff supposed to pre-load the saved query_config into a freeform builder that does not yet exist in the Explorer?
7. Is there an intended human UI for materialized-view status/refresh (API routes and refresh-state columns exist but nothing renders them)?
8. Should auto_refresh_seconds be editable in the dashboard edit form? It is honored by the view and set by the seed, but the edit UI exposes no control.

---

## Appendix: seed data reference

scripts/seed-bench.sql seeds 3 dashboards / 10 widgets / 2 scheduled reports for the target org (idempotent, skips if any bench_dashboards already exist):
- Engineering Overview (organization, default, auto_refresh 300s): Open Tasks (kpi, bam:tasks), Tasks by Priority (bar, bam:tasks), Points Completed 30d (counter, bench:daily_task_throughput), Task State Distribution (pie, bam:tasks). The three bam:tasks widgets are silently broken (Section 7 item 1).
- Sales & Pipeline (organization, auto_refresh 600s): Active Deals (kpi, bond:deals), Pipeline Value by Stage (bar, bench:pipeline_snapshot), Deal Funnel (funnel, bench:pipeline_snapshot).
- Marketing Performance (private): Total Emails Sent (counter, blast:campaigns), Campaign Engagement (table, bench:campaign_engagement), Contacts by Lifecycle Stage (donut, bond:contacts).
- Reports: Weekly Engineering Digest (email, cron 0 9 * * 1, America/New_York), Monthly Sales Report (banter_channel leadership, cron 0 8 1 * *).
The Acme cross-app scenario seed (scripts/seed-acme-scenario.mjs) does NOT touch Bench.
