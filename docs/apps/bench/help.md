# Bench - Analytics and dashboards for the BigBlueBam suite

> Bench builds shared analytics dashboards and ad-hoc queries across the other BigBlueBam apps. Reach for it when you want a single place to chart deals, campaigns, goals, and other suite data, then share or schedule those views for your team.

## Overview

Bench is a read-and-visualize layer on top of the rest of the suite. You assemble **dashboards** out of **widgets**, where each widget runs a query against an approved **data source** (a product plus an entity, such as Bond deals or Blast campaigns) and renders the result as a chart, KPI card, or table. You can also explore a source interactively in the **Ad-Hoc Explorer**, save query definitions, and schedule recurring report deliveries.

Bench does not store your business data. It queries other products' tables through a compile-time **data source registry** that whitelists exactly which tables and columns Bench is allowed to read, and always scopes every query to your active organization. Because the registry is an allowlist, you can only chart sources and fields that have been registered.

Bench fits between the operational apps (Bam, Bond, Blast, Beacon, Bearing, and others) and the people who need a roll-up view of them. Operators and leads build dashboards; AI agents read and summarize those dashboards through MCP tools. Most write actions (creating dashboards and widgets) happen in the Bench UI; agents are read-only and analytics-only.

Some sources and presets in this release do not return data. See the per-feature "Known limitations" notes and the consolidated list at the end of the Feature reference before you rely on a given source.

### Key concepts

- **Dashboard** - A named container of widgets with a saved layout. Each dashboard has a **visibility** of Private, Project, or Organization, an optional linked project, and an optional auto-refresh interval. One dashboard per org can be the default.
- **Widget** - One visualization on a dashboard. A widget has a name, a chart type, a data source and entity, and a query configuration. The renderer draws bar, line, area, pie, donut, KPI card, counter, and table widgets distinctly; any other type falls back to a table.
- **Data source** - A registered `(product, entity)` pair that maps to one underlying table with declared measures, dimensions, and filters. Bench can only query registered sources and columns. Every query is automatically scoped to your organization.
- **Measure** - A numeric aggregation in a query: count, sum, avg, min, or max of a field. A query needs at least one measure.
- **Dimension** - A field to group by (for example, deal stage or campaign).
- **Filter** - A condition on a field. Operators include equals, not equals, greater/less than (and -or-equal), in, is null, is not null, between, and like.
- **Saved query** - A reusable query definition (data source, entity, and query config) you can keep and re-run later.
- **Scheduled report** - A cron-driven dashboard snapshot delivered to a target on a schedule. Delivery methods are Email, Banter Channel, and Brief Document; export formats are PDF, PNG, and CSV.
- **Materialized view** - A pre-computed rollup that the worker refreshes automatically. Three are exposed to you as queryable `bench:` data sources: Daily Task Throughput, Pipeline Snapshot, and Campaign Engagement.

### Where to find it

Bench lives at `/bench/`. You must be logged in to BigBlueBam first. If you open Bench while signed out, you will see a "Bench Analytics" screen with the message "Please log in to BigBlueBam first to access Bench." and a "Go to BigBlueBam Login" button that sends you to `/b3/`.

Once you are in, the left sidebar has five destinations: **Dashboards**, **Explorer**, **Reports**, **Saved Queries**, and **Bench Settings**. The header carries the Launchpad app switcher, breadcrumbs, an organization switcher, a notifications bell, and your user menu. Bench reads your active organization from the auth store; use the organization switcher in the header to change which org's data you are charting. Pressing the `?` key anywhere outside a text input opens the in-app Help.

Some write actions require a higher API-key scope. Creating dashboards and widgets needs `read_write`; creating, sending, and deleting scheduled reports needs admin scope plus the matching report permission.

## Feature reference

### Dashboards list

The landing view at `/bench/`. It shows every dashboard you can see as a grid of cards.

Each card shows the dashboard name, an optional description, a visibility pill (Private with a lock icon, Project with a people icon, or Organization with a globe icon), a "N widgets" count, and the relative time it was last updated. A kebab menu on each card offers **View**, **Duplicate**, and **Delete** (Delete is destructive). If you have no dashboards, you see "No dashboards yet" with "Create your first dashboard to start visualizing data."

