# Bench help.md - Review

## Verdict: APPROVED

The doc is accurate, complete against the template, and truthful about every
known-broken behavior. Every UI label, count, and feature claim spot-checked
below traced to code. The four mandated truthfulness items (broken
bam:tasks/helpdesk:tickets sources, inert date picker, no drag-and-drop, stub
report delivery) are each documented honestly in multiple places. No blocking
issues. Two cosmetic accuracy nits are noted for optional polish; they do not
gate approval.

---

## Template completeness

All four required sections present and filled: Overview (what it is, who for, Key
concepts, Where to find it), Feature reference (one subsection per user-facing
view plus Working with AI agents and Known limitations), User Stories (12
stories), Related. Skeleton order matches the skill.

## Feature coverage

Every frontend view has how-to steps: Dashboards list, Dashboard view, Dashboard
edit, Widget Gallery, Widget Wizard, Widget Edit, Ad-Hoc Explorer, Scheduled
Reports, Saved Queries, Bench Settings, and the no-page Materialized views
surface. All ten SPA pages in apps/bench/src/pages/ plus the inline gallery and
the MV surface are covered. No omitted view found when grepping the sidebar nav,
the page router, and the action handlers.

## Story coverage

- Setup: "Open Bench for the first time and find your way around" - covered.
- Core loop: "Build a leadership dashboard", "Add a widget with the Wizard",
  "Drop in a prebuilt widget", "Tune a widget and preview it live" - covered.
- Collaboration: "Duplicate a dashboard as a starting template" plus
  Organization-visibility dashboards - covered; Bench has no deeper multi-user
  collaboration surface to document.
- Search/reporting: "Explore a data source ad-hoc", "Save a query for later",
  "Schedule a recurring report", "Run a dashboard on a wall display" - covered.
- Agent flow: "Have an agent summarize a dashboard and flag anomalies" - covered,
  read-only and no-approval nature stated correctly.
All stories are followable from their steps alone.

## Accuracy findings (label/claim trace to code)

Traced and CONFIRMED in code:
- 11 MCP tools, all 11 names exact (apps/mcp-server/src/tools/bench-tools.ts;
  grep returns exactly 11 name: 'bench_*'). The created_at-filter limitation for
  bench_detect_anomalies / bench_compare_periods (bench-tools.ts:204,215-216,
  384-385), the >30% threshold and high/medium/low severity (bench-tools.ts:
  232-233) all match the doc.
- 11 chart types in Wizard and Widget Edit, exact list and labels
  (widget-wizard.tsx:14-26).
- Renderer renders bar/line/area/pie/donut/kpi_card/counter/table distinctly,
  all else falls to table (chart-renderer.tsx cases 46/49/52/87/124/162/163/203).
- Sidebar labels exact: Dashboards, Explorer, Reports, Saved Queries, Bench
  Settings (bench-sidebar.tsx:19-23).
- Unauthenticated gate strings exact: "Bench Analytics", "Please log in to
  BigBlueBam first to access Bench.", "Go to BigBlueBam Login" (app.tsx:133-136).
- ? key opens in-app Help outside inputs (app.tsx:107).
- Date picker presets exact: Today, Last 7 days, Last 30 days, Last 90 days, This
  month, This quarter, This year (date-range-picker.tsx:16-22).
- Explorer canned shape: first measure, first two dimensions, limit 50
  (explorer.tsx:34,38,41).
- Settings values: Cache TTL 60 seconds, Statement Timeout 10,000 ms
  (settings.tsx:71,85).
- Report dialog labels exact: New Scheduled Report, Report Name, Delivery Method,
  Banter Channel, Brief Document, Email Address/Channel/Document target switch,
  Export Format, Enable immediately, Create Report, Send now (reports.tsx).
- MV refresh roughly every 5 minutes (bench-mv-refresh.job.ts:4,15,40).
- Wizard builds query with first allowed aggregation per measure
  (widget-wizard.tsx:226).
- Empty-state and toolbar strings exact: "This dashboard has no widgets yet.",
  "Add widgets", "Show legend", "Stacked", "Preview", "Refresh", "Edit
  Dashboard", "Templates", "Custom Widget" (dashboard-view.tsx,
  dashboard-edit.tsx, widget-edit.tsx).

Mandated truthfulness checks - all PASS:
1. Broken bam:tasks / helpdesk:tickets: registry leaves orgColumn unset
   (data-source-registry.ts:65-68,163-166) so the builder emits
   organization_id = $org; tasks (init.sql:198) and tickets are scoped by
   project_id only with no organization_id column. Doc documents this in Overview
   (line 13), Widget Gallery (111), Explorer (157), Known limitations (229),
   Settings/agent notes, and Stories. Truthful.
2. Inert date picker: view holds the range but never passes it into the widget
   query; picker emits from/to while the server schema expects start/end. Doc
   says so at lines 71 and 231. Truthful.
3. No drag-and-drop: GripVertical handle is visual only; no reorder is wired. Doc
   says so at lines 97 and 232 and rebuts the marketing "drag-and-drop canvas"
   claim. Truthful.
4. Stub report delivery: worker logs "simulating delivery (stub)"
   (bench-report-deliver.job.ts:96) and only stamps status delivered/failed; the
   export route returns a queued/pdf stub (dashboards.routes.ts:126-141). Doc
   says so at lines 183, 233, 248, and 390. Truthful.

NO label or feature claim failed to trace to code.

## Conventions

- No em dashes or en dashes in help.md (Grep for both returns no matches). Spaced
  hyphens used as separators per the skill.
- Counts code-backed: 11 tools (matches file), 11 chart types (matches), three
  bench: MV sources (matches), eight registered non-bench sources (matches the
  registry table). All counts are fixed, so growing-count phrasing is not needed.
- Referenced screenshots all exist on disk: light and dark 01-dashboard-list,
  02-dashboard-view, 03-explorer, 04-reports, 05-settings, 06-saved-queries, and
  06-widget-wizard - all present in both themes. help.md references
  01..05, 06-widget-wizard.png (line 129), and 06-saved-queries.png (line 201);
  every referenced file exists.

### meta.json / 06-widget-wizard note (informational, not a defect)

06-widget-wizard.png exists in both light/ and dark/ and IS referenced by help.md
(line 129). It is NOT catalogued in meta.json (which stops at the first six ids
per theme). The skill screenshot rule is "reference only screenshots that exist
in docs/apps/<app>/", which is satisfied because the file is on disk. meta.json
is a capture catalog, not the referencing contract, so this is not a help.md
defect and does not gate approval. Flagged so the orchestrator can decide whether
to backfill the meta.json entry, and to note that 06-saved-queries.png and
06-widget-wizard.png share the 06- prefix (a latent generator naming collision,
not a doc bug).

## Optional polish (non-blocking, no fix required for approval)

Cosmetic verbatim-quote mismatches. The quoted words are correct; only the
separator character differs. Neither affects followability or meaning.

1. help.md lines 135 and 334 quote the Widget Edit preview line as "Query took N
   ms - M rows". The UI renders "Query took {n}ms &middot; {m} rows"
   (widget-edit.tsx:301): no space before "ms", and a middot separator rather
   than a hyphen. The doc spaced-hyphen rendering is a deliberate em-dash
   avoidance; acceptable, but if exactness is wanted, note it is a middot.
2. help.md lines 148 and 351 write the Explorer result line as "N rows in X ms".
   The UI renders "{n} rows in {duration}ms" (explorer.tsx:128): no space before
   "ms". Cosmetic.

No changes are required. Both items are stylistic, and the doc already reads as
the same product as sibling help docs.

---

## Number of required fixes: 0
