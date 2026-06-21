# Bench - Analytics

Bench is the analytics layer for the BigBlueBam suite. It turns the data your team already creates in the other apps - deals in Bond, campaigns in Blast, goals in Bearing, knowledge-base activity in Beacon, and more - into shared dashboards, ad-hoc queries, saved query definitions, and scheduled reports. Bench stores none of that data itself: it queries the other products' tables through a curated, compile-time registry that allowlists exactly which tables and columns it may read, and it scopes every query to your active organization.

You build a dashboard out of widgets. Each widget binds a registered data source (a product plus an entity) to a query (measures to aggregate, dimensions to group by, filters) and a visualization (bar, line, area, pie, donut, KPI card, counter, table, and more). Dashboards can be Private, Project-scoped, or Organization-wide, can carry an auto-refresh interval for wall-board displays, and can be duplicated as starting templates. When you want a quick answer rather than a saved view, the Ad-Hoc Explorer runs a query against any source on demand.

Bench is built to be driven by people and by AI agents on equal footing. Operators and leads work in the UI; agents do the same work through MCP tools - listing and querying sources, building dashboards and widgets, managing saved queries and scheduled reports, summarizing a whole dashboard in one call, and running anomaly and period-comparison checks that have no UI equivalent.

## Key Features

- **Dashboards and widgets** - Named, shareable dashboards assembled from chart, KPI, counter, and table widgets, each backed by a registered data source. Visibility is Private, Project, or Organization, with an optional default and an optional auto-refresh.
- **A curated cross-app data source registry** - An allowlist of `(product, entity)` sources with declared measures, dimensions, and filters. Working sources include Bam tasks, Bond deals and contacts, Blast campaigns, Beacon articles, Bearing goals, Bureau floor analytics, and the Pipeline Snapshot and Campaign Engagement materialized views. Every query is automatically org-scoped.
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

## Working together

Your location in Bench shows in the Bureau virtual office, so teammates can find you; the suite's live-collaboration surfaces are covered in the Introduction.
