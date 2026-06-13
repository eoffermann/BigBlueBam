# Epics Part 2 (E1–E4) — build contract

Shared contract for the parallel implementation of first-class epics
(the E1–E4 plan in `epics-first-class-support.md`). Surfaces are mostly
file-disjoint; this doc fixes the shapes so the slices integrate.

Current state (already exists): `epics` table (id, project_id, name,
description, color[hex], start_date, target_date, status['open'|
'in_progress'|'closed'], created_at, updated_at); `tasks.epic_id` FK;
REST `GET/POST /projects/:id/epics`, `PATCH/DELETE /epics/:id`; task
detail enrichment includes `epic`; swimlane-by-epic; Bolt `epic.completed`
event; `create_task`/`update_task` REST accept `epic_id`
(`update_task` MCP TOOL does not — that's a gap to close).

## Canonical epic payload

```ts
interface Epic {
  id: string; project_id: string; name: string;
  description: string | null; color: string | null;     // #RRGGBB
  start_date: string | null; target_date: string | null;
  status: 'open' | 'in_progress' | 'closed';
  created_at: string; updated_at: string;
  task_count?: number;                 // list + detail
  // detail-only rollup:
  done_count?: number;                 // tasks with completed_at not null
  total_story_points?: number;
  done_story_points?: number;
}
```
A task's epic mini-shape on board/list payloads: `epic: { id, name, color } | null`.

## API (apps/api) — owns the spine

1. **`GET /epics/:id`** (auth + `requireProjectAccessForEntity('epic')`,
   `shadowOnly('bam.epic.get')` if that key exists else just access):
   return the epic + rollup over ALL tasks with `epic_id = :id` (parents
   AND subtasks — both are assigned per product decision):
   `task_count`, `done_count` (completed_at not null),
   `total_story_points`, `done_story_points`. 404 envelope if missing.
2. **`GET /epics/:id/tasks`**: all tasks with `epic_id = :id`, each
   `{ id, human_id, title, parent_task_id, sprint_id, sprint_name,
   phase_name, state_category, completed_at, story_points }`, ordered by
   sprint then position. (Powers the detail page's group-by-sprint list +
   burnup.)
3. **Board + list enrichment**: in `getBoardState` (and any list payload
   path that feeds the board views) attach `epic: { id, name, color } |
   null` to every task. One `leftJoin(epics)` or a `Map<epic_id,…>`
   pre-pass, same pattern as the `parents` enrichment already there.
4. **Bolt + activity on mutation**: in `epic.routes.ts` POST → publish
   `epic.created`; PATCH → `epic.updated`, and when `status` changes also
   `epic.status_changed` (payload: epic.id, epic.name, project_id,
   old_status, new_status, actor). Use `publishBoltEvent({event, source:
   'bam', payload})`. Add `logActivity` rows (entity_type 'epic',
   actions 'epic.created'/'epic.updated'/'epic.status_changed').
5. **packages/shared**: export the `Epic` type above and a
   `createEpicSchema`/`updateEpicSchema` (mirror the route zod). Add
   `epic?: { id: string; name: string; color: string | null } | null` to
   the `Task` type.

## MCP (apps/mcp-server) — new epic tools + update_task gap

New tools (new file `epic-tools.ts`, registered in index; they call the
REST API the same way other tools do — reuse the existing api-client/
fetch helper used by task-tools):
- **`bam_create_epic`** `{project_id, name, description?, color?,
  start_date?, target_date?, status?}` → POST /projects/:project_id/epics.
- **`bam_update_epic`** `{epic_id, name?, description?, color?,
  start_date?, target_date?, status?}` → PATCH /epics/:epic_id.
- **`bam_get_epic`** `{epic_id}` → GET /epics/:epic_id (detail+rollup).
- **`bam_list_epics`** already exists — leave it.
- **Add `epic_id`** to the `update_task` tool schema
  (`z.string().uuid().nullable().optional()`), pass through to PATCH
  /tasks/:id (REST already supports it). This is what lets the importer
  assign epics to EXISTING tasks.
Keep tool output shape consistent with the other bam_* tools
(`{ data: … }`). `bam_list_epics` / `bam_create_epic` are the import's
idempotency pair.

## Frontend (apps/frontend) — E1 visibility + E2 detail page

- **Epic chip** on board cards (`components/board/task-card.tsx`) and list
  rows (`components/views/list-view.tsx`): small colored dot (epic.color,
  fallback zinc) + epic.name truncated, clickable → epic detail route.
  Reads `task.epic` from the enriched payload.
- **Epic picker** in the task drawer
  (`components/tasks/task-detail-drawer.tsx`): a Select next to Sprint/
  Phase, options from `GET /projects/:id/epics` + a "No epic" clear;
  sets `epic_id` via the existing task update mutation.
- **Filter by epic**: add to `components/board/filter-bar.tsx`, plumb the
  `epic_id` filter through `pages/board.tsx` (client-side filter on
  `task.epic?.id` is fine), include in saved-view filter shape.
- **Epic detail page**: new `pages/epic-detail.tsx`, route
  `/b3/projects/:projectId/epics/:epicId` wired into the frontend router
  (same hand-rolled router pattern the other pages use — find where
  routes are parsed). Header: name, color swatch, status badge, start/
  target dates, description rendered as markdown (reuse
  `lib/markdown`). Progress: two bars — tasks done/total and story points
  done/total (from `GET /epics/:id`). Body: task list grouped by sprint
  (from `GET /epics/:id/tasks`), each row links to its task. A simple
  burnup: tasks-completed-per-week vs total scope (lightweight SVG or
  bars — no chart lib needed). "All N tasks done — close this epic?" nudge
  when done_count === task_count > 0 and status !== 'closed' (PATCH status
  to closed).
- **epic-manager** (`components/board/epic-manager.tsx`) rows → link to
  the detail page.

## Bolt (apps/bolt-api) — E3 catalog

Register in `services/event-catalog.ts` (source `bam`), matching the
existing `epic.completed` entry's structure:
- `epic.created` — epic.id, epic.name, project.id, actor.
- `epic.updated` — epic.id, epic.name, changed_fields.
- `epic.status_changed` — epic.id, epic.name, old_status, new_status.
`scripts/check-bolt-catalog.mjs` must stay green (the api publish sites
and the catalog must agree on (source,event)).

## Integration / redeploy

Affected containers: api, mcp-server, frontend, bolt-api (worker only if
the sprint-close epic section is added — optional, skip if time-boxed).
After build: `pnpm db:check` n/a (no schema change), typecheck each app,
`node scripts/check-bolt-catalog.mjs`, rebuild + recreate the affected
containers, then the importer re-run assigns the 44 Frndo tasks.