To create a dashboard:

1. Click **New Dashboard** (the button with the plus icon, top right).
2. Bench creates a dashboard named "Untitled Dashboard" with Private visibility and opens it directly in the edit view.
3. Set its name and add widgets from there (see Dashboard edit).

To open, duplicate, or delete a dashboard:

1. Click a card, or open its kebab menu and choose **View**, to open the dashboard.
2. Choose **Duplicate** to clone the dashboard and all its widgets. The copy is forced to Private visibility.
3. Choose **Delete** to remove it. This cannot be undone.

![Dashboards list](screenshots/light/01-dashboard-list.png)

### Dashboard view

Opens at `/dashboards/:id`. This is the read view of a single dashboard.

The toolbar holds a date-range picker, a **Refresh** button (circular-arrows icon), a fullscreen toggle (the expand icon, no text label), and an **Edit** button. Below the toolbar is the widget grid. Each widget card shows its name, a type pill, the rendered chart, and the query duration in milliseconds. If the dashboard was created with an auto-refresh interval, the view re-runs the widget queries on that interval automatically. A dashboard with no widgets shows "This dashboard has no widgets yet." and an "Add widgets" link into the edit view.

To view and refresh a dashboard:

1. Open a dashboard from the Dashboards list.
2. Read each widget. The number on each card is how long that widget's query took.
3. Click **Refresh** to re-run all widget queries now.
4. Click the fullscreen toggle to present the dashboard on a wall display.
5. Click **Edit** to change the dashboard or its widgets.

**Known limitation:** the date-range picker in this toolbar is currently decorative. It has Presets and Custom Range tabs (presets Today, Last 7 days, Last 30 days, Last 90 days, This month, This quarter, This year, plus a custom From/To with Apply), but the selected range is not passed into the widget queries. Changing the range does not change what the widgets show. To scope a widget by date today, set a date filter or time dimension inside the widget itself (see Widget Edit).

![Dashboard view](screenshots/light/02-dashboard-view.png)

### Dashboard edit

Opens at `/dashboards/:id/edit`. This is where you set a dashboard's metadata and manage its widgets.

The header has a back arrow, the heading "Edit Dashboard", and a **Save** button. The metadata fields are **Name**, **Description**, and a **Visibility** select (Private, Project, or Organization). The Widgets section has two buttons: **Templates** (sparkles icon, toggles the Widget Gallery inline) and **Custom Widget** (plus icon, opens the Widget Wizard). Each existing widget appears as a row with a drag handle, its name, a "data_source / entity - type" subline, an **Edit** link, and a trash delete button.

To edit dashboard metadata:

1. Open a dashboard and click **Edit**, or come straight from creating a new dashboard.
2. Change **Name**, **Description**, and **Visibility** as needed.
3. Click **Save**. Setting a dashboard's visibility to Organization makes it visible org-wide.

To add a widget:

1. Click **Templates** to open the Widget Gallery and pick a preset, or
2. Click **Custom Widget** to open the Widget Wizard and build one step by step.

To edit or remove a widget:

1. Click the **Edit** link on a widget row to open Widget Edit.
2. Click the trash button on a widget row to delete it.

**Known limitations:** the drag handle on each widget row is visual only; reordering by dragging is not wired, so the row order does not change. There is no drag-and-drop canvas in this release despite what some marketing material suggests; widget layout is set when a dashboard is seeded or duplicated, not by dragging in the UI. The edit form also has no control for the auto-refresh interval, even though the view honors one when it is set.

### Widget Gallery

A panel titled "Widget Templates" that appears inline in Dashboard edit when you click **Templates**. It is the fastest way to drop a prebuilt widget onto a dashboard.

The panel has a Close control, a row of category filter pills (All, Project Management, CRM, Email Marketing, Support, Cross-Product), and a grid of preset cards. Each card shows an icon, a type pill, a name, a description, and its category.

To add a preset widget:

1. In Dashboard edit, click **Templates**.
2. Optionally click a category pill to narrow the grid.
3. Click a preset card. The widget is added to the dashboard.

