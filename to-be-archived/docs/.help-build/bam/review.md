# Bam help.md Review

**Verdict: CHANGES REQUESTED**

Two accuracy defects in the Feature reference trace to UI/claims that do not
exist in the frontend code. Everything else (template completeness, feature
coverage, story coverage, conventions, screenshots, MCP tool names, counts)
verified clean against the code.

---

## Fix list

1. **File:** `docs/apps/bam/help.md`
   **Section:** Feature reference > "Watchers" (and the supporting mentions in
   "Tasks: create, edit, and detail" and the Key concepts "Watcher" entry).
   **What is wrong:** The doc states "A task can have watchers who receive its
   notifications. Manage watchers from the task detail drawer." There is no
   watcher-management UI anywhere in the frontend. `apps/frontend/src` has zero
   matches for `watcher`/`Watcher` (the only `watch` hits are react-hook-form's
   `watch()` in `create-task-dialog.tsx`). `watchers` is a real persisted
   `uuid[]` column (`apps/api/src/db/schema/tasks.ts` line 53) but there is no
   dedicated add/remove route (only a hardcoded `watchers: []` in
   `task.routes.ts` line 673) and no drawer section to edit it.
   **What it should be:** Either remove the "Manage watchers from the task
   detail drawer" how-to claim and describe watchers as a notification-target
   field populated by the system (assignment/mention side effects), or, if a
   PATCH-based watcher edit truly round-trips, cite the exact control. Do not
   tell a reader to manage watchers from a drawer that has no such control. The
   Key-concepts "Watcher" definition can stay, but the Feature-reference
   "Watchers" section's instruction is unfollowable as written.

2. **File:** `docs/apps/bam/help.md`
   **Section:** Feature reference > "People and members".
   **What is wrong:** The doc says the user detail page "has tabs for profile,
   projects, access, and activity." The first tab's rendered label is
   **Overview**, not "Profile" (`apps/frontend/src/pages/people/detail.tsx`:
   `DetailTab = 'overview' | 'projects' | 'access' | 'activity'`, tab button
   text "Overview" at lines 386-387). "Profile" is the label of a tab on the
   org-level Settings page, not on the people detail page.
   **What it should be:** Change "tabs for profile, projects, access, and
   activity" to "tabs for **Overview**, **Projects**, **Access**, and
   **Activity**." (Note the Access and Activity tabs are permission-gated -
   Access shows for admins or self, Activity for admins - but listing all four
   is acceptable.)

---

## Accuracy findings (label/claim that did not trace to code)

- **"Manage watchers from the task detail drawer"** - no watcher UI exists in
  `apps/frontend/src`; no watcher mutation route exists in
  `apps/api/src/routes`. (Fix #1.)
- **People detail tab labeled "profile"** - the actual first tab is "Overview"
  (`pages/people/detail.tsx` lines 386-387). (Fix #2.)

## Verified clean (spot-checks that traced to code)

- Context menu labels (Open detail, Add subtask..., Duplicate, Priority,
  Move to phase, Set state, Assign to..., Change parent task, Delete task):
  `components/board/task-context-menu.tsx`.
- Create Task dialog (title "Create Task"; fields Title/Phase/Priority/Story
  Points/Assignee/Due Date/Labels/description; submit "Create Task"; priority
  defaults to medium): `components/tasks/create-task-dialog.tsx`.
- Swimlanes (No Swimlanes / By Assignee / By Priority / By Epic): `pages/board.tsx`
  lines 51-56.
- View switcher (Board/List/Timeline/Calendar/Workload):
  `components/board/view-switcher.tsx`.
- Project options menu (Manage Phases / Custom Fields / Export / Delete Project):
  `pages/board.tsx` lines 636-673.
- Sprint selector labels ("(Active)"/"(Done)", Start this sprint, Delete this
  sprint, View sprint report, Create sprint, placeholder "Sprint 1"):
  `components/board/sprint-selector.tsx`.
- Carry-forward / complete-sprint dialog (title "Complete Sprint: NAME";
  options "Carry forward"/"Move to backlog"/"Cancel task"; "Retrospective Notes
  (optional)"; submit "Complete Sprint"): `components/board/carry-forward-dialog.tsx`.
- Detail drawer tabs (Details/Comments/Activity + conditional Helpdesk) and the
  exactly five reaction emoji (thumbs-up, heart, rocket, eyes, party):
  `components/tasks/task-detail-drawer.tsx` lines 93, 714, 736-746. "Time Logged"
  label at line 1434.
- Keyboard shortcuts (N, S, /, F, Escape, ?, Ctrl+K) and overlay title
  "Keyboard Shortcuts": `components/common/keyboard-shortcuts-overlay.tsx`.
- Settings: exactly ten tabs (Profile, Appearance, Notifications, Members,
  Tasks, Permissions, Launchpad, Integrations, AI Providers, Helpdesk);
  Appearance options System/Light/Dark; "Manage Priorities" in Tasks tab:
  `pages/settings.tsx` lines 612-621, 698-701, 2013.
- My Work groups (Overdue / Due This Week / In Progress / All My Tasks):
  `pages/my-work.tsx`.
- Export dialog (Format JSON/CSV, Sprint optional "All sprints", submit
  "Export"; rate-limited 3/min): `pages/board.tsx` 779-817,
  `routes/export.routes.ts` line 52.
- Counts: priorities 5 incl. none (`constants/index.ts` line 1); project
  templates kanban_standard/scrum/bug_tracking/minimal/none (line 11); custom
  field types text/number/date/select/multi_select/checkbox/url
  (`custom-field.routes.ts` line 31); saved-view types board/list/timeline/
  calendar, not workload (`view.routes.ts` lines 47, 81); bulk cap 100
  (`schemas/task.ts` line 87); task-link cap 50 (`schemas/task.ts` line 14);
  nine Bam MCP tool files.
- MCP tool names: all tools named in the doc trace to
  `apps/mcp-server/src/tools/{task,sprint,project,epic,member,report,template,comment,import}-tools.ts`;
  resolvers (bam_list_epics/labels/phases/states) in epic-tools.ts /
  bam-resolver-tools.ts / utility-tools.ts.
- Deep-link route `/b3/tasks/ref/MAGE-38`: `App.tsx` line 80
  (`^/tasks/ref/([^/]+)$`).
- iCal feed + calendar-tokens, audit-log, project-dashboard, project-reports
  routes all present (`routes/ical.routes.ts`, `App.tsx`).
- Done-gate alert surfaces INCOMPLETE_SUBTASKS (`pages/board.tsx` lines 354-355).
- Conventions: no em dashes or en dashes in help.md.

## Screenshots

All five referenced screenshots exist on disk under
`docs/apps/bam/screenshots/light/` (01-board, 02-sprint-board, 03-task-detail,
04-people, 05-settings), with matching dark/ counterparts.

## Story coverage

All required arcs present and followable: setup (Spin up a project from a
template), core loop (Create and work a task end to end; Plan and run a sprint),
collaboration (Group work under an epic; comments/reactions covered in core
loop), search/reporting (Report on delivery; Slice the board with views), and
agent flow (every story carries a "Related" line naming the MCP tools, and the
"Working with AI agents" feature section enumerates the catalog).
