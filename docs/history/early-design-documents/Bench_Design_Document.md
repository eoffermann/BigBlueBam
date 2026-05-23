# Bench — Dashboards & Analytics for BigBlueBam

## Software Design Specification

**Version:** 1.0
**Date:** April 8, 2026
**Product:** Bench (Dashboards & Analytics)
**Suite:** BigBlueBam
**Author:** Eddie Offermann / Big Blue Ceiling Prototyping & Fabrication, LLC

---

## 1. Overview

### 1.1 Product Vision

Bench is the cross-product analytics and dashboard platform for the BigBlueBam suite. Every B-product has its own local analytics views (Bam has sprint velocity, Bond has pipeline conversion, Blast has open rates), but none of them can answer questions that span products: "How does our marketing campaign performance correlate with deal pipeline velocity?" or "Which projects are consuming the most engineering time relative to their OKR impact?"

Bench provides a unified data layer that aggregates metrics from across the suite and exposes them through configurable, shareable dashboards with drag-and-drop widget composition.

Bench is **the executive view of BigBlueBam.** While individual products serve the practitioner (the developer, the salesperson, the marketer), Bench serves the leader who needs a cross-functional, real-time picture of how the organization is performing.

### 1.2 Core Principles

1. **Read-only aggregation.** Bench never writes to other products' data. It reads from the shared PostgreSQL database and presents computed views. No ETL pipelines, no data warehouses, no separate data stores at launch.
2. **Widget-based composition.** Dashboards are built from widgets (charts, tables, KPIs, counters). Users drag widgets onto a grid layout, configure their data source and visualization, and share the dashboard with their team.
3. **Suite-wide data sources.** Every B-product registers its queryable metrics with Bench. A single dashboard can combine a Bam velocity chart, a Bond pipeline funnel, a Blast engagement trend, and a Bearing goal progress bar.
4. **AI-powered insights.** MCP tools allow agents to query Bench data, generate natural-language summaries of dashboard state, spot anomalies, and produce periodic reports posted to Banter or saved as Brief documents.
5. **No SQL required.** Widget configuration is visual. Users select a data source, choose dimensions and measures, pick a chart type, and apply filters. Power users can drop to a structured query builder, but never raw SQL.

### 1.3 Non-Goals

- Bench is **not** a data warehouse. It queries the live operational database. For organizations that need historical analytics at scale, a future data export pipeline to an external warehouse is planned but out of scope.
- Bench does **not** replace product-specific analytics views. Bam's sprint burndown, Bond's pipeline board totals, and Blast's per-campaign analytics remain in-product. Bench adds the cross-product layer.
- Bench does **not** include embedded BI for external customers. Dashboards are internal-only, scoped to organization members.
- Bench does **not** support custom SQL at launch. All queries are built through the structured query builder.

---

## 2. Architecture

### 2.1 Monorepo Placement

```
apps/
  bench-api/          → Fastify REST API (dashboard CRUD, widget configuration, query execution, scheduled reports)
  bench/              → React SPA (dashboard canvas, widget gallery, query builder)
```

### 2.2 Infrastructure

| Component | Role |
|-----------|------|
| **bench-api** (Fastify :4009) | REST API for dashboards, widgets, query execution, scheduled exports |
| **PostgreSQL 16** | Dashboard definitions stored in shared DB (`bench_` prefix). Query execution runs read-only against all `bam_`, `bond_`, `blast_`, `beacon_`, etc. tables |
| **Redis 7** | Query result caching (TTL-based), dashboard real-time refresh |
| **BullMQ Worker** | Scheduled report generation, heavy query execution in background |
| **MCP Server** | Dashboard query and insight tools for AI agents |

### 2.3 Query Execution Model

Bench queries the live operational PostgreSQL database. To protect performance:

1. **Read replicas recommended.** For production deployments, Bench-api connects to a read replica. The `DATABASE_READ_URL` env var overrides `DATABASE_URL` for query execution. Dashboard/widget CRUD still uses the primary.
2. **Query timeout.** All Bench queries have a configurable statement timeout (default 10 seconds). Long-running queries are killed and the user is prompted to narrow their filters.
3. **Result caching.** Query results are cached in Redis with a configurable TTL (default 60 seconds). Dashboard refresh pulls from cache unless the user explicitly requests a fresh query.
4. **Materialized views.** For expensive cross-product aggregations (e.g., "monthly active tasks across all projects"), Bench defines PostgreSQL materialized views refreshed on a schedule by the BullMQ worker.

### 2.4 Data Source Registry

Each B-product registers its available metrics with Bench via a static registry (no runtime discovery). The registry defines:

```typescript
interface BenchDataSource {
  product: string;              // 'bam', 'bond', 'blast', 'beacon', etc.
  entity: string;               // 'tasks', 'deals', 'campaigns', 'contacts', etc.
  measures: MeasureDefinition[];  // count, sum, avg, min, max over numeric columns
  dimensions: DimensionDefinition[];  // categorical/temporal columns for grouping
  filters: FilterDefinition[];  // available filter fields with operators
  baseTable: string;            // PostgreSQL table name
  joins?: JoinDefinition[];     // allowed joins to related tables
}
```

The registry is compiled at build time from each product's data source manifest. This ensures Bench can only query approved tables/columns and cannot accidentally expose sensitive data.

### 2.5 nginx Routing

```nginx
location /bench/ {
    alias /usr/share/nginx/html/bench/;
    try_files $uri $uri/ /bench/index.html;
}

location /bench/api/ {
    proxy_pass http://bench-api:4009/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### 2.6 Docker Service

```yaml
bench-api:
  build:
    context: .
    dockerfile: apps/bench-api/Dockerfile
  environment:
    - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/bigbluebam
    - DATABASE_READ_URL=${DATABASE_READ_URL:-}   # optional read replica
    - REDIS_URL=redis://redis:6379
    - MCP_INTERNAL_URL=http://mcp-server:3001
    - SESSION_SECRET=${SESSION_SECRET}
    - QUERY_TIMEOUT_MS=${BENCH_QUERY_TIMEOUT_MS:-10000}
    - CACHE_TTL_SECONDS=${BENCH_CACHE_TTL:-60}
  ports:
    - "4009:4009"
  depends_on:
    - postgres
    - redis
    - mcp-server
```

---

## 3. Data Model

### 3.1 PostgreSQL Schema

```sql
-- ============================================================
-- BENCH: Dashboards & Analytics
-- ============================================================