**Known limitations:** several presets reference data sources or fields that are not in the data source registry and will not return data. The four Project Management presets (Sprint Velocity, Tasks by State, Total Open Tasks, Tasks by Priority) and the two Support presets (Open Tickets, Tickets by Priority) sit on the `bam:tasks` and `helpdesk:tickets` sources, which are broken (see Known limitations and broken sources). The Daily Task Throughput preset points at a `mv:` source that does not exist in the registry and fails validation; the working source for that data is `bench:daily_task_throughput`. The CRM and Email Marketing presets (Pipeline Value, Deals by Stage, Pipeline Funnel, Avg Open Rate, Engagement Trend) sit on working `bond:deals` and `blast:campaigns` sources. When in doubt, build the widget with the Widget Wizard instead, which only offers registered sources and fields.

### Widget Wizard

Opens at `/dashboards/:id/widgets/new` (the **Custom Widget** button in Dashboard edit). It builds a widget in four steps. Because it draws its sources and fields from the live registry, every choice it offers is valid.

The header has a back arrow, the heading "New Widget", and a four-step indicator: Data Source, Measures & Dimensions, Chart Type, Name & Style.

To build a widget:

1. **Data Source** - Pick from the list of registered sources. Each entry shows a product pill, a label, and a description.
2. **Measures & Dimensions** - Check the measures you want (each shows its allowed aggregations) and the dimensions to group by (each shows its type).
3. **Chart Type** - Choose from the 11 offered types: Bar Chart, Line Chart, Area Chart, Pie Chart, Donut Chart, KPI Card, Counter, Table, Funnel, Gauge, Progress Bar.
4. **Name & Style** - Type a Widget Name. A summary panel shows the chosen Source, Measures, Dimensions, and Type.
5. Click **Create Widget**. Bench builds the query (using the first allowed aggregation for each measure and your dimensions as the group-by) and returns you to the dashboard edit view with the new widget in place.

Use Cancel or Back in the footer to step backward or leave without creating.

![Widget Wizard](screenshots/light/06-widget-wizard.png)

### Widget Edit

Opens at `/widgets/:id/edit` (the **Edit** link on a widget row). It is a two-column editor with a live preview.

The header has the heading "Edit Widget" and a **Save** button. The left column holds the Widget Name, a Data Source select, a Chart Type grid of the same 11 types, the Measures and Dimensions checkboxes, and Display Options checkboxes for **Show legend** and **Stacked**. The right column is a Preview panel with its own **Refresh** button that renders live query results and reports "Query took N ms - M rows".

To tune a widget:

1. Open a widget's **Edit** link from Dashboard edit.
2. Adjust the Widget Name, Data Source, Chart Type, measures, dimensions, and the Show legend and Stacked options.
3. Click **Refresh** in the Preview panel to see the result and timing.
4. Click **Save**. Bench writes the changes, invalidates the widget cache, and returns you to the dashboard edit view.

### Ad-Hoc Explorer

Opens at `/explorer` (the **Explorer** sidebar item). Use it to run a quick query against any registered source and read the result without saving anything.

The header has the heading "Ad-Hoc Explorer" and the subtitle "Query any data source interactively." The left panel has a Data Source dropdown (each entry shows its product label), read-only Measures and Dimensions lists for the selected source, and a **Run Query** button (play icon). The right panel shows an error banner if a query fails, the generated SQL (in development builds only), a "N rows in X ms" line, and a results table.

To run an ad-hoc query:

1. Open **Explorer** from the sidebar.
2. Choose a Data Source from the dropdown.
3. Click **Run Query**.
4. Read the results table and the row count and timing.

**Known limitations:** the Explorer is not a freeform query builder. Each run uses a fixed shape for the selected source: the first measure with its first aggregation, plus the first two dimensions, limited to 50 rows. There are no measure, dimension, or filter controls. It works for sources whose org scoping is correct (Bond, Blast, Beacon, Bearing, Bureau, and the three `bench:` materialized-view sources) and returns nothing for the broken `bam:tasks` and `helpdesk:tickets` sources.

![Ad-Hoc Explorer](screenshots/light/03-explorer.png)

### Scheduled Reports

Opens at `/reports` (the **Reports** sidebar item). Schedule a dashboard to be snapshotted and delivered on a recurring cron schedule.

