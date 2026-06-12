# Epics in Bam: Current State & First-Class Support Plan

**Date:** 2026-06-12
**Status:** Report + draft plan, awaiting review
**Prompted by:** "We are not currently using Epics… I'm assuming Epic support is
minimal… please write a report on what is currently available and supported,
and include a draft plan for first-class support."

---

## Part 1 — What exists today (more than expected)

Epics are already a standalone entity with full CRUD, not a vestigial field.
The reason they feel invisible is that everything about them is **tucked
behind the board toolbar** and nothing *aggregates* them — there is no place
where an epic tells you how it's going.

| Layer | What exists | Where |
|-------|-------------|-------|
| Schema | `epics` table: id, project_id, name, description, color (hex), start_date, target_date, status (`open`/`in_progress`/`closed`) | `apps/api/src/db/schema/epics.ts` |
| Task link | `tasks.epic_id` (nullable FK, indexed) | `apps/api/src/db/schema/tasks.ts:37` |
| REST | Full CRUD with permission gates: `GET/POST /projects/:id/epics`, `PATCH/DELETE /epics/:id`; list returns task counts | `apps/api/src/routes/epic.routes.ts` |
| Enrichment | Task payloads carry `epic: { id, name }` | `apps/api/src/services/task.service.ts` |
| UI | "Manage epics" dialog (create/list/delete; name, description, color, target date, task count) via the board toolbar Layers icon | `apps/frontend/src/components/board/epic-manager.tsx` |
| Board | Swimlane grouping **By Epic** (with a "No Epic" bucket) | `apps/frontend/src/components/board/swimlane-board.tsx` |
| Shared/MCP | `epic_id` accepted by create/update task schemas and both MCP task tools | `packages/shared/src/schemas/task.ts`, `apps/mcp-server/src/tools/task-tools.ts` |

**What's genuinely missing** (the gap between "exists" and "first-class"):

1. **No epic detail surface.** You cannot open an epic and see its tasks,
   progress, dates, or description. The manager dialog is admin-only CRUD.
2. **No progress rollup.** Task counts exist in the list endpoint, but no
   done/total, story-point sums, or per-sprint distribution.
3. **No epic on the task card or detail drawer.** A task's epic is invisible
   on the board (no color chip) and the drawer has no epic picker — you can
   only set `epic_id` programmatically or at creation. *(The drawer has a
   picker for everything else: phase, sprint, assignee, priority.)*
4. **No cross-sprint view.** Epics are the multi-sprint primitive, but
   nothing shows an epic's tasks across sprints (the board is one sprint at
   a time; the timeline view doesn't know epics exist).
5. **No filtering by epic** in the filter bar, list view, or saved views.
6. **No epic lifecycle automation.** `status` is a manually-set string; no
   Bolt events (`epic.created/updated/closed`), no auto-close suggestion
   when all tasks complete, no carry-forward awareness.
7. **No MCP epic tools.** Agents can set a task's `epic_id` but cannot
   create, list, or report on epics.

## Part 2 — Draft plan for first-class epics

Design stance: an epic is a **named, colored, dated container with a
progress contract** — not a fourth hierarchy level. Tasks keep their
parent/subtask graph; the epic is the delivery-shaped lens over it. Four
phases, each independently shippable.

### Phase E1 — Make epics visible where work happens (~1-2 days)
- **Epic chip on task cards**: small colored dot + epic name (truncated) on
  board cards and list rows, using the epic's `color`.
- **Epic picker in the task drawer**: a Select next to Sprint/Phase, fed by
  `GET /projects/:id/epics`; sets `epic_id` via the existing update path.
- **Filter by epic**: add to the board filter bar + saved-view filters.
- API: include `epic: { id, name, color }` in board/list payloads (the
  enrichment exists for detail; extend `getBoardState`).

### Phase E2 — The epic detail page (~2-3 days)
- Route `/b3/projects/:projectId/epics/:epicId`: header (name, color,
  status, start/target dates, description as markdown), progress bar
  (done/total tasks AND completed/total story points), task list grouped by
  sprint (the cross-sprint view), and a burnup sparkline (tasks completed
  per week against total scope — derivable from `tasks.completed_at`).
- "Manage epics" dialog rows link here; epic chips on cards link here.
- API: `GET /epics/:id` (detail + rollup), `GET /epics/:id/tasks`
  (cross-sprint, cursor-paginated). Rollup query is a single GROUP BY.

### Phase E3 — Lifecycle & automation (~1-2 days)
- Bolt events: `epic.created`, `epic.updated`, `epic.status_changed`
  (register in the event catalog; `publishBoltEvent` source `bam`), so org
  automations can announce epic completion to Banter, etc.
- Status semantics: auto-suggest `in_progress` when the first task starts,
  surface a "all N tasks done — close this epic?" nudge on the detail page.
- Activity log rows for epic mutations (same pattern as task updates).
- Sprint-close report: the existing sprint-close worker job gains an
  optional per-epic progress section.

### Phase E4 — Agents and scale (~1 day)
- MCP tools: `epic_create`, `epic_list`, `epic_update`, `epic_progress`
  (the rollup as structured data) — the same shapes the REST detail uses.
- `search_everything` / `resolve_references` recognize `epic:` mentions.
- Org-level roadmap view (stretch): all epics across projects on a
  timeline strip, colored by status — the "long-running deliverables at a
  glance" ask. Builds on the same rollup endpoint.

### Non-goals (explicitly)
- **Epic hierarchies / initiatives.** One level of containment. If we ever
  need program-level grouping, that's a new entity, not nested epics.
- **Epic-level permissions.** Epics inherit project access; no per-epic ACLs.
- **Cross-project epics.** An epic belongs to one project. Cross-project
  delivery tracking is Bearing's job (goals/OKRs) — link an epic to a
  Bearing key result rather than stretching the epic across projects.

### Sequencing note
E1 is the highest leverage-to-effort and unblocks adoption (you can't use
what you can't see). E2 is the heart of "deep support." E3/E4 can trail by
weeks without hurting anything.
