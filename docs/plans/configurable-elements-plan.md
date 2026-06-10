# Bam Configurable Elements — Priorities + Exposure of Existing Config — Plan

**Branch:** plan written on `feature-bam-csv-import`; implementation should branch
off `main` after CSV import lands (priorities work touches the same import
value-map code).
**Written:** 2026-06-10
**Status:** Plan — not yet implemented.

## 1. The ask

Bam ships "sensible defaults" for task priorities (Critical, High, Medium,
Low, None), but those were always meant to be display names. A SuperUser or
org Admin should be able to rename them (P0–P4), add levels, or remove
levels. The assumption was that this existed on the API and just lacked UI.

**Survey result (2026-06-10): it does not exist on the API.** Priorities are
a hardcoded compile-time enum; there is no table, no routes, no settings
JSON. Phases, labels, custom fields, and epics all follow a per-project
configurable-table pattern; priorities are the one task facet that never got
it. Part A of this plan builds it end-to-end. Part B is the requested sweep:
every other configuration surface that exists in the Bam API but has no UI,
consolidated here (one document for the whole effort, not one per app).

## 2. Priorities today (what has to change)

- **Canonical enum:** `PRIORITIES = ['critical','high','medium','low','none']`
  in `packages/shared/src/constants/index.ts:1`; `Priority` type in
  `packages/shared/src/types/index.ts:77`; Zod `z.enum(PRIORITIES)` in
  `packages/shared/src/schemas/task.ts:54`.
- **Storage:** `tasks.priority varchar(20) NOT NULL DEFAULT 'medium'`
  (`apps/api/src/db/schema/tasks.ts:41`, `0000_init.sql`). No DB enum, no FK —
  the column already stores a free-form slug. This is lucky: making
  priorities data-driven does **not** require touching the `tasks` table.
- **API:** priority appears only as a task field + filter
  (`task.routes.ts`), a template default (`template.routes.ts:63`), report
  group-by (`report.routes.ts`), iCal mapping (`ical.routes.ts`), and import
  normalization (`import.service.ts:109-139` — hardcoded Jira map +
  `VALID_PRIORITIES`). Zero configuration endpoints.
- **Frontend hardcodes labels/colors/icons/order in ~6 places:**
  `lib/utils.ts:45-77` (`priorityColor`, `priorityIcon`),
  `components/board/swimlane-board.tsx:44-51` (`PRIORITY_ORDER`,
  `PRIORITY_LABELS`), `components/board/task-context-menu.tsx:57-63`,
  `components/tasks/task-detail-drawer.tsx:458-461`,
  `components/import/value-map-editor.tsx:28-33` (seed guesses), plus
  `task-card.tsx` badge rendering via the utils helpers.
- **MCP server:** `apps/mcp-server/src/tools/task-tools.ts` embeds the enum
  in tool input schemas (lines ~207, 304, 394, 778).
- **Out of scope:** Helpdesk ticket priorities are a separate enum in
  `apps/helpdesk-api` with their own badge component; they are not unified
  with Bam priorities and this plan does not touch them.

## 3. Part A design decisions

### 3.1 Org-level, not per-project (recommendation)

Phases/labels/custom fields are per-project, but priorities should be
**per-org**:

- The ask is framed as SuperUser/Admin policy ("call them P0–P4 org-wide"),
  not per-board taxonomy.
- Cross-project surfaces consume priorities: org-wide task filtering, saved
  views, reports, MCP tools, CSV import seed guesses. Per-project priority
  sets would make "filter all my critical tasks" ill-defined.
- Per-project remains possible later as an override layer (same shape as
  calling-settings inheritance) without reworking the org table.

### 3.2 Stable `value` slug + editable display fields

Each priority row carries a machine `value` (what `tasks.priority` stores,
what the REST/MCP API accepts — unchanged contract for the five defaults)
plus editable `name`, `color`, `icon`, `position`, `is_default`. Renaming
Critical→P0 changes `name` only; existing tasks and API clients keep
working. Adding a level mints a new slug (slugified from the name, unique
per org). Removing a level requires task migration (same `migrate_to`
semantics as phase delete).

### 3.3 Data model

New table (next free migration number at implementation time — tip is
`0179_task_links.sql` today, so likely `0180_org_priorities.sql`):

```sql
CREATE TABLE IF NOT EXISTS priorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  value varchar(50) NOT NULL,          -- stored on tasks.priority
  name varchar(100) NOT NULL,          -- display name
  color varchar(20) NOT NULL,          -- hex, replaces hardcoded Tailwind classes
  icon varchar(50),                    -- IconName, nullable
  position integer NOT NULL,           -- sort/swimlane order (0 = most urgent)
  is_default boolean NOT NULL DEFAULT false,  -- replaces hardcoded 'medium'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, value)
);
```