The header has the heading "Scheduled Reports", the subtitle "Automated dashboard snapshots delivered on a schedule.", and a **New Report** button. Each report row shows a delivery-method icon (mail, message, or document), the report name, a "cron (timezone) - FORMAT" subline, a last-sent line ("Last sent X" or "Never sent"), an optional delivery-status pill, an Active or Paused pill, a **Send now** play button, and a delete trash button. With no reports you see "No scheduled reports" and "Set up automated dashboard exports delivered via email or Banter."

To create a scheduled report:

1. Click **New Report** to open the "New Scheduled Report" dialog.
2. Enter a **Report Name**.
3. Choose a **Dashboard** to snapshot.
4. Choose a **Schedule** preset (Every day at 9 AM, Every Monday at 9 AM, First of every month at 9 AM, Every Friday at 5 PM, or Custom). For Custom, type a cron expression in the custom cron input. The detected timezone is shown below.
5. Choose a **Delivery Method** (Email, Banter Channel, or Brief Document). The target field's label switches to Email Address, Channel, or Document to match.
6. Choose an **Export Format** (PDF, PNG, or CSV).
7. Optionally check **Enable immediately**.
8. Click **Create Report**.

To send or remove a report:

1. Click **Send now** (the play button) on a report row to deliver it immediately.
2. Click the trash button to delete the report. Creating, sending now, and deleting reports each require admin scope.

**Known limitations:** report delivery is a stub in this release. The worker logs that it is simulating delivery and stamps a status, but no PDF, email, Banter post, or Brief document is actually produced. The on-demand dashboard export path is also a stub. Delivery-status labels are inconsistent across the system, so a report the worker finished may show the default gray badge rather than a green one. There is no edit-report UI; once created, a report can only be sent now or deleted from the interface (editing requires the API or an agent).

![Scheduled Reports](screenshots/light/04-reports.png)

### Saved Queries

Opens at `/saved-queries` (the **Saved Queries** sidebar item). Keep reusable query definitions.

The header has the heading "Saved Queries", the subtitle "Reusable query definitions you can run from the ad-hoc explorer.", and a **New Query** button. Each row shows the name, an optional description, a "data_source/entity - Created DATE" subline, a **Run** button, an Edit (pencil) button, and a Delete (trash) button. With none saved you see "No saved queries" and "Create a query to save and re-run later from the explorer."

To create or edit a saved query:

1. Click **New Query** to open the "New Saved Query" dialog, or click the pencil on a row to open "Edit Saved Query".
2. Enter a **Name** and optional **Description**, and choose a **Data Source**.
3. Click **Create** (or **Update**).

**Known limitations:** there is no measure or dimension builder for saved queries in the UI. On create, the query configuration is stored empty; on edit, the existing configuration is preserved but not editable here. The **Run** button is intended to open the query in the Ad-Hoc Explorer, but that handoff is not wired in this release: the Explorer ignores the incoming saved-query reference and runs its own canned shape instead.

![Saved Queries](screenshots/light/06-saved-queries.png)

### Bench Settings

Opens at `/settings` (the **Bench Settings** sidebar item). A read-only reference of how Bench is configured.

The header has the heading "Settings" and the subtitle "Configure Bench data sources and preferences." There are three sections, none of them editable:

- **Data Source Registry** - Every registered source, grouped by product, each showing its label, description, and counts of measures, dimensions, and filters.
- **Cache** - The default cache TTL (60 seconds).
- **Query Execution** - The statement timeout (10,000 ms).

To review the configuration:

1. Open **Bench Settings** from the sidebar.
2. Browse the Data Source Registry to see exactly which sources and how many fields each exposes.
3. Note the cache TTL and statement timeout. These are fixed and cannot be changed from this page.

![Bench Settings](screenshots/light/05-settings.png)

### Materialized views (admin, no dedicated page)

Three rollups are exposed to you as the `bench:daily_task_throughput`, `bench:pipeline_snapshot`, and `bench:campaign_engagement` data sources. The worker refreshes them automatically (roughly every five minutes). There is no page that lists or refreshes them; they surface only as queryable sources you can chart like any other. An administrator or agent can list and manually refresh them through the API.

### Known limitations and broken sources

