---
title: "Bench (Analytics) Guide"
app: bench
generated: "2026-06-17T20:37:35.152Z"
---

# Bench (Analytics) Guide


# Bench - Analytics

Bench is the analytics layer for the BigBlueBam suite. It turns the data your team already creates in the other apps - deals in Bond, campaigns in Blast, goals in Bearing, knowledge-base activity in Beacon, and more - into shared dashboards, ad-hoc queries, saved query definitions, and scheduled reports. Bench stores none of that data itself: it queries the other products' tables through a curated, compile-time registry that allowlists exactly which tables and columns it may read, and it scopes every query to your active organization.

You build a dashboard out of widgets. Each widget binds a registered data source (a product plus an entity) to a query (measures to aggregate, dimensions to group by, filters) and a visualization (bar, line, area, pie, donut, KPI card, counter, table, and more). Dashboards can be Private, Project-scoped, or Organization-wide, can carry an auto-refresh interval for wall-board displays, and can be duplicated as starting templates. When you want a quick answer rather than a saved view, the Ad-Hoc Explorer runs a query against any source on demand.

Bench is built to be driven by people and by AI agents on equal footing. Operators and leads work in the UI; agents do the same work through MCP tools - listing and querying sources, building dashboards and widgets, managing saved queries and scheduled reports, summarizing a whole dashboard in one call, and running anomaly and period-comparison checks that have no UI equivalent.

## Key Features

- **Dashboards and widgets** - Named, shareable dashboards assembled from chart, KPI, counter, and table widgets, each backed by a registered data source. Visibility is Private, Project, or Organization, with an optional default and an optional auto-refresh.
- **A curated cross-app data source registry** - An allowlist of `(product, entity)` sources with declared measures, dimensions, and filters. Working sources include Bond deals and contacts, Blast campaigns, Beacon articles, Bearing goals, Bureau floor analytics, and three pre-computed materialized views (Daily Task Throughput, Pipeline Snapshot, Campaign Engagement). Every query is automatically org-scoped.
- **Widget Wizard and Templates** - A four-step wizard (Data Source, Measures and Dimensions, Chart Type, Name and Style) for custom widgets, plus a gallery of prebuilt presets grouped by category.
- **Live widget editing** - A two-column widget editor with a live preview that re-runs the query and reports row count and timing as you change the source, type, fields, or display options.
- **Ad-Hoc Explorer** - Pick a source, review its measures and dimensions, and run a query to get a results table with timing.
- **Saved queries** - Reusable query definitions you can keep and re-run.
- **Scheduled reports** - Cron-driven dashboard snapshots targeted at Email, a Banter Channel, or a Brief Document, in PDF, PNG, or CSV. (Delivery is a stub in this release: status is stamped, but no artifact is sent yet.)
- **Materialized views** - Pre-computed rollups the worker refreshes on a schedule, surfaced as queryable `bench` data sources.

## Integrations

Bench reads from the operational apps and hands off to the collaboration and automation apps:

- **Bam, Bond, Blast, Beacon, Bearing, Bureau, Helpdesk** - the data sources Bench charts (read-only; Bench never writes to them).
- **Banter** and **Brief** - delivery targets for scheduled reports.
- **Bolt** - Bench publishes the `report.delivered` event (source `bench`) for automations and outbound agent webhooks.
- **MCP / AI agents** - the Bench tool catalog (in `apps/mcp-server/src/tools/bench-tools.ts`) lets agents discover sources, run ad-hoc queries, build and maintain dashboards and widgets, manage saved queries and reports, summarize dashboards, and detect anomalies. Bench also plugs into the cross-cutting agentic platform: agent identity and heartbeat, the unified activity log, human approval queues (proposals), per-agent kill switches and tool allowlists, outbound webhooks, and the `can_access` visibility check agents run before resharing results.

## Getting Started

1. Log in to BigBlueBam, then open Bench at `/bench/`. (Opening Bench while signed out shows a prompt to log in to BigBlueBam first.)
2. From the **Dashboards** list, click **New Dashboard**; Bench opens it in the edit view.
3. Set the name and visibility, then click **Templates** for a prebuilt widget or **Custom Widget** to build one with the wizard. Choose a source that returns data, such as Bond Deals, Blast Campaigns, or a `bench` materialized view.
4. Return to the read view to see the charts, or open **Explorer** to run a one-off query.
5. When a view is worth repeating, save its definition in **Saved Queries** or set up a **Scheduled Report** to deliver a snapshot on a cadence.

## Walkthrough

### Dashboard List

![Dashboard List](screenshots/light/01-dashboard-list.png)

### Dashboard View

![Dashboard View](screenshots/light/02-dashboard-view.png)

### Explorer

![Explorer](screenshots/light/03-explorer.png)

### Widget Wizard

![Widget Wizard](screenshots/light/04-widget-wizard.png)

### Reports

![Reports](screenshots/light/05-reports.png)

### Settings

![Settings](screenshots/light/06-settings.png)


## MCP Tools


# bench MCP Tools