Backfill in the same migration: insert the five defaults (with today's
colors/icons from `lib/utils.ts`, `medium` as `is_default`) for **every
existing org**, idempotently (`ON CONFLICT DO NOTHING`). Org-creation
service (and `POST /auth/bootstrap`) seeds the same defaults for new orgs;
`scripts/seed-platform.mjs` relies on that path. Drizzle schema module
`apps/api/src/db/schema/priorities.ts` mirrors it (keeps `pnpm db:check`
green).

`tasks.priority` stays a varchar — no FK by id (avoids rewriting every task
row and keeps the API contract string-valued). Integrity is enforced at the
service layer: task create/update/bulk validates the value against the org's
configured set. Shared Zod relaxes `z.enum(PRIORITIES)` →
`z.string().min(1).max(50)`; `PRIORITIES` remains exported as
`DEFAULT_PRIORITIES` for seeding/fallbacks.

### 3.4 API surface (mirrors `phase.routes.ts`)

New `apps/api/src/routes/priority.routes.ts`:

| Method | Route | Permission | Notes |
|---|---|---|---|
| GET | `/priorities` | any org member (`shadowOnly('bam.priority.get')`) | ordered by position; every board user needs this |
| POST | `/priorities` | `bam.priority.create` (org admin tier) | slugifies name → value, position handling like phases |
| PATCH | `/priorities/:id` | `bam.priority.update` | name/color/icon/is_default; `value` immutable |
| DELETE | `/priorities/:id?migrate_to=` | `bam.priority.delete` | refuses if tasks reference it and no `migrate_to`; bulk-updates tasks then deletes; cannot delete the `is_default` row or the last row |
| POST | `/priorities/reorder` | `bam.priority.update` | transactional position reset, same as phase reorder |

Permission matrix: add the `bam.priority.*` actions to the Wave E.D matrix
defaulted to org admin/owner (same tier as `bam.org.update`), with
`bam.priority.get` granted to members. Setting `is_default=true` clears the
flag on siblings in the same transaction.

### 3.5 Ripple work (server)

- **Task service:** default priority for new tasks = org's `is_default` row
  (falls back to `'medium'` defensively). Validation of incoming priority
  values against the org set on create/update/bulk; clear 400
  `VALIDATION_ERROR` naming the allowed values.
- **Import service:** `normalizePriority` / `VALID_PRIORITIES` /
  `seedPriorityGuesses` become org-data-driven: load the org's priority rows,
  match case-insensitively on `value` and `name`, keep the Jira-style
  heuristics as fallback guesses mapped onto whatever set exists. The CSV
  value-map editor already lets users hand-map anything else (this is why
  implementation should follow the CSV-import merge).
- **iCal:** map `position` → iCal PRIORITY 1–9 proportionally instead of the
  fixed five-way map.
- **Reports:** group-by-priority already groups on the stored value; join
  display name/color/position so charts order and label correctly.
- **MCP server:** task tools drop the inline enum, accept a string, validate
  server-side; tool descriptions say "use `list_priorities`". Add a
  `list_priorities` tool (read-only, org-scoped). Template tool/route default
  `priority` enum (`template.routes.ts:63`) relaxes the same way.

### 3.6 Frontend

- **New hook `usePriorities()`** (TanStack Query, `['priorities']`,
  org-scoped, long stale time + invalidation from the manager): returns
  ordered list + a `Record<value, PriorityRow>` lookup. Single source of
  truth replacing every hardcoded table.
- **Replace hardcodes:** `priorityColor`/`priorityIcon` in `lib/utils.ts`
  become lookups taking the fetched row (hex color via inline style — the
  Tailwind class approach can't survive arbitrary user colors; same approach
  phases/labels already use). `swimlane-board.tsx` builds rows from the
  ordered list. `task-context-menu.tsx` and `task-detail-drawer.tsx` build
  options from the list. `value-map-editor.tsx` seeds targets from the list.
  Unknown/stale values on old tasks render gray with the raw value (never
  crash).
- **Settings UI — "Priorities" manager:** the user-facing ask. Org-level, so
  it lives in **Settings → a new "Tasks" tab** (org-admin-gated via
  `useCan('bam.priority.update')`) rather than the board context menu (which
  is per-project: phases/fields/epics). Implementation mirrors
  `components/board/phase-manager.tsx` exactly: inline name edit, color
  input, icon picker (reuse IconName set), up/down reorder, default-star
  toggle, delete with migrate-to picker showing affected task counts, "add
  priority" form. This tab is also the natural future home for other
  org-level task defaults (Part B).

### 3.7 Testing & verification

- API unit tests: CRUD, reorder, delete-with-migrate, default-flag
  exclusivity, validation of task writes against the configured set, backfill
  idempotency.
- Import tests: `normalizePriority` against a custom org set; seed guesses.
- Frontend: utils tests rewritten for lookup-based color/icon; manager
  component test; swimlane ordering from custom set.
- `pnpm db:check` + `pnpm lint:migrations`; manual pass with a P0–P4 org and
  an org with 7 levels (rename, reorder, delete-with-migrate, CSV import
  mapping P0→whatever).