These are the data-accuracy issues to know before you build:

- **`bam:tasks` and `helpdesk:tickets` return nothing.** Both are registered, so they appear in the Widget Wizard, the Explorer, and the gallery, but their underlying `tasks` and `tickets` tables have no organization column. Every query against them fails at the database and returns no data. Do not build widgets on these two sources. This affects the seeded Engineering Overview dashboard, whose task widgets (Open Tasks, Tasks by Priority, Task State Distribution) silently show no data, and the Project Management and Support gallery presets.
- **Some Widget Gallery presets reference non-existent sources or fields** (a `mv:` source that is not registered, and field names like points, sprint_name, state_name, and total_tasks that are not in the registry). Those presets fail validation or fail at query time. Prefer the Widget Wizard, which only offers valid choices.
- **The Dashboard view date-range picker is inert.** It does not reach the widget queries.
- **There is no drag-and-drop dashboard canvas.** Widget order and layout are not editable by dragging.
- **Report delivery is a logging stub.** No file or message is actually delivered.
- **The Bureau Floor Analytics source is a nightly rollup, not live.** A one-day window is usually empty mid-day; use a wider range such as Last 7 days when charting it.

### Working with AI agents

Bench exposes 11 MCP tools, and all of them are read-only and analytics-only. Agents can read your dashboards, run widget and ad-hoc queries, list sources, trigger an existing report, and run anomaly and period-comparison analyses. They cannot create, edit, or delete dashboards, widgets, or reports through MCP, and none of the Bench tools are destructive or confirmation-gated, so there is nothing to approve when an agent reads Bench.

- **bench_list_dashboards** - List dashboards, optionally filtered by project or visibility (mirrors the Dashboards list).
- **bench_get_dashboard** - Fetch one dashboard with its widgets and layout (mirrors Dashboard view).
- **bench_list_widgets** - List widgets org-wide or for one dashboard.
- **bench_query_widget** - Run a single widget's query and return rows, SQL, and duration (the same query the widget render and preview use).
- **bench_query_ad_hoc** - Run a structured query (measures, dimensions, filters, limit) against any registered source. This is the agent equivalent of the Ad-Hoc Explorer, and unlike the UI it accepts a full query shape.
- **bench_summarize_dashboard** - Fetch a dashboard and run every widget query, bundling the results for an AI summary. This is the canonical "read this dashboard for me" entry point. Widgets on broken sources come back as a per-widget error rather than failing the whole call, so a summary can still note which widgets returned no data.
- **bench_detect_anomalies** - Compare the most recent period to the previous one and flag changes over 30 percent, with high, medium, or low severity. There is no UI for this; it is agent-only.
- **bench_compare_periods** - Compare two arbitrary date ranges and return both values, the percent change, and the direction. There is no UI for this; it is agent-only.
- **bench_generate_report** - Trigger an immediate delivery of an existing scheduled report (the same action as the Send now button). Delivery itself is still a stub.
- **bench_list_scheduled_reports** - List reports with fuzzy name search.
- **bench_list_data_sources** - List sources and their schemas for discovery (the same registry shown in Settings and the wizard).

A note on the analytics tools: bench_detect_anomalies and bench_compare_periods both filter on a created_at column, so they only work for sources whose base table has both created_at and a correct organization column. They do not work for the Bureau source (it has no created_at), the broken `bam:tasks` and `helpdesk:tickets` sources, or the three materialized-view sources. For the full catalog and schemas, see docs/apps/bench/mcp-tools.md.

## User Stories

### Story: Open Bench for the first time and find your way around

**Who:** Anyone on the team with a BigBlueBam login.
**Goal:** Sign in to Bench and locate the main areas.
**Before you start:** A BigBlueBam account and membership in at least one organization.

**Steps**

1. Go to `/bench/`. If you are not signed in, you will see "Please log in to BigBlueBam first to access Bench." Click **Go to BigBlueBam Login**, sign in at `/b3/`, then return to `/bench/`.
2. Confirm the organization name in the header is the org whose data you want to chart. Use the organization switcher to change it if needed.
3. In the left sidebar, note the five areas: **Dashboards**, **Explorer**, **Reports**, **Saved Queries**, and **Bench Settings**.
4. Press `?` anywhere outside a text field to open the in-app Help.

