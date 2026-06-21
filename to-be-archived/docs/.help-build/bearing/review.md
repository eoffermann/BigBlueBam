# Bearing help.md Review

## Verdict: APPROVED

`docs/apps/bearing/help.md` is accurate, complete against the help-doc-authoring
template, and correctly handles every known divergence the orchestrator called
out. Every UI label, dialog string, route claim, MCP-tool reference, and
known-limitation note traced to code. No changes required.

---

## Checklist results

### Template completeness - PASS
All four required sections present and filled, in order: Overview (with Key
concepts and Where to find it), Feature reference (with Working with AI agents),
User Stories, Related. Matches the canonical skeleton in
`.claude/skills/help-doc-authoring/SKILL.md`.

### Feature coverage - PASS
Every user-facing view and action in `apps/bearing/src` has how-to steps:
- Sidebar period scope selector, nav (Dashboard, My Goals, At Risk, Periods) -
  `components/layout/bearing-sidebar.tsx` (labels verbatim, lines 15-18).
- Dashboard, My Goals, At Risk, Periods, Goal Detail pages - all five
  `pages/*.tsx` covered.
- Create Goal, Add/Edit Key Result, Record progress (inline Update), Post Update,
  Watchers - all covered with exact dialog titles/descriptions/buttons.
- The only frontend component not surfaced as a working human feature -
  `components/links/LinkEditor.tsx` and its pickers - is correctly documented as
  agent/REST-only because it is imported by no page or row (grep confirms only a
  comment reference in `EpicPicker.tsx`; `LinkEditor` is never rendered).

### Story coverage - PASS
All required arcs present: setup ("Set up your first quarter"), core loop
(Create objective / Break into key results / Record weekly progress), collaboration
(Post a status update, Watch a goal), search/reporting (Triage at-risk, Close out
the quarter with a report), and agent flows (Set up a quarter with an agent, Wire
key results to real delivery, Run a weekly status sweep). 13 stories total; steps
are followable and name exact UI elements.

### Accuracy - PASS
Spot-checked and confirmed in code:
- Dashboard header/subtitle/button/placeholder/empty-states - `pages/DashboardPage.tsx`.
- Stat-card labels "Total Goals" / "Avg Progress" / "At Risk" / "Achieved" -
  `components/dashboard/ProgressSummary.tsx` lines 43-46.
- Create Goal dialog "Create Goal" / "Set a new objective for this period.",
  scope buttons Organization/Team/Project (Individual omitted), default Team -
  `DashboardPage.tsx` lines 117, 145-147, 154-155.
- KR dialog "Add/Edit Key Result" / "Define a measurable outcome for this goal.",
  metric labels Number/Percentage/Currency/Yes-No, Start Value, Target Value,
  Unit (optional), Save Changes / Add Key Result - `components/goal/KeyResultList.tsx`.
- KR row "Update" inline with Save/Cancel, Enter saves / Escape cancels, "..."
  Edit/Delete - `components/goal/KeyResultRow.tsx` lines 90-124.
- Post Update dialog "Post Status Update" / "Share progress with your team.",
  chips On Track/At Risk/Behind/Achieved, "What's the latest on this goal? Any
  blockers?" - `components/goal/PostUpdateDialog.tsx`.
- Watchers card "Watchers (n)", person-plus add icon, "User ID or email"
  placeholder, "+" add, "X" remove - `components/goal/WatcherList.tsx`.
- Period Form Quarter/Half Year/Year/Custom, "Define a new time period for
  goals." / "Create Period" / "Save Changes" - `PeriodListPage.tsx` lines 17-20,
  212-213, 265.
- Goal Detail "Back to Dashboard", "Delete Goal", "(expected: m%)", "Status
  Updates", "Post Update" - `pages/GoalDetailPage.tsx`.
- Auth gate "Please log in to BigBlueBam first", "?" opens HelpViewer -
  `app.tsx` lines 86, 113, 123.
No label or feature claim failed to trace to code.

### Known-broken paths handled correctly - PASS (the core risk in this task)
The doc does NOT present any broken frontend->backend path as a working step;
each is flagged as a known limitation with the agent/REST workaround:
1. Dashboard stat cards + Goal-detail "Progress Over Time" chart. Both feed from
   `usePeriodReport` -> `GET /periods/:id/report` (`hooks/useProgress.ts` line 75),
   which does not exist (`routes/periods.ts` has no `/report` route; reports live
   under `/reports/period/:periodId`, `routes/reports.ts` line 30). help.md lines
   61 and 124 flag both as known limitations and point to `bearing_period_get` /
   `bearing_report`.
2. KR inline Update. `useSetKrValue` POSTs `/key-results/:id/set-value`
   (`hooks/useKeyResults.ts` line 131); the real route is `/key-results/:id/value`
   (`routes/key-results.ts` line 422). help.md line 166 flags this and routes the
   reliable path through `bearing_kr_update`. Story "Record weekly progress" (line
   297) carries the same caveat.
3. Add-watcher control. help.md lines 188 and 363 correctly state the backend
   ignores the typed value and always subscribes the caller
   (`WatcherList.tsx` sends `{user_id}` but `POST /goals/:id/watchers` adds the
   authenticated caller).
4. Period Activate menu item. Frontend store uses `draft`
   (`stores/period.store.ts` line 9) while the backend default is `planning`; the
   Activate guard checks `status === 'draft'` (`PeriodListPage.tsx` line 119), so
   it will not appear for a freshly created period. help.md line 106 and the
   setup story (line 241) flag this.
5. KR-linking, Reports, and CSV Export documented as agent/REST-only: help.md
   lines 209, 214, and the "Working with AI agents" + agent stories sections all
   correctly state there is no human screen for these in this build.

### Conventions - PASS
- No em dashes and no en dashes (grep clean).
- MCP tool count stated as 12 and code-backed: `apps/mcp-server/src/tools/bearing-tools.ts`
  registers exactly 12 tools (2 periods, 4 goals, 3 key results, 1 update, 2
  reports). The doc lists all 12 by name with correct backing routes. (Note: the
  dossier flags `guide.md`/`mcp-tools.md` as listing only 11; help.md is the
  correct one at 12.)
- Screenshots: help.md references 3 in-text (`screenshots/light/04-at-risk.png`,
  `03-periods.png`, `02-goal-detail.png`) - all exist. `meta.json` registers 4
  ids per theme (01-dashboard, 02-goal-detail, 03-periods, 04-at-risk); all 4
  exist in both `light/` and `dark/`. The extra on-disk files `03-timeline.png`
  and `04-reports.png` are unregistered and unreferenced by help.md, so they
  cause no problem (they correspond to no SPA page, per the dossier).
- Counts plausible and code-backed (5 pages, 4 nav items, 4 scope tabs, 4 metric
  types, 4 period types, 4 worker jobs - all verified).

---

## Accuracy findings (label / claim that did not trace to code)

None. Every label and feature claim traced to a route, component, or MCP tool.

## Minor observations (non-blocking, no fix required)

- help.md line 42 says the sidebar "auto-selects the first active period if you
  have not chosen one." The code (`bearing-sidebar.tsx` line 42) auto-selects the
  first `active` period and falls back to the first period in the list when none
  is active. The doc is not wrong, just slightly incomplete; the omission does
  not mislead and does not warrant a change.
- The doc's "12 MCP tools" framing is correct and worth preserving; if the
  sibling `guide.md` / `mcp-tools.md` (11 rows) are ever reconciled, align them up
  to help.md, not the reverse.