### 3.8 Part A sequencing

| Step | Scope | Size |
|---|---|---|
| A1 | Migration + Drizzle schema + org-creation seeding + shared schema relax | S |
| A2 | `priority.routes.ts` CRUD + permission matrix entries + task-service validation/default | M |
| A3 | `usePriorities()` + replace all frontend hardcodes | M |
| A4 | Settings → Tasks tab Priorities manager UI | M |
| A5 | Import service + value-map seeds, iCal, reports, MCP `list_priorities` + tool schema relax | M |

A1–A2 land together (API complete, UI unchanged-but-working via defaults);
A3–A4 together; A5 can trail by one PR without breaking anything.

## 4. Part B — other configurable-but-unexposed surfaces

Sweep of `apps/api` routes + schema vs. `apps/frontend` usage (2026-06-10).
Items the sweep confirmed **already exposed** and needing nothing: phases,
labels, custom fields, epics, saved views, webhooks, API keys (incl.
rotation), service accounts, LLM providers, Slack/GitHub integrations,
SMTP + platform calling settings (superuser), org permission toggles
(Settings → Permissions tab). The genuine gaps:

| # | Feature | What exists (API) | What's missing (UI) | Effort | Priority |
|---|---|---|---|---|---|
| B1 | **Task states CRUD** | `GET /projects/:id/states` only (`task-state.routes.ts`); table has name/color/icon/category/position/is_default/is_closed | Design doc promises "fully configurable task states" but there are **no write endpoints at all** — this is Part A's sibling: add POST/PATCH/DELETE/reorder + a State Manager next to Phase Manager | L | HIGH |
| B2 | **Task template library** | Full CRUD: `GET/POST /projects/:id/task-templates`, `DELETE /task-templates/:id`, apply (`template.routes.ts`) | Only the apply-picker exists (`components/tasks/template-picker.tsx`); no create/edit/delete management UI | M | HIGH |
| B3 | **Calendar token management** | `POST/GET/DELETE /projects/:id/calendar-tokens` + public `.ics` endpoints (`ical.routes.ts`) | No UI to mint/list/revoke tokens — feature is effectively invisible | S | MED |
| B4 | **`default_sprint_duration_days`** | Set at project create only (`projects` schema, default 14) | Not editable anywhere; add to project settings / sprint-create prefill | S | MED |
| B5 | **Agent policy editor** | `GET/POST /v1/agent-policies[...]` — kill switch, `allowed_tools`, `rate_limit_override`, notes (`agent-policies.routes.ts`) | `superuser/agents-list.tsx` is read-only; no edit form for policies | M | MED |
| B6 | **`launchpad_default_apps`** (platform) + per-org `launchpad_apps` override | `PUT /system-settings/launchpad_default_apps`; `PATCH /org` settings | Settings page has a literal "Launchpad" TODO section; no checklist UI | S | MED |
| B7 | **`root_redirect`** | `PUT /system-settings/root_redirect` (enum-validated) | No superuser UI; only settable via direct API/DB | S | LOW |
| B8 | **Project calling settings** | Full tri-state inherit API incl. `/effective` (`project-calling-settings.routes.ts`) | `calling-settings-manager.tsx` exists but is flagged TODO/incomplete — finish inheritance-provenance display and save path | M | MED |
| B9 | **User `notification_prefs`** | JSONB column on `users` with **no endpoint and no schema** | Settings → Notifications tab is a stub; needs schema design + API + UI (largest net-new piece here) | L | LOW |
| B10 | **Project `settings` JSONB** | `PATCH /projects/:id` accepts arbitrary `settings` | Nothing reads or writes it; define a schema before exposing anything (B4 could be its first key) | L | LOW |

Notes:

- Sweep caveat: B-items were verified by endpoint-vs-frontend grep, not by
  running the app. Each implementation PR should start by re-verifying the
  gap (a couple of these surfaces are moving — e.g. CSV import landed
  mid-survey).
- B1 deserves the same design treatment as Part A (delete-with-migrate,
  category constraints — at least one `todo` and one `done` category state
  must remain, `is_default`/`is_closed` invariants) and should reuse the
  Priorities manager component patterns; recommended as the immediate
  follow-on so the three task facets (phase, state, priority) end up with
  symmetric management UX.
- B3/B4/B6/B7 are quick wins — four small PRs, no schema work.

## 5. Suggested overall sequencing

1. **Wave 1 (headline):** Part A — configurable priorities (A1→A5).
2. **Wave 2 (quick wins):** B3, B4, B6, B7 — four small UI-only PRs.
3. **Wave 3 (symmetry):** B1 task-state CRUD + manager; B2 template library.
4. **Wave 4:** B5 agent policy editor; B8 calling settings completion.
5. **Backlog:** B9 notification prefs, B10 project settings schema — both
   need schema/design decisions before any UI work and should get their own
   short specs when picked up.