**Result:** You are signed in to Bench, pointed at the right organization, and oriented to the sidebar.

### Story: Build a leadership dashboard from scratch

**Who:** An operator or team lead.
**Goal:** Create a new dashboard, name it, and fill it with a few widgets.
**Before you start:** Signed in to Bench with `read_write` scope.

**Steps**

1. On the Dashboards list, click **New Dashboard**. Bench creates "Untitled Dashboard" and opens it in edit.
2. Set the **Name** (for example, "Leadership Overview"), add a **Description**, and choose a **Visibility** of Organization so the team can see it.
3. Click **Save**.
4. Click **Custom Widget** to open the Widget Wizard, then build a widget against a working source such as Bond Deals (see the next story). Repeat for each widget you want.
5. Click the back arrow, then open `/dashboards/:id` to view the finished dashboard.

**Result:** A named, org-visible dashboard with your widgets, ready to share.

**Related:** Use the Widget Wizard story for step 4. An agent can read the finished dashboard with bench_get_dashboard or bench_summarize_dashboard.

### Story: Add a widget with the Wizard

**Who:** A dashboard author.
**Goal:** Add one valid widget to a dashboard.
**Before you start:** A dashboard open in edit, and `read_write` scope.

**Steps**

1. In Dashboard edit, click **Custom Widget**.
2. On **Data Source**, pick a working source such as Bond Deals or Blast Campaigns.
3. On **Measures & Dimensions**, check at least one measure and the dimensions to group by.
4. On **Chart Type**, choose a type (for example, Bar Chart for a grouped count).
5. On **Name & Style**, type a Widget Name and review the summary panel.
6. Click **Create Widget**.

**Result:** The widget is created and you are back in the dashboard edit view with it in the list.

**Related:** Tune it further with Widget Edit. The Wizard only offers registered sources, so it avoids the broken `bam:tasks` and `helpdesk:tickets` sources.

### Story: Drop in a prebuilt widget from the gallery

**Who:** A dashboard author who wants a quick start.
**Goal:** Add a preset widget without building a query.
**Before you start:** A dashboard open in edit, and `read_write` scope.

**Steps**

1. In Dashboard edit, click **Templates** to open the Widget Templates gallery.
2. Optionally click a category pill (All, Project Management, CRM, Email Marketing, Support, Cross-Product) to narrow the grid.
3. Click a preset card to add it.

**Result:** The preset widget is added to the dashboard.

**Related:** Choose CRM or Email Marketing presets, which sit on working sources. Avoid the Project Management, Support, and Daily Task Throughput presets; they reference broken or non-existent sources and return no data. Build those with the Widget Wizard instead.

### Story: Tune a widget and preview it live

**Who:** A dashboard author refining a chart.
**Goal:** Adjust a widget's source, type, and fields and confirm the result before saving.
**Before you start:** A dashboard with at least one widget, open in edit, and `read_write` scope.

**Steps**

1. In Dashboard edit, click the **Edit** link on a widget row.
2. In the left column, adjust the Widget Name, Data Source, Chart Type, measures, dimensions, and the **Show legend** and **Stacked** options.
3. Click **Refresh** in the Preview panel and read the "Query took N ms - M rows" line.
4. Click **Save**.

**Result:** The widget is updated, its cache is cleared, and you return to the dashboard edit view.

### Story: Explore a data source ad-hoc

**Who:** Anyone who wants a quick look at a source.
**Goal:** Run a fast query and read the result without saving anything.
**Before you start:** Signed in to Bench.

**Steps**

1. Open **Explorer** from the sidebar.
2. Choose a working Data Source (Bond, Blast, Beacon, Bearing, Bureau, or a `bench:` rollup) from the dropdown.
3. Review the read-only Measures and Dimensions lists.
4. Click **Run Query**.
5. Read the results table and the "N rows in X ms" line.

**Result:** You see one canned slice of the source: the first measure, the first two dimensions, up to 50 rows.

**Related:** For a custom measure, dimension, or filter set, an agent can run bench_query_ad_hoc, which accepts a full query shape the UI does not expose.

### Story: Save a query for later

