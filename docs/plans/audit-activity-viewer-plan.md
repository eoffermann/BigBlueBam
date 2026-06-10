# Audit & Activity Viewer — Plan Spec

**Priority:** HIGH — scheduled immediately after the Bam CSV import work
(`docs/plans/bam-csv-import-plan.md`) lands.
**Written:** 2026-06-10
**Status:** Plan — not yet implemented.

## 1. Problem

Admins and SuperUsers have no place to *browse* the action logs the platform
already records. The data and most of the API surface exist; the UI doesn't.

Survey findings (2026-06-10) — what exists today:

| Surface | Where | Backed by |
|---|---|---|
| Per-project audit log | `/b3/projects/{id}/audit-log` (`apps/frontend/src/pages/audit-log.tsx`) | `GET /projects/:id/activity` |
| Per-person activity tab | `/b3/people/{userId}` → Activity (admins) | `GET /org/members/:userId/activity` |
| SuperUser actions *targeting one user* | `/b3/superuser/people/{userId}` → Activity | `GET /superuser/audit-log?target_user_id=` |
| Last-20 org activity | SuperUser org detail | inline in `GET /superuser/organizations/:id` |
| Cross-app unified activity | **MCP tools only** (`activity_query`, `activity_by_actor`) | `GET /v1/activity/unified[/by-actor]` over `v_activity_unified` (Bam + Bond + Helpdesk, normalized `actor_type`) |
| Server-wide superuser audit trail | **endpoint only**, no page | `GET /superuser/audit-log` (filters: `superuser_id`, `target_user_id`, `action`, cursor) |

Gaps:

1. **No standalone SuperUser audit console** — the server-wide trail of
   superuser actions is queryable but has no screen.
2. **No human UI over the unified activity view** — the richest dataset
   (cross-app, agent-vs-human attribution) is agent-only today.
3. **No org-wide activity browser for org admins** — they must go
   project-by-project or person-by-person.

## 2. Scope

### P0 — SuperUser console: "Audit & Activity" page (frontend-heavy, both endpoints exist)

New page `/b3/superuser/audit` (route key `superuser-audit`), entry via a new
`AdminToolCard` on the SuperUser console ("Audit & Activity — browse the
superuser audit trail and cross-app activity"). Two tabs:

**Tab 1 — SuperUser audit trail** (`GET /superuser/audit-log`)
- Filter bar: acting superuser (people-picker), action type (select fed by a
  distinct-actions helper or a static list), target user, date range.
- Table: timestamp · acting superuser (avatar+name) · action ·
  target (type + linkified id where routable, e.g. user → people detail) ·
  expandable `details` JSON (pretty-printed, diff-style for
  before/after-shaped payloads).
- Cursor pagination ("Load more"), default 50/page.
- **API gap to close:** add `target_type`, `since`/`until` date-range params
  to the endpoint (additive; current filters stay). Same
  `bam.audit_log.list` capability.

**Tab 2 — Unified activity** (`GET /v1/activity/unified` + `/by-actor`)
- Filter bar: source app (bam/bond/helpdesk), entity type, actor
  (people-picker → switches to the by-actor endpoint), actor kind
  (human/agent/service — render as badges, this is the §10 attribution),
  action, date range, org (SuperUsers operate cross-org; default = active
  org, with an "all orgs" toggle that requires superuser).
- Table mirrors Tab 1; entity column deep-links into the owning app
  (reuse/extract the URL-builder logic from `resolve_references` /
  `surfaceUrlFor` rather than writing a third copy).
- **API gap to check:** the unified endpoints were built for the agent read
  plane — verify the permission (`bam.activity_unified.list`) and org
  scoping behave sensibly for an interactive superuser session, and add
  date-range params if missing.

Both tabs: empty states, loading skeletons, and a "Export visible rows as
CSV" button (client-side serialization of the loaded page — no new
endpoint).

### P1 — Org-admin org-wide activity page

- New page `/b3/org/activity` (linked from the People page header area,
  visible to org admins/owners only).
- Backed by the **unified view filtered to the caller's org** — preferred
  over inventing a new query: add capability `bam.org_activity.list`
  (granted to org admin/owner groups) authorizing
  `GET /v1/activity/unified` scoped hard to the caller's active org
  (server-side pin, ignore any org param), or a thin
  `GET /org/activity` wrapper that does exactly that. Decide at
  implementation; lean wrapper-route for a clean permission story.
- Same table/filter component as P0 Tab 2 (build it shared from the start:
  `apps/frontend/src/components/activity/activity-browser.tsx` with
  endpoint + allowed-filters props).

### Non-goals (this pass)

- No new logging — purely viewers over existing tables/views.
- No retention/archival controls.
- No helpdesk-admin activity browser (separate app; revisit if asked).
- No realtime streaming; manual refresh + pagination is fine for audit use.

## 3. Implementation notes

- **Shared component first:** one `ActivityBrowser` (filters, table,
  expandable details, cursor pagination, CSV export) parameterized by
  endpoint + filter set; the three surfaces (superuser tab 1, tab 2,
  org-admin page) are thin wrappers. Tab 1's row shape differs slightly
  (superuser_id vs actor_id) — normalize in the wrapper, not the component.
- **Routing:** follow the existing pattern in `apps/frontend/src/App.tsx`
  (`superuser-platform-calling` is the template for parse + case + page).
- **Permissions:** P0 reuses `bam.audit_log.list` and
  `bam.activity_unified.list` (verify they're in the permission catalog and
  granted to superusers); P1 adds `bam.org_activity.list` via the
  permission-group defaults (check how Wave-era capabilities were seeded —
  likely `permission_group_defaults` rows, which may mean one small
  migration).
- **Details JSON can contain secrets-adjacent payloads** (e.g. settings
  changes) — the superuser audit endpoint already stores what was logged;
  render verbatim for superusers, but the P1 org-admin surface must NOT
  expose superuser-trail rows, only unified activity.
- **Performance:** `v_activity_unified` UNIONs three tables; the existing
  endpoints already paginate. Keep page size ≤100 and always send a date
  floor (default: last 30 days) so the partitioned `activity_log` prunes
  partitions.

## 4. Estimate & sequencing

- **P0:** ~1 day (mostly frontend; +2 small additive endpoint params).
- **P1:** ~0.5–1 day (wrapper route + capability seeding + page reusing the
  shared component).

**Sequencing:** HIGH priority, queued directly behind the Bam CSV import
work on this branch's roadmap — start when CSV Phases 0–1 (Links field +
import core) have landed, before CSV Phases 2–3 unless those are already in
flight.

## 5. Acceptance

- A SuperUser can open `/b3/superuser/audit`, filter the superuser trail by
  actor/action/date, expand a row's details, and page through history.
- The same page's second tab shows cross-app activity with human/agent/
  service badges and working deep links into Bam/Bond/Helpdesk entities.
- An org admin (non-superuser) can open `/b3/org/activity` and see all
  activity in their org only; they get 403/404 on the superuser page and
  cannot see superuser-trail rows anywhere.
- E2E: superuser performs a settings change → it appears in Tab 1; a task
  update appears in Tab 2 and in the org-admin page, attributed correctly.