-- Dashboards
CREATE TABLE bench_dashboards (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id          UUID REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-wide
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    -- Layout configuration (grid positions for all widgets)
    layout              JSONB NOT NULL DEFAULT '[]',
    -- e.g., [
    --   {"widget_id": "uuid", "x": 0, "y": 0, "w": 6, "h": 4},
    --   {"widget_id": "uuid", "x": 6, "y": 0, "w": 6, "h": 4}
    -- ]
    -- Sharing
    visibility          VARCHAR(20) NOT NULL DEFAULT 'private'
                        CHECK (visibility IN ('private', 'project', 'organization')),
    is_default          BOOLEAN NOT NULL DEFAULT false,  -- shown on org/project home
    -- Auto-refresh
    auto_refresh_seconds INTEGER,                        -- NULL = manual refresh only
    -- Metadata
    created_by          UUID NOT NULL REFERENCES users(id),
    updated_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bench_dash_org ON bench_dashboards(organization_id);
CREATE INDEX idx_bench_dash_project ON bench_dashboards(project_id);
CREATE INDEX idx_bench_dash_visibility ON bench_dashboards(organization_id, visibility);

-- Widgets: individual chart/table/KPI components
CREATE TABLE bench_widgets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id        UUID NOT NULL REFERENCES bench_dashboards(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    -- Visualization type
    widget_type         VARCHAR(30) NOT NULL
                        CHECK (widget_type IN (
                            'bar_chart', 'line_chart', 'area_chart', 'pie_chart', 'donut_chart',
                            'scatter_plot', 'heatmap', 'funnel',
                            'table', 'pivot_table',
                            'kpi_card', 'counter', 'gauge', 'progress_bar',
                            'text', 'markdown'
                        )),
    -- Data query definition
    data_source         VARCHAR(30) NOT NULL,     -- product name: 'bam', 'bond', 'blast', etc.
    entity              VARCHAR(60) NOT NULL,     -- entity name from registry: 'tasks', 'deals', etc.
    query_config        JSONB NOT NULL,
    -- e.g., {
    --   "measures": [{"field": "id", "agg": "count", "alias": "task_count"}],
    --   "dimensions": [{"field": "priority", "alias": "priority"}],
    --   "filters": [{"field": "closed_at", "op": "is_null", "value": true}],
    --   "sort": [{"field": "task_count", "dir": "desc"}],
    --   "limit": 10,
    --   "time_dimension": {"field": "created_at", "granularity": "week"},
    --   "date_range": {"preset": "last_30_days"}
    -- }
    -- Visualization configuration
    viz_config          JSONB DEFAULT '{}',
    -- e.g., {
    --   "colors": ["#3b82f6", "#ef4444", "#10b981"],
    --   "show_legend": true,
    --   "x_axis_label": "Priority",
    --   "y_axis_label": "Count",
    --   "stacked": false
    -- }
    -- KPI-specific (for kpi_card, counter, gauge)
    kpi_config          JSONB,
    -- e.g., {
    --   "comparison": "previous_period",   -- compare to previous period
    --   "format": "currency",              -- number, percentage, currency, duration
    --   "thresholds": {"green": 80, "yellow": 50, "red": 0},
    --   "suffix": "deals",
    --   "prefix": "$"
    -- }
    -- Cache override (NULL = use dashboard default)
    cache_ttl_seconds   INTEGER,
    -- Metadata
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bench_widgets_dashboard ON bench_widgets(dashboard_id);

-- Scheduled reports: periodic dashboard snapshots emailed or posted to Banter
CREATE TABLE bench_scheduled_reports (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id        UUID NOT NULL REFERENCES bench_dashboards(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    -- Schedule
    cron_expression     VARCHAR(100) NOT NULL,
    cron_timezone       VARCHAR(50) DEFAULT 'UTC',
    -- Delivery
    delivery_method     VARCHAR(20) NOT NULL
                        CHECK (delivery_method IN ('email', 'banter_channel', 'brief_document')),
    delivery_target     TEXT NOT NULL,           -- email addresses (comma-sep), channel_id, or brief folder_id
    -- Format
    export_format       VARCHAR(10) NOT NULL DEFAULT 'pdf'
                        CHECK (export_format IN ('pdf', 'png', 'csv')),
    -- Status
    enabled             BOOLEAN NOT NULL DEFAULT true,
    last_sent_at        TIMESTAMPTZ,
    -- Metadata
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bench_reports_org ON bench_scheduled_reports(organization_id);
CREATE INDEX idx_bench_reports_enabled ON bench_scheduled_reports(enabled) WHERE enabled = true;

-- Materialized view refresh tracking
CREATE TABLE bench_materialized_views (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    view_name           VARCHAR(100) NOT NULL UNIQUE,
    description         TEXT,
    refresh_cron        VARCHAR(100) NOT NULL DEFAULT '*/5 * * * *',  -- every 5 min by default
    last_refreshed_at   TIMESTAMPTZ,
    refresh_duration_ms INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.2 Pre-Built Materialized Views

Bench creates the following materialized views for cross-product aggregations:

```sql
-- Daily task throughput by project (Bam)
CREATE MATERIALIZED VIEW bench_mv_daily_task_throughput AS
SELECT
    t.project_id,
    date_trunc('day', t.updated_at) AS day,
    COUNT(*) FILTER (WHERE t.state = 'done') AS completed,
    COUNT(*) FILTER (WHERE t.state != 'done') AS in_progress,
    SUM(t.story_points) FILTER (WHERE t.state = 'done') AS points_completed
FROM tasks t
GROUP BY t.project_id, date_trunc('day', t.updated_at);

-- Pipeline value snapshot (Bond)
CREATE MATERIALIZED VIEW bench_mv_pipeline_snapshot AS
SELECT
    d.organization_id,
    d.pipeline_id,
    ps.name AS stage_name,
    ps.sort_order,
    ps.stage_type,
    COUNT(d.id) AS deal_count,
    COALESCE(SUM(d.value), 0) AS total_value,
    COALESCE(SUM(d.weighted_value), 0) AS weighted_value
FROM bond_deals d
JOIN bond_pipeline_stages ps ON d.stage_id = ps.id
WHERE d.closed_at IS NULL
GROUP BY d.organization_id, d.pipeline_id, ps.id, ps.name, ps.sort_order, ps.stage_type;

-- Campaign engagement rates (Blast)
CREATE MATERIALIZED VIEW bench_mv_campaign_engagement AS
SELECT
    c.organization_id,
    c.id AS campaign_id,
    c.name,
    c.sent_at,
    c.total_sent,
    c.total_opened,
    c.total_clicked,
    CASE WHEN c.total_sent > 0 THEN ROUND(100.0 * c.total_opened / c.total_sent, 1) ELSE 0 END AS open_rate,
    CASE WHEN c.total_sent > 0 THEN ROUND(100.0 * c.total_clicked / c.total_sent, 1) ELSE 0 END AS click_rate
FROM blast_campaigns c
WHERE c.status = 'sent';
```

---

## 4. API Endpoints

### 4.1 Dashboards

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bench/api/dashboards` | List dashboards (filterable by project, visibility) |
| `POST` | `/bench/api/dashboards` | Create a dashboard |
| `GET` | `/bench/api/dashboards/:id` | Get dashboard with all widgets and layout |
| `PATCH` | `/bench/api/dashboards/:id` | Update dashboard metadata or layout |
| `DELETE` | `/bench/api/dashboards/:id` | Delete dashboard |
| `POST` | `/bench/api/dashboards/:id/duplicate` | Clone a dashboard |
| `POST` | `/bench/api/dashboards/:id/export` | Export dashboard as PDF/PNG |

### 4.2 Widgets

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/bench/api/dashboards/:id/widgets` | Add a widget to a dashboard |
| `GET` | `/bench/api/widgets/:id` | Get widget config |
| `PATCH` | `/bench/api/widgets/:id` | Update widget config |
| `DELETE` | `/bench/api/widgets/:id` | Remove a widget |
| `POST` | `/bench/api/widgets/:id/query` | Execute widget query and return data |
| `POST` | `/bench/api/widgets/:id/refresh` | Force cache invalidation + re-query |

### 4.3 Query Builder

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bench/api/data-sources` | List available data sources from the registry |
| `GET` | `/bench/api/data-sources/:product/:entity` | Get available measures, dimensions, filters for an entity |
| `POST` | `/bench/api/query/preview` | Execute an ad-hoc query (for builder preview, not saved) |

### 4.4 Scheduled Reports

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bench/api/reports` | List scheduled reports |
| `POST` | `/bench/api/reports` | Create a scheduled report |
| `PATCH` | `/bench/api/reports/:id` | Update report config |
| `DELETE` | `/bench/api/reports/:id` | Delete report |
| `POST` | `/bench/api/reports/:id/send-now` | Trigger immediate report generation |

---

## 5. MCP Tools

| Tool | Description |
|------|-------------|
| `bench_list_dashboards` | List available dashboards |
| `bench_get_dashboard` | Get dashboard with widget configs |
| `bench_query_widget` | Execute a widget query and return data |
| `bench_query_ad_hoc` | Run a structured query against any registered data source |
| `bench_summarize_dashboard` | AI generates natural-language summary of current dashboard state |
| `bench_detect_anomalies` | Scan recent metrics for deviations from trend |
| `bench_generate_report` | Generate a dashboard export and post to Banter or save as Brief |
| `bench_list_data_sources` | List available data sources and their schema |
| `bench_compare_periods` | Compare metrics between two time periods |

### 5.1 Agent Insight Workflow

1. Weekly scheduled Bolt automation triggers agent
2. Agent calls `bench_summarize_dashboard` for the org's default dashboard
3. Agent calls `bench_detect_anomalies` for the past 7 days
4. Agent generates a Brief document with the weekly summary and any anomaly alerts
5. Agent posts the Brief link to Banter `#leadership` with a one-paragraph summary

---

## 6. Frontend

### 6.1 Routes

| Route | View |
|-------|------|
| `/bench` | Dashboard list (cards with name, description, last updated, shared icon) |
| `/bench/dashboards/:id` | Dashboard canvas (grid of widgets, live data) |
| `/bench/dashboards/:id/edit` | Dashboard editor (drag-and-drop widget placement, resize handles) |
| `/bench/widgets/new` | Widget creation wizard (data source → measures/dimensions → chart type → style) |
| `/bench/widgets/:id/edit` | Widget configuration editor |
| `/bench/reports` | Scheduled reports list |
| `/bench/explorer` | Ad-hoc query explorer (for power users) |

### 6.2 Dashboard Canvas

- **Grid layout:** 12-column responsive grid (similar to Grafana) using `react-grid-layout`
- **Widget rendering:** Each widget fetches its own data on mount and refresh. Charts rendered with Recharts (same library as Bam).
- **Real-time refresh:** Optional auto-refresh at dashboard level (configurable interval)
- **Fullscreen mode:** Hide sidebar/header for presentation on wall displays
- **Date range picker:** Global dashboard-level date range filter applied to all time-aware widgets
- **Export:** PDF export renders all widgets server-side via Puppeteer

### 6.3 Widget Gallery

Pre-built widget templates for common use cases:
- **Bam:** Sprint velocity trend, task distribution by priority, burndown chart, team workload
- **Bond:** Pipeline funnel, deal velocity, forecast, win/loss trend
- **Blast:** Campaign engagement comparison, subscriber growth, unsubscribe trend
- **Bearing:** Goal progress bars, KR completion rates, at-risk objectives
- **Helpdesk:** Ticket volume trend, resolution time, SLA compliance
- **Cross-product:** Engineering throughput vs. OKR progress, marketing spend vs. pipeline growth

---

## 7. Events (Bolt Integration)

| Event | Trigger | Payload |
|-------|---------|---------|
| `bench.report.generated` | Scheduled report completed | `{ report_id, dashboard_id, format, delivery_method }` |
| `bench.anomaly.detected` | Metric anomaly detected during scheduled analysis | `{ metric, data_source, current_value, expected_range, severity }` |

---

## 8. Permissions

| Permission | Admin | Manager | Member | Viewer |
|-----------|-------|---------|--------|--------|
| View shared dashboards | ✓ | ✓ | ✓ | ✓ |
| Create dashboards | ✓ | ✓ | ✓ | ✗ |
| Edit any dashboard | ✓ | ✓ | Own only | ✗ |
| Delete dashboards | ✓ | ✓ | Own only | ✗ |
| Configure scheduled reports | ✓ | ✓ | ✗ | ✗ |
| Access ad-hoc query explorer | ✓ | ✓ | ✓ | ✗ |
| Set org-default dashboard | ✓ | ✗ | ✗ | ✗ |

**Data visibility:** Bench respects the same data access rules as the underlying products. A Member who can only see their own Bond deals will only see their own deal data in Bench widgets. The query execution layer applies the requesting user's permissions as row-level filters.