**Who:** Anyone who repeats the same query.
**Goal:** Keep a query definition you can find again.
**Before you start:** Signed in to Bench.

**Steps**

1. Open **Saved Queries** from the sidebar and click **New Query**.
2. Enter a **Name** and optional **Description**, and choose a **Data Source**.
3. Click **Create**.

**Result:** The saved query appears in the list with its source and created date.

**Related:** The **Run** button is meant to open the query in the Explorer but is not wired in this release, and there is no measure or dimension builder for saved queries in the UI yet.

### Story: Schedule a recurring report

**Who:** An admin who wants a dashboard pushed out on a schedule.
**Goal:** Create a scheduled report and trigger it once.
**Before you start:** Admin scope and the report-create permission, plus a dashboard to snapshot.

**Steps**

1. Open **Reports** from the sidebar and click **New Report**.
2. Enter a **Report Name** and choose the **Dashboard** to snapshot.
3. Choose a **Schedule** preset, or pick Custom and type a cron expression. Confirm the detected timezone.
4. Choose a **Delivery Method** (Email, Banter Channel, or Brief Document) and fill the target field.
5. Choose an **Export Format** (PDF, PNG, or CSV), optionally check **Enable immediately**, and click **Create Report**.
6. To run it now, click **Send now** on the report row.

**Result:** The report appears in the list with its schedule and status pills.

**Related:** Delivery is a stub today, so no file or message is actually produced; the status pills reflect the worker stamping a status, not a real send. An agent can trigger an existing report with bench_generate_report.

### Story: Duplicate a dashboard as a starting template

**Who:** A dashboard author who wants a variant.
**Goal:** Clone an existing dashboard and edit the copy.
**Before you start:** An existing dashboard and `read_write` scope.

**Steps**

1. On the Dashboards list, open the kebab menu on the dashboard's card.
2. Click **Duplicate**. Bench clones the dashboard and all its widgets, and forces the copy to Private visibility.
3. Open the copy and click **Edit** to rename it and adjust its widgets.

**Result:** A private copy of the dashboard you can reshape without touching the original.

### Story: Run a dashboard on a wall display

**Who:** A team that wants a live board in the room.
**Goal:** Present a dashboard fullscreen with auto-refresh.
**Before you start:** A dashboard that has an auto-refresh interval set (set today through the API or seed data; the edit form has no control for it).

**Steps**

1. Open the dashboard at `/dashboards/:id`.
2. Click the fullscreen toggle in the toolbar.
3. Leave it open. If the dashboard has an auto-refresh interval, the widgets re-run on that interval; otherwise click **Refresh** when you want fresh numbers.

**Result:** The dashboard fills the screen and refreshes on its interval.

### Story: Have an agent summarize a dashboard and flag anomalies

**Who:** An operator working with an AI agent.
**Goal:** Get a written read-out of a dashboard and a check for unusual swings.
**Before you start:** An agent connected to the MCP server with your bearer token, and a dashboard to read.

**Steps**

1. Have the agent call **bench_list_dashboards** to find the dashboard, then **bench_get_dashboard** or **bench_summarize_dashboard** to read it. bench_summarize_dashboard runs every widget query and bundles the results, noting any widget that returned an error.
2. For trend checks, have the agent call **bench_detect_anomalies** (recent vs previous period, flags changes over 30 percent) or **bench_compare_periods** (two explicit date ranges).
3. Review the agent's summary. Widgets on broken sources will be reported as returning no data rather than silently dropped.

**Result:** A narrative summary plus any flagged anomalies, all from read-only tools that need no approval.

**Related:** The anomaly and comparison tools only work on sources with a created_at column and correct org scoping, so they do not apply to Bureau, the broken task and ticket sources, or the materialized-view sources.

## Related

- **Bond, Blast, Beacon, Bearing** - The working operational sources Bench charts. Build your business records there; visualize them here.
- **Banter and Brief** - Targets for scheduled report delivery (Banter Channel and Brief Document), once delivery is no longer a stub.
- **Bam and Helpdesk** - Registered as Bench sources but currently broken for org scoping; do not build widgets on them yet.
- **MCP tools reference:** docs/apps/bench/mcp-tools.md
- **Product guide:** docs/apps/bench/guide.md