| Tool | Description | Parameters |
|------|-------------|------------|
| `bench_add_widget` | Add a widget to a dashboard. The widget binds a data source + entity to a query config and a visualization type. Use bench_list_data_sources to discover valid data_source/entity and field names. | `dashboard_id`, `widget_type`, `data_source`, `entity`, `query_config`, `viz_config`, `kpi_config`, `cache_ttl_seconds` |
| `bench_compare_periods` | Compare metrics between two time periods. Returns values for both periods and the percentage change. | `data_source`, `entity`, `measure_field`, `measure_agg`, `period1_start`, `period1_end`, `period2_start`, `period2_end` |
| `bench_create_dashboard` | Create a new analytics dashboard. Widgets are added separately via bench_add_widget. | `project_id`, `visibility`, `is_default`, `auto_refresh_seconds`, `layout` |
| `bench_create_saved_query` | Save a reusable ad-hoc query. The query_config follows the same shape as bench_query_ad_hoc (measures, dimensions, filters). | `data_source`, `entity`, `query_config` |
| `bench_create_scheduled_report` | Create a scheduled report that periodically renders a dashboard and delivers it. delivery_target is an email address, Banter channel ID, or Brief document target depending on delivery_method. | `dashboard_id`, `cron_expression`, `cron_timezone`, `delivery_method`, `delivery_target`, `export_format`, `enabled` |
| `bench_delete_dashboard` | Delete a dashboard and its widgets. This is permanent. | `id` |
| `bench_delete_saved_query` | Delete a saved query. This is permanent. | `id` |
| `bench_delete_scheduled_report` | Delete a scheduled report. This stops future deliveries and is permanent. | `id` |
| `bench_delete_widget` | Delete a widget from its dashboard. This is permanent. | `id` |
| `bench_detect_anomalies` | Scan recent metrics for anomalies. Queries the specified data source and compares the most recent period against the previous period to detect significant deviations. | `data_source`, `entity`, `measure_field`, `measure_agg`, `days` |
| `bench_duplicate_dashboard` | Clone a dashboard, including its widgets, into a new copy owned by the caller. | `id` |
| `bench_export_dashboard` | Queue a dashboard export render (PDF). Returns the queued job descriptor; the rendered artifact is delivered out of band. | `id` |
| `bench_generate_report` | Trigger immediate generation and delivery of a scheduled report. | `report_id` |
| `bench_get_dashboard` | Get a dashboard with all its widget configurations and layout. | `id` |
| `bench_get_data_source` | Get the detailed schema for one data source entity — its available measures, dimensions, and filterable fields. Use this after bench_list_data_sources to learn valid field names for a query. | `product`, `entity` |
| `bench_get_saved_query` | Get a single saved query by ID, including its full query config. | `id` |
| `bench_get_widget` | Get a single widget configuration by ID (data source, entity, query config, visualization). | `id` |
| `bench_list_dashboards` | List available analytics dashboards for the current organization. Supports filtering by project and visibility. | `project_id`, `visibility` |
| `bench_list_data_sources` | List all available data sources and their schemas (measures, dimensions, filters). Use this to discover what data can be queried through Bench. | none |
| `bench_list_materialized_views` | List the Bench materialized views and their refresh state (last refreshed, row count, schedule). | none |
| `bench_list_saved_queries` | List saved ad-hoc queries for the organization. Saved queries pair a data source + entity with a reusable query config. | none |
| `bench_list_scheduled_reports` | List scheduled reports for the organization, with optional fuzzy search on name. Returns id, name, dashboard_id, dashboard_name, schedule (cron expression + timezone + enabled), recipients (delivery method/target/format), last_run_at, and next_run_at. | `search` |
| `bench_list_widgets` | List widgets across the organization, optionally scoped to a single dashboard. Widgets are normally only reachable by nesting inside bench_get_dashboard; this gives them direct addressability for resolver flows. Returns id, name, type, dashboard_id, dashboard_name, position, and query. | `dashboard_id` |
| `bench_query_ad_hoc` | Run a structured query against any registered data source. Returns rows, SQL, and duration. Use bench_list_data_sources to discover available sources and their schemas. | `data_source`, `entity`, `measures`, `field`, `agg`, `alias`, `dimensions`, `field`, `alias`, `filters`, `field`, `op`, `value`, `limit` |
| `bench_query_widget` | Execute a widget query and return the data results. Returns rows, the generated SQL, and execution time. | `widget_id` |
| `bench_refresh_materialized_view` | Manually trigger a REFRESH of a Bench materialized view. This can be expensive; use bench_list_materialized_views to find valid view names. | `view_name` |
| `bench_refresh_widget` | Force cache invalidation and re-execute a widget query, bypassing any cached result. Use bench_query_widget for a normal (cacheable) read. | `id` |
| `bench_summarize_dashboard` | Get all widget data from a dashboard for AI summarization. Returns the dashboard metadata and query results for each widget. | `dashboard_id` |
| `bench_update_dashboard` | Update dashboard metadata (name, description, visibility, layout). Provide only the fields to change. | `id`, `project_id`, `visibility`, `is_default`, `auto_refresh_seconds`, `layout` |
| `bench_update_saved_query` | Update a saved query. Provide only the fields to change; query_config replaces the existing config wholesale. | `id`, `data_source`, `entity`, `query_config` |
| `bench_update_scheduled_report` | Update a scheduled report (schedule, delivery, or enabled state). Provide only the fields to change. | `id`, `cron_expression`, `cron_timezone`, `delivery_method`, `delivery_target`, `export_format`, `enabled` |
| `bench_update_widget` | Update a widget configuration. Provide only the fields to change. Changing query_config replaces it wholesale. | `id`, `widget_type`, `data_source`, `entity`, `query_config`, `viz_config`, `kpi_config`, `cache_ttl_seconds` |

## Related Apps

- [Bearing (Goals & OKRs)](../bearing/guide.md)
- [Bolt (Workflow Automation)](../bolt/guide.md)
- [Bond (CRM)](../bond/guide.md)
- [Bureau](../bureau/guide.md)
