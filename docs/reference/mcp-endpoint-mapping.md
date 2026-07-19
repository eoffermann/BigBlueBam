# BigBlueBam — REST Endpoint ↔ MCP Tool ↔ UI Surface Map

> **⚠ KEEP THIS CURRENT AND COMPLETE.** This is the single map of our REST / MCP / CLI / UI surface.
> **Any time you add, remove, rename, or consolidate a REST endpoint; add, change, or remove an MCP tool; change a `cli.ts` command; or wire/unwire a UI call site — update the relevant table in this file in the SAME change.**
>
> **Complete means no bare `—`.** Every REST row's MCP-tool column must be either a backtick-wrapped tool name **or** `— _(skip: <short reason>)_` saying why no tool exists (auth/credentials, multipart/binary, public-inbound, SuperUser/permission admin, internal service-to-service route, realtime/ws/Yjs, resolver-done-internally, deprecated, deferred, …). A section that is **entirely or nearly tool-less** gets a `> **⚠ No MCP tools in this section — intentional.**` callout under its heading explaining why. Keep the coverage summary counts in sync.
>
> A stale or half-annotated surface map is worse than none. Not yet CI-enforced, so it is on us to keep it honest **and exhaustive**.

_Last full survey: 2026-06-17._

Self-check that the map has no un-annotated gaps (must print `0`):

```sh
grep -cE '^\| `[^|]+` \| — \|' docs/reference/mcp-endpoint-mapping.md
```

## What this is

BigBlueBam exposes most functionality on parallel surfaces, and this document maps the correspondences between them:

- **REST** — Fastify routes per service (`apps/<svc>/src/routes/*.ts`), reached externally via nginx prefixes (`/b3/api/`, `/banter/api/`, `/beacon/api/`, …). Paths in the tables are **as registered in code**; prepend the service prefix (noted in each section header) for the external URL. Several services register routes under an in-app `/v1` prefix.
- **MCP** — agent tools in `apps/mcp-server/src/tools/*.ts`. Most are thin wrappers over one REST endpoint; some are **composite** (fan out across several endpoints/services) or **client-side** (pure compute / LLM placeholder) and have no single backing endpoint.
- **CLI** — `apps/api/src/cli.ts`, a small bootstrap / break-glass surface (11 commands). Mapped in its own section at the end.
- **UI** — the per-app SPAs (`apps/<app>/src`, Bam at `apps/frontend/src`). The **UI call site** column cites one representative caller where one exists.

A tool/command "corresponds" to the endpoint(s) its handler calls. Sections are grouped by **app**, then the **cross-app platform** surface, then the **CLI**.

### Legend

| Symbol | Meaning |
|---|---|
| `—` in **MCP tool** col | endpoint has no MCP tool |
| `— (composite)` in **REST** col | MCP tool fans out across endpoints; no single backing endpoint |
| `— (client-side)` in **REST** col | MCP tool is pure compute / LLM placeholder; no endpoint |
| `—` in **UI call site** col | no SPA caller (usually internal, webhook, public-inbound, or agent-only) |

## Surface summary

| Surface | REST endpoints | …with an MCP tool | …without a tool | MCP-only tools (no endpoint) |
|---|--:|--:|--:|--:|
| Bam — Work management | 93 | 86 | 7 | 2 |
| Bam — Org, auth, admin & integrations | 156 | 37 | 119 | 0 |
| Banter | 113 | 75 | 38 | 0 |
| Beacon | 40 | 38 | 2 | 0 |
| Brief | 54 | 48 | 6 | 0 |
| Bond | 72 | 70 | 2 | 0 |
| Bolt | 28 | 27 | 1 | 0 |
| Bearing | 35 | 33 | 2 | 0 |
| Board | 45 | 39 | 6 | 1 |
| Blast | 40 | 27 | 13 | 2 |
| Bench | 29 | 29 | 0 | 3 |
| Blueprint | 38 | 35 | 3 | 1 |
| Book | 33 | 25 | 8 | 0 |
| Blank | 24 | 18 | 6 | 1 |
| Bill | 52 | 47 | 5 | 0 |
| Bureau | 42 | 37 | 5 | 0 |
| Bin | 32 | 19 | 13 | 0 |
| Bay | 20 | 14 | 6 | 0 |
| Blip | 40 | 38 | 2 | 0 |
| Helpdesk | 38 | 15 | 23 | 0 |
| Basis | 17 | 15 | 2 | 0 |
| Braid | 21 | 12 | 9 | 1 |
| Cross-app platform | 41 | 32 | 9 | 6 |
| **Total** | **1103** | **816** | **287** | **17** |

_Counts are summed from the per-section tables (each row's REST endpoint counted once even when several MCP tools share it). After the `feat/mcp-endpoint-parity` build the "with an MCP tool" total roughly doubled (≈334 → ≈690). Of the ~247 endpoints still tool-less, the large majority are now annotated `— _(skip: …)_` with a reason — auth/OAuth/session, public-inbound (forms/booking/portal/tracking), multipart/binary upload, binary export (PDF/SVG/CSV/.ics), raw credential/API-key admin, SuperUser/permission/account admin (Bam org/admin held to a deliberately conservative scope this pass), Yjs/scene/WebSocket realtime sync, internal/service-to-service routes, and slug/name resolvers done internally — plus the deferred Helpdesk `X-Agent-Key` agent routes. Some endpoints are shared by multiple MCP tools and many are internal / webhook / public-inbound (not user-facing), so treat the totals as close approximations of the surface size, not an exact public-API inventory. The remaining intentional gaps cluster in **Bam org/admin** (SuperUser & permissions admin, integrations, credentials — UI/CLI-only) and a few per-app binary/upload/realtime tails._

---

## MCP endpoint-parity build — implementation decisions (2026-06-17)

Branch `feat/mcp-endpoint-parity`: a pass to give every **agent-appropriate** REST
endpoint an MCP tool. Standing decisions for this work, so the per-app tables can
stay terse:

- **REST is never modified.** Every new tool is a thin wrapper that calls the
  existing REST endpoint through the per-app fetch client (forwarding the
  caller's bearer token + `X-Org-Id`), exactly like the established
  `*-tools.ts` modules. No route handler, schema, or service signature changes.
- **Skipped endpoint classes** (left `—`, annotated `_(skip: <reason>)_` in the
  tables): auth / login / logout / session / password / OAuth callbacks; CSRF;
  inbound webhooks & public-inbound (forms, tracking pixels, unsubscribe, ticket
  intake); multipart **binary uploads** (agents reference existing files via
  `attachment_get` / `attachment_list`); raw credential management (API-key
  secrets); SuperUser break-glass & permission-matrix admin (intentionally
  UI/CLI-only); pure internal/service-to-service routes (`/internal/*`,
  `/tools/call`, dual-read). Slug/name **resolver** GETs are not standalone tools
  — the write tools resolve names/slugs internally.
- **Permission mapping.** New tools are not added to `@bigbluebam/permissions`
  `TOOL_TO_PERMISSION` in this pass, so under per-action enforcement they
  pass-through (only an explicit resolver `deny` blocks, which unmapped tools
  never trigger). The backstops remain: the REST endpoint's own
  scope/`requireCan`/RLS authorization, and the §15 agent-policy tool-name
  allowlist. Adding granular `TOOL_TO_PERMISSION` entries for the new tools is a
  tracked follow-up.
- **Helpdesk agent routes deferred.** The `/helpdesk/api/agents/*` mutation
  routes (queue, agent ticket detail, close, merge, post-message,
  status/priority/category update) authenticate with a per-agent `X-Agent-Key`
  (`hdag_`-prefixed) rather than the Bearer token + `X-Org-Id` the wrappers
  forward. Wrapping them requires threading that separate credential, so they
  are intentionally left `—` this pass and annotated accordingly in the Helpdesk
  table. The customer/agent read tools (search, by-number, similar) are
  unaffected.
- **Bam org/admin held to a conservative scope.** Bam member/account-lifecycle,
  guest, OAuth/SSO, SuperUser, permissions-admin, integration (GitHub / Slack /
  webhooks), iCal, LLM-provider, and credential (API-key / service-account)
  endpoints were deliberately NOT wrapped — those stay UI/CLI-only and are
  annotated `— _(skip: … — conservative scope)_`. The org/member tools that did
  land are read/inspect plus invite, role change, project membership, password
  reset/reset-link, and org read — see the Bam — Org & Members table.
- **Verification.** Each app's new tools are smoke-tested on the local Docker
  stack via the internal `POST /tools/call` route (service-account harness),
  exercising tool → REST → response, with self-cleaning test data. The
  mcp-server `tsc --noEmit` must pass before each commit.

---

## Bam core — work management surface (REST ↔ MCP map)

Scope: the Bam "work management" REST routes in `apps/api/src/routes/` (project,
task, sprint, epic, phase, label, task-state, task-analytics, custom-field,
comment, reaction, time-entry, template, version, upload, attachment, report,
import) mapped to MCP tools in `apps/mcp-server/src/tools/` (project-tools,
task-tools, sprint-tools, epic-tools, comment-tools, template-tools,
import-tools, report-tools, utility-tools, bam-resolver-tools, plus
`get_my_tasks` from member-tools and `bam_task_count_by_phrase` from
phrase-count-tools).

External URL = `/b3/api/` + the in-app path shown in the REST column.

Notes:
- MCP tool names are unprefixed in code; the live server exposes them as
  `mcp__bigbluebam__<name>` / `mcp__bigbluebam-prod__<name>`.
- Many write tools relax their Zod input to plain strings and resolve names →
  UUIDs client-side via read endpoints before the backing call; the "backing
  endpoint" listed is the mutation each tool ultimately performs.

## Bam — Projects
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `project-tools.ts`, `task-tools.ts` (resolver)

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects` | `list_projects` | List accessible projects | `apps/frontend/src/pages/dashboard.tsx` |
| `POST /projects` | `create_project` | Create a project | `apps/frontend/src/pages/dashboard.tsx` |
| `GET /projects/:id` | `get_project` | Get one project | `apps/frontend/src/hooks/use-projects.ts` |
| `PATCH /projects/:id` | `update_project` | Update project (admin) | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /projects/:id` | `archive_project` | Archive project (admin) | `apps/frontend/src/pages/settings.tsx` |
| `GET /projects/:id/members` | `list_project_members` | List project members | `apps/frontend/src/pages/board.tsx` |
| `POST /projects/:id/members` | `add_project_member` | Add a project member | `apps/frontend/src/pages/settings.tsx` |
| `POST /projects/:id/slack-integration/test` | `test_slack_webhook` | Send a test Slack webhook message | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /projects/:id/github-integration` | `disconnect_github_integration` | Remove project GitHub integration | `apps/frontend/src/pages/settings.tsx` |


## Bam — Tasks
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `task-tools.ts`, `member-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects/:id/board` | `get_board` | Board state (phases + tasks + sprint) | `apps/frontend/src/stores/board.store.ts` |
| `POST /projects/:id/tasks` | `create_task` | Create a task (name resolvers) | `apps/frontend/src/hooks/use-tasks.ts` |
| `GET /projects/:id/tasks` | `search_tasks` | List/filter tasks in a project | `apps/frontend/src/hooks/use-tasks.ts` |
| `GET /tasks/:id` | `get_task` | Get one task | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `PATCH /tasks/:id` | `update_task` | Update a task (name resolvers) | `apps/frontend/src/components/board/task-context-menu.tsx` |
| `DELETE /tasks/:id` | `delete_task` | Delete a task (confirm) | `apps/frontend/src/components/board/task-context-menu.tsx` |
| `GET /tasks/:id/parents` | `bam_list_task_parents` | List a task's parents | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `POST /tasks/:id/parents` | `bam_add_task_parent` | Attach a parent (m:n link) | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `DELETE /tasks/:id/parents/:parentId` | `bam_remove_task_parent` | Remove a parent link | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `GET /tasks/:id/subtasks` | `bam_list_task_subtasks` | List a task's subtasks | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `POST /tasks/:id/move` | `move_task` | Move task to phase/position | `apps/frontend/src/hooks/use-tasks.ts` |
| `POST /tasks/:id/duplicate` | `duplicate_task` | Duplicate a task (+subtasks) | `apps/frontend/src/pages/board.tsx` |
| `GET /tasks/by-ref/:ref` | `bam_get_task_by_human_id` | Resolve human ref (FRND-42) | `apps/frontend/src/pages/task-ref-resolver.tsx` |
| `POST /tasks/bulk` | `bulk_update_tasks` | Bulk update/move/assign/delete | `apps/frontend/src/components/board/task-context-menu.tsx` |
| `POST /v1/tasks/upsert-by-external-id` | `task_upsert_by_external_id` | Idempotent upsert by external_id | — |
| — *(composite)* | `get_my_tasks` | Fetches `/auth/me` then `/projects/:id/tasks` | `apps/frontend/src/pages/my-work.tsx` |


## Bam — Sprints
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `sprint-tools.ts`, `report-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects/:id/sprints` | `list_sprints` | List a project's sprints | `apps/frontend/src/hooks/use-sprints.ts` |
| `POST /projects/:id/sprints` | `create_sprint` | Create a sprint | `apps/frontend/src/hooks/use-sprints.ts` |
| `GET /sprints/:id` | `get_sprint` | Get one sprint | `apps/frontend/src/hooks/use-sprints.ts` |
| `PATCH /sprints/:id` | `update_sprint` | Update sprint fields | `apps/frontend/src/hooks/use-sprints.ts` |
| `POST /sprints/:id/start` | `start_sprint` | Start a planned sprint | `apps/frontend/src/hooks/use-sprints.ts` |
| `POST /sprints/:id/complete` | `complete_sprint` | Complete sprint + carry-forward | `apps/frontend/src/components/board/carry-forward-dialog.tsx` |
| `POST /sprints/:id/cancel` | `cancel_sprint` | Cancel sprint, dump tasks to backlog | `apps/frontend/src/hooks/use-sprints.ts` |
| `GET /sprints/:id/report` | `get_sprint_report` / `get_burndown` | Sprint summary + burndown | `apps/frontend/src/pages/sprint-report.tsx` |


## Bam — Epics
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `epic-tools.ts`, `bam-resolver-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects/:id/epics` | `bam_list_epics` | List epics with task counts | `apps/frontend/src/components/board/epic-manager.tsx` |
| `POST /projects/:id/epics` | `bam_create_epic` | Create an epic | `apps/frontend/src/components/board/epic-manager.tsx` |
| `GET /epics/:id` | `bam_get_epic` | Get epic + rollup | `apps/frontend/src/pages/epic-detail.tsx` |
| `GET /epics/:id/tasks` | `bam_list_epic_tasks` | List tasks linked to epic | `apps/frontend/src/pages/epic-detail.tsx` |
| `PATCH /epics/:id` | `bam_update_epic` | Update/close an epic | `apps/frontend/src/pages/epic-detail.tsx` |
| `DELETE /epics/:id` | `bam_delete_epic` | Delete an epic | `apps/frontend/src/components/board/epic-manager.tsx` |


## Bam — Comments & Reactions
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `comment-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /tasks/:id/comments` | `list_comments` | List comments on a task | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `POST /tasks/:id/comments` | `add_comment` | Add a comment (accepts human_id) | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `PATCH /comments/:id` | `edit_comment` | Edit own comment (revisioned) | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `GET /comments/:id/revisions` | `list_comment_revisions` | Comment edit history | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `DELETE /comments/:id` | `delete_comment` | Delete own comment | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `POST /comments/:id/reactions` | `toggle_comment_reaction` | Toggle an emoji reaction | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `GET /comments/:id/reactions` | `list_comment_reactions` | List reactions grouped by emoji | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |


## Bam — Time tracking
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `task-tools.ts`, `report-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /tasks/:id/time-entries` | `log_time` | Log time on a task | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `GET /tasks/:id/time-entries` | `list_task_time_entries` | List a task's time entries | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `GET /me/time-entries` | `get_my_time_entries` | List own time entries (date range) | — |
| `GET /projects/:id/reports/time-tracking` | `get_time_tracking_report` | Per-user time aggregation | `apps/frontend/src/pages/project-reports.tsx` |


## Bam — Templates
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `template-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects/:id/task-templates` | `list_templates` | List project task templates | `apps/frontend/src/components/tasks/template-manager.tsx` |
| `POST /projects/:id/task-templates` | `create_template` | Create a task template | `apps/frontend/src/components/tasks/template-manager.tsx` |
| `POST /projects/:id/task-templates/:templateId/apply` | `create_from_template` | Create a task from a template | `apps/frontend/src/components/tasks/template-picker.tsx` |
| `DELETE /task-templates/:id` | `delete_template` | Delete a task template | `apps/frontend/src/components/tasks/template-manager.tsx` |


## Bam — Custom fields / Labels / Phases / States
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `bam-resolver-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects/:id/custom-fields` | `list_custom_fields` | List project custom-field defs | `apps/frontend/src/components/board/custom-field-manager.tsx` |
| `POST /projects/:id/custom-fields` | `create_custom_field` | Create a custom-field def | `apps/frontend/src/components/board/custom-field-manager.tsx` |
| `PATCH /custom-fields/:id` | `update_custom_field` | Update a custom-field def | `apps/frontend/src/components/board/custom-field-manager.tsx` |
| `DELETE /custom-fields/:id` | `delete_custom_field` | Delete a custom-field def | `apps/frontend/src/components/board/custom-field-manager.tsx` |
| `GET /labels` | `bam_list_labels` | Org-wide label list (no project_id) | — |
| `GET /projects/:id/labels` | `bam_list_labels` | Project label list | `apps/frontend/src/pages/board.tsx` |
| `POST /projects/:id/labels` | `create_label` | Create a label | `apps/frontend/src/pages/board.tsx` |
| `PATCH /labels/:id` | `update_label` | Update a label | `apps/frontend/src/pages/board.tsx` |
| `DELETE /labels/:id` | `delete_label` | Delete a label | `apps/frontend/src/pages/board.tsx` |
| `GET /projects/:id/phases` | `bam_list_phases` | List phases (board columns) | `apps/frontend/src/components/board/phase-manager.tsx` |
| `POST /projects/:id/phases` | `create_phase` | Create a phase | `apps/frontend/src/components/board/phase-manager.tsx` |
| `POST /projects/:id/phases/reorder` | `reorder_phases` | Reorder phases | `apps/frontend/src/components/board/phase-manager.tsx` |
| `PATCH /phases/:id` | `update_phase` | Update a phase | `apps/frontend/src/components/board/phase-manager.tsx` |
| `DELETE /phases/:id` | `delete_phase` | Delete phase (optional migrate) | `apps/frontend/src/components/board/phase-manager.tsx` |
| `GET /projects/:id/states` | `bam_list_states` | List task states | `apps/frontend/src/pages/board.tsx` |


## Bam — Reports & Analytics
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `report-tools.ts`, `phrase-count-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects/:id/reports/burndown` | `get_burndown` | Sprint burndown data | `apps/frontend/src/pages/project-reports.tsx` |
| `GET /projects/:id/reports/cfd` | `get_cumulative_flow` | Cumulative flow diagram | `apps/frontend/src/pages/project-reports.tsx` |
| `GET /projects/:id/reports/cycle-time` | `get_cycle_time_report` | Lead/cycle time per task | `apps/frontend/src/pages/project-reports.tsx` |
| `GET /projects/:id/reports/overdue` | `get_overdue_tasks` | Overdue task report | `apps/frontend/src/pages/project-dashboard.tsx` |
| `GET /projects/:id/reports/status-distribution` | `get_status_distribution` | Counts by phase/priority/state | `apps/frontend/src/pages/project-dashboard.tsx` |
| `GET /projects/:id/reports/time-tracking` | `get_time_tracking_report` | Per-user time aggregation | `apps/frontend/src/pages/project-reports.tsx` |
| `GET /projects/:id/reports/velocity` | `get_velocity_report` | Velocity over recent sprints | `apps/frontend/src/pages/project-reports.tsx` |
| `GET /projects/:id/reports/workload` | `get_workload` | Per-assignee workload | `apps/frontend/src/components/views/workload-view.tsx` |
| `GET /v1/tasks/analytics/count-by-phrase` | `bam_task_count_by_phrase` | Task phrase trend buckets | — |


## Bam — Attachments / Uploads / Version

> **⚠ No MCP tools in this section — intentional.** Binary file upload/download and version-blob endpoints. Agents never move binary payloads over MCP — they reference existing files via the cross-cutting `attachment_get` / `attachment_list` tools. Out of scope by design.
- **Service:** `apps/api` · external `/b3/api/` (uploads/files at `/files/`) · MCP module(s): none in scope

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /tasks/:id/attachments` | — _(skip: multipart upload)_ | Attach a file record to a task | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `GET /tasks/:id/attachments` | — _(skip: covered by cross-app `attachment_list`)_ | List a task's attachments | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `DELETE /attachments/:id` | — _(skip: binary/attachment lifecycle)_ | Delete an attachment | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `POST /upload` | — _(skip: multipart binary upload)_ | Multipart upload to MinIO | `apps/frontend/src/components/common/image-upload.tsx` |
| `GET /files/*` | — _(skip: binary download proxy)_ | Proxy file download from MinIO | `apps/frontend/src/components/common/image-upload.tsx` |
| `GET /version` | — _(skip: build/version probe, not agent surface)_ | Public version info | `apps/frontend/src/hooks/use-version.ts` |
| `POST /version/check` | — _(skip: SuperUser break-glass)_ | Force version check (SuperUser) | — |


## Bam — Import
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `import-tools.ts`, `task-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /projects/:id/import/csv` | `import_csv` / `bam_import_csv` | Commit CSV import | `apps/frontend/src/components/import/import-dialog.tsx` |
| `POST /projects/:id/import/csv/preview` | `bam_import_csv` *(dry_run)* | Dry-run CSV import (writes nothing) | `apps/frontend/src/components/import/import-dialog.tsx` |
| `POST /projects/:id/import/github` | `import_github_issues` | Import GitHub issues as tasks | `apps/frontend/src/components/import/import-dialog.tsx` |
| `POST /projects/:id/import/jira` | `import_jira` | Import Jira export rows | `apps/frontend/src/components/import/import-dialog.tsx` |
| `POST /projects/:id/import/trello` | `import_trello` | Import Trello board JSON | `apps/frontend/src/components/import/import-dialog.tsx` |
| — *(composite)* | `suggest_branch_name` | Fetches `/tasks/:id`, slugifies a branch name | — |

### Saved views

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects/:id/views` | `list_views` | List a project's saved views (own + shared) | — |
| `POST /projects/:id/views` | `create_view` | Create a saved view (filters/sort/swimlane/type) | — |
| `PATCH /views/:id` | `update_view` | Update a saved view | — |
| `DELETE /views/:id` | `delete_view` | Delete a saved view | — |


---

### Notes on shared/composite tools (counted once, in the section above)
- `get_my_tasks` (member-tools.ts) — composite: `GET /auth/me` then optionally
  `GET /projects/:id/tasks` filtered by `assignee_id`. Listed under Tasks.
- `suggest_branch_name` (import-tools.ts) — client-side: reads `GET /tasks/:id`
  and computes a branch slug; no write. Listed under Import.
- `get_burndown` and `get_sprint_report` both back `GET /sprints/:id/report`
  (same endpoint, two tools). Counted on that row in Sprints.
- `import_csv` (legacy, task-tools.ts) and `bam_import_csv` (import-tools.ts)
  both target `POST /projects/:id/import/csv`; `bam_import_csv` additionally
  hits the `/preview` endpoint when `dry_run:true` and stages a confirm_action
  token for `duplicate_strategy:'update'`.
- `bam_list_labels` backs both `GET /labels` (no project_id) and
  `GET /projects/:id/labels`; counted once as a tool in the Fields section.
- Confirm-flow tool `confirm_action` (utility-tools.ts) is cross-cutting, not a
  Bam work-management endpoint, and is owned by the platform/cross-cutting map.

## Bam — Org / Auth / Admin / Integrations (REST ↔ MCP map)

Scope: Bam `apps/api` org / auth / admin / integrations surface. External prefix `/b3/api/`.
MCP tool modules in scope: `me-tools`, `member-tools`, `user-resolver-tools`, `platform-tools`.

## Bam — Org & Members
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `member-tools`, `user-resolver-tools`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /org` | `get_my_org` | Get current org + member/owner counts | `apps/frontend/src/lib/api/people.ts` |
| `PATCH /org` | — _(skip: org settings/branding admin — conservative scope)_ | Update org name/logo/settings | `apps/frontend/src/pages/settings.tsx` |
| `GET /org/smtp-settings` | — _(skip: org SMTP admin — secret-bearing config, password-masked, UI-only)_ | Read org SMTP override (masked) | `apps/frontend/src/components/settings/org-smtp-settings-form.tsx` |
| `PUT /org/smtp-settings` | — _(skip: org SMTP admin — secret-bearing config, UI-only)_ | Set org SMTP override | `apps/frontend/src/components/settings/org-smtp-settings-form.tsx` |
| `DELETE /org/smtp-settings` | — _(skip: org SMTP admin — secret-bearing config, UI-only)_ | Clear org SMTP override (revert to platform) | `apps/frontend/src/components/settings/org-smtp-settings-form.tsx` |
| `POST /org/smtp-settings/test` | — _(skip: org SMTP admin — verify/send, UI-only)_ | Verify org-effective SMTP relay | `apps/frontend/src/components/settings/org-smtp-settings-form.tsx` |
| `GET /org/launchpad-apps` | — _(skip: resolver; `set_org_launchpad_apps` covers the override)_ | Get org Launchpad override + platform default | `apps/frontend/src/pages/settings.tsx` |
| `PUT /org/launchpad-apps` | `set_org_launchpad_apps` | Set/clear org Launchpad override | `apps/frontend/src/pages/settings.tsx` |
| `GET /org/members` | `list_members` | List org members (guest-scoped subset) | `apps/frontend/src/pages/people/index.tsx` |
| `PATCH /org/members/:userId` | `bam_update_member_role` | Update member org role | `apps/frontend/src/pages/people/detail.tsx` |
| `DELETE /org/members/:userId` | `bam_remove_member_from_org` | Remove member from org | `apps/frontend/src/pages/people/detail.tsx` |
| `GET /org/members/:userId` | `bam_get_org_member` | Get member detail | `apps/frontend/src/pages/people/detail.tsx` |
| `GET /org/members/:userId/activity` | `bam_get_member_activity` | Member activity feed (paginated) | `apps/frontend/src/pages/people/detail.tsx` |
| `GET /org/members/:userId/api-keys` | — _(skip: raw credential/API-key admin)_ | List a member's API keys | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/api-keys` | — _(skip: raw credential/API-key admin)_ | Create API key for a member | `apps/frontend/src/pages/people/detail.tsx` |
| `DELETE /org/members/:userId/api-keys/:keyId` | — _(skip: raw credential/API-key admin)_ | Revoke a member's API key | `apps/frontend/src/pages/people/detail.tsx` |
| `GET /org/members/:userId/deletion-eligibility` | — _(skip: SuperUser/account-deletion admin — conservative scope)_ | Probe admin account-deletion eligibility | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/delete-account` | — _(skip: SuperUser/account-deletion admin — conservative scope)_ | Cross-org soft-delete of an account | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/force-password-change` | — _(skip: credential/permission admin — conservative scope)_ | Force password change on next login | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/reset-ftue` | — _(skip: permission/account admin — conservative scope)_ | Reset a member's welcome tour (FTUE) so it re-fires on next login | `apps/frontend/src/pages/people-manager/detail.tsx` |
| `GET /org/members/:userId/projects` | `bam_list_member_projects` | List member's projects in org | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/projects` | `bam_add_member_to_projects` | Add member to projects | `apps/frontend/src/pages/people/detail.tsx` |
| `PATCH /org/members/:userId/projects/:projectId` | — _(skip: member/project-role admin — conservative scope)_ | Update member's project role | `apps/frontend/src/pages/people/detail.tsx` |
| `DELETE /org/members/:userId/projects/:projectId` | — _(skip: member/project-role admin — conservative scope)_ | Remove member from a project | `apps/frontend/src/pages/people/detail.tsx` |
| `PATCH /org/members/:userId/active` | — _(skip: account enable/disable admin — conservative scope)_ | Enable/disable a member | `apps/frontend/src/pages/people/detail.tsx` |
| `PATCH /org/members/:userId/email` | — _(skip: email verification admin — confirm-at-new-address, conservative scope)_ | Initiate member email change (stages `pending_email`, emails link) | `apps/frontend/src/pages/people/detail.tsx` |
| `PATCH /org/members/:userId/profile` | — _(skip: member-profile admin — conservative scope)_ | Update member display name/timezone | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/reset-password` | `bam_admin_reset_password` | Reset member password, return new value | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/send-password-reset` | `bam_send_password_reset_link` | Email member a reset link | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/sign-out-everywhere` | — _(skip: session/credential admin — conservative scope)_ | Revoke all member sessions | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/transfer-ownership` | — _(skip: ownership/permission admin — conservative scope)_ | Transfer org ownership to member | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/invite` | `bam_invite_member` | Invite/add a member to the org | `apps/frontend/src/pages/people/index.tsx` |
| `POST /org/members/invite/bulk` | — _(skip: bulk member admin — conservative scope)_ | Bulk-invite up to 100 members | `apps/frontend/src/pages/people/import-members-dialog.tsx` |
| `GET /users` | `list_users` | List active users in active org | `apps/frontend/src/lib/api/people.ts` |
| `GET /users/by-email` | `find_user_by_email` · `bam_find_user_by_email` | Find user by exact email | — |
| `GET /users/search` | `find_user_by_name` · `bam_find_user` | Fuzzy-search users by name/email | `apps/frontend/src/pages/people/index.tsx` |


### People Manager v2

Scoped, permission-graded, **multi-org** people surface (plan `docs/plans/user-manager-v2.md` §6, milestone M1). Unlike `GET /org/members` (single active org), this returns the union of members across every org the caller belongs to (SuperUsers see all non-deleted orgs), deduped, with per-(person, org) capability flags computed server-side. Visibility is scoped: a caller never sees a person who shares no org with them.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /people` | `bam_list_people` | Scoped multi-org people list with per-(person,org) capability flags (search / is_active / role / org_id filters, cursor pagination). Pass `user_id` to fetch a single in-scope person (out-of-scope `user_id` → empty) | People Manager v2 roster (`/b3/people-manager`) + detail page (`/b3/people-manager/:userId`, via `user_id`) |


## Bam — Auth & Sessions
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `me-tools`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /auth/me` | `get_me` | Current user + permission matrix | `apps/frontend/src/lib/api/*` (auth) |
| `PATCH /auth/me` | `update_me` | Update own profile fields (incl. `avatar_url`: an `/avatars/…` default or `/files/…` upload path) | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/me/avatar` | — _(skip: multipart binary upload)_ | Upload a profile picture; stores in MinIO and sets `users.avatar_url` | `apps/frontend/src/components/settings/avatar-picker.tsx` |
| `GET /auth/orgs` | `list_my_orgs` | List caller's org memberships | `apps/frontend/src/components/layout/org-switcher.tsx` |
| `POST /auth/bootstrap` | — _(skip: first-run auth bootstrap)_ | First-run SuperUser/org bootstrap | `apps/frontend/src/pages/*bootstrap*` |
| `POST /auth/change-password` | `change_my_password` | Change own password | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/login` | — _(skip: auth/session)_ | Password (+TOTP) login, sets cookie | `apps/frontend/src/pages/login.tsx` |
| `POST /auth/logout` | `logout` | Invalidate cookie session | `apps/frontend/src/components/layout/app-layout.tsx` |
| `POST /auth/me/email` | — _(skip: auth/email verification — self-service, confirm-at-new-address)_ | Initiate self email change (stages `pending_email`, emails link) | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/password-reset/consume` | — _(skip: auth/credential)_ | Consume reset token, set password | `apps/frontend/src/pages/password-reset.tsx` |
| `POST /auth/password-reset/request` | — _(skip: auth/credential)_ | Request self-serve reset email (opaque) | `apps/frontend/src/pages/login.tsx` |
| `POST /auth/register` | — _(skip: public-inbound signup)_ | Public signup (kill-switchable) | `apps/frontend/src/pages/login.tsx` |
| `POST /auth/switch-org` | `switch_active_org` | Switch active org, rotate session | `apps/frontend/src/components/layout/org-switcher.tsx` |
| `POST /auth/verify-email/:token` | — _(skip: auth/email verification)_ | Finalize email-change verification | `apps/frontend/src/pages/*verify*` |


## Bam — Notifications (me)
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `me-tools`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /me/notifications` | `list_my_notifications` | Caller's notification feed | `apps/frontend/src/components/layout/app-layout.tsx` |
| `POST /me/notifications/:id/read` | `mark_notification_read` | Mark one notification read | `apps/frontend/src/components/layout/app-layout.tsx` |
| `POST /me/notifications/mark-all-read` | `mark_all_notifications_read` | Mark all notifications read | `apps/frontend/src/components/layout/app-layout.tsx` |
| `POST /me/notifications/mark-read` | `mark_notifications_read` | Mark several notifications read | `apps/frontend/src/components/layout/app-layout.tsx` |


## Bam — OAuth / SSO

> **⚠ No MCP tools in this section — intentional.** OAuth provider connect / authorize / callback / link are browser-redirect credential flows with no agent-usable surface.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /auth/oauth/providers` | — _(skip: OAuth/SSO)_ | List enabled OAuth providers | `apps/frontend/src/pages/login.tsx` |
| `GET /auth/oauth/:provider/authorize` | — _(skip: OAuth/SSO)_ | Build provider authorize URL + state | `apps/frontend/src/pages/login.tsx` |
| `POST /auth/oauth/:provider/callback` | — _(skip: OAuth/SSO callback)_ | Exchange code, sign in or create user | `apps/frontend/src/pages/login.tsx` |
| `POST /auth/oauth/:provider/link` | — _(skip: OAuth/SSO link)_ | Link external account to current user | `apps/frontend/src/pages/settings.tsx` |


## Bam — Guests

> **⚠ No MCP tools in this section — intentional.** Guest-invitation issuance and the public accept-token flow — a credential/invite surface handled in the UI.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/guests` | — _(skip: guest/access admin — conservative scope)_ | List guest users in org | `apps/frontend/src/pages/people/index.tsx` |
| `DELETE /v1/guests/:id` | — _(skip: guest/access admin — conservative scope)_ | Remove/deactivate a guest | `apps/frontend/src/pages/people/detail.tsx` |
| `PATCH /v1/guests/:id/scope` | — _(skip: guest/access admin — conservative scope)_ | Update guest project/channel access | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /v1/guests/accept/:token` | — _(skip: public-inbound invite accept)_ | Public: accept invitation, create guest | `apps/frontend/src/pages/guest-accept.tsx` |
| `POST /v1/guests/invite` | — _(skip: guest/access admin — conservative scope)_ | Create a guest invitation | `apps/frontend/src/pages/people/index.tsx` |
| `GET /v1/guests/invitations` | — _(skip: guest/access admin — conservative scope)_ | List pending guest invitations | `apps/frontend/src/pages/people/index.tsx` |
| `DELETE /v1/guests/invitations/:id` | — _(skip: guest/access admin — conservative scope)_ | Revoke a guest invitation | `apps/frontend/src/pages/people/index.tsx` |
| `POST /v1/guests/invitations/:id/resend` | — _(skip: guest/access admin — conservative scope)_ | Re-send guest invitation email | `apps/frontend/src/pages/people/index.tsx` |


## Bam — Platform / SuperUser org & user admin

> **⚠ No MCP tools in this section — intentional.** Almost entirely SuperUser break-glass — impersonation, cross-org user/session/membership admin, platform audit. Intentionally UI/CLI-only; the few mapped rows are basic org reads.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `platform-tools`

Covers `platform.routes.ts` (`/v1/platform/*`) and `superuser.routes.ts` (`/superuser/*`, mounted under that prefix).

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /audit-log` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | SuperUser audit trail (filtered) | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /beta-signups` | `list_beta_signups` | List public beta-gate signups | `apps/frontend/src/pages/superuser/index.tsx` |
| `POST /context/clear` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Clear SuperUser active-org context | `apps/frontend/src/lib/api/superuser.ts` |
| `POST /context/switch` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Switch SuperUser into an org context | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /organizations` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | SuperUser org list (cursor-paginated) | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /organizations/:id` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | SuperUser org detail + activity | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /overview` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Platform-wide stat counters | `apps/frontend/src/pages/superuser/index.tsx` |
| `GET /platform-settings` | `get_platform_settings` | Read signup kill-switch flags | `apps/frontend/src/pages/superuser/index.tsx` |
| `PATCH /platform-settings` | `set_public_signup_disabled` · `set_helpdesk_signup_disabled` | Toggle signup kill-switches | `apps/frontend/src/pages/superuser/index.tsx` |
| `GET /superuser/calling-credentials` | — _(skip: LiveKit/voice credentials — UI/CLI-only)_ | LiveKit/voice provider config summary | `apps/frontend/src/pages/superuser/platform-calling-settings.tsx` |
| `GET /users` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | SuperUser user list (filtered) | `apps/frontend/src/lib/api/superuser-users.ts` |
| `GET /users/:id` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | SuperUser user detail | `apps/frontend/src/lib/api/superuser-users.ts` |
| `DELETE /users/:id` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | SuperUser soft-delete an account | `apps/frontend/src/lib/api/superuser-users.ts` |
| `PATCH /users/:id/active` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Enable/disable a user | `apps/frontend/src/lib/api/superuser-users.ts` |
| `PATCH /users/:id/email` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Initiate email change for a user | `apps/frontend/src/lib/api/superuser-users.ts` |
| `GET /users/:id/login-history` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | User login history (paginated) | `apps/frontend/src/lib/api/superuser-users.ts` |
| `POST /users/:id/memberships` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Add user org membership | `apps/frontend/src/lib/api/superuser-users.ts` |
| `DELETE /users/:id/memberships/:orgId` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Remove user org membership | `apps/frontend/src/lib/api/superuser-users.ts` |
| `PATCH /users/:id/memberships/:orgId` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Change user's org membership role | `apps/frontend/src/lib/api/superuser-users.ts` |
| `GET /users/:id/projects` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | List a user's projects | `apps/frontend/src/lib/api/superuser-users.ts` |
| `POST /users/:id/set-default-org` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Set user's default org | `apps/frontend/src/lib/api/superuser-users.ts` |
| `GET /users/:id/sessions` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | List user sessions | `apps/frontend/src/lib/api/superuser-users.ts` |
| `DELETE /users/:id/sessions/:sessionId` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Revoke one user session | `apps/frontend/src/lib/api/superuser-users.ts` |
| `POST /users/:id/sessions/revoke-all` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Revoke all user sessions | `apps/frontend/src/lib/api/superuser-users.ts` |
| `GET /v1/platform/audit-log` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Platform-admin audit trail | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /v1/platform/impersonation-sessions` | — _(skip: SuperUser impersonation (break-glass) — UI/CLI-only)_ | List active impersonations | `apps/frontend/src/lib/api/superuser.ts` |
| `POST /v1/platform/impersonate` | — _(skip: SuperUser impersonation (break-glass) — UI/CLI-only)_ | Start impersonating a user | `apps/frontend/src/lib/api/superuser.ts` |
| `POST /v1/platform/stop-impersonation` | — _(skip: SuperUser impersonation (break-glass) — UI/CLI-only)_ | Stop impersonating | `apps/frontend/src/components/layout/app-layout.tsx` |
| `GET /v1/platform/orgs` | `platform_list_orgs` | List all orgs (member counts) | `apps/frontend/src/lib/api/superuser.ts` |
| `POST /v1/platform/orgs` | `platform_create_org` | Create a new org | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /v1/platform/orgs/:id` | `platform_get_org` | Get org by id (member count) | `apps/frontend/src/lib/api/superuser.ts` |
| `PATCH /v1/platform/orgs/:id` | `platform_update_org` | Update org (rename regenerates slug) | `apps/frontend/src/lib/api/superuser.ts` |
| `DELETE /v1/platform/orgs/:id` | `platform_delete_org` | Soft-delete an org | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /v1/platform/orgs/:id/members` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | List members of any org | `apps/frontend/src/lib/api/superuser.ts` |
| `PATCH /v1/platform/users/:id/superuser` | — _(skip: SuperUser/platform admin — UI/CLI-only)_ | Toggle SuperUser flag | `apps/frontend/src/lib/api/superuser.ts` |


## Bam — Launchpad
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `platform-tools`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /launchpad/apps` | `get_launchpad_apps` | Resolved Launchpad app list for caller | `apps/frontend/src/components/layout/app-layout.tsx` |
| `PUT /system-settings/launchpad_default_apps` | `set_platform_launchpad_defaults` | Set/clear platform Launchpad default | `apps/frontend/src/pages/superuser/index.tsx` |


## Bam — System settings (SuperUser)

> **⚠ No MCP tools in this section — intentional.** SuperUser platform settings (SMTP, password policy, system config). UI/CLI-only; secret values are masked server-side.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /root-redirect` | — _(skip: public unauthenticated redirect route)_ | Public: resolve site root redirect/bootstrap | nginx/site redirect |
| `GET /system-settings` | — _(skip: SuperUser system settings — UI/CLI-only)_ | List all settings (secrets masked) | `apps/frontend/src/components/settings/smtp-settings-form.tsx` |
| `GET /system-settings/:key` | — _(skip: SuperUser system settings — UI/CLI-only)_ | Read one setting (secrets masked) | `apps/frontend/src/pages/superuser/platform-calling-settings.tsx` |
| `PUT /system-settings/:key` | `set_platform_launchpad_defaults`* | Update one setting (per-key validated) | `apps/frontend/src/components/settings/smtp-settings-form.tsx` |
| `POST /system-settings/password_policy/preview` | — _(skip: SuperUser system settings — UI/CLI-only)_ | Preview passwords from draft policy | `apps/frontend/src/components/superuser/password-policy-card.tsx` |
| `POST /system-settings/smtp/test` | — _(skip: SuperUser system settings — UI/CLI-only)_ | Verify/send SMTP test message | `apps/frontend/src/components/settings/smtp-settings-form.tsx` |

`*` `set_platform_launchpad_defaults` targets only the `launchpad_default_apps` key of `PUT /system-settings/:key`; no general-purpose system-settings tool exists. Counted as tool-less for the PUT row tally below.


## Bam — Deploy settings (SuperUser)

> **⚠ No MCP tools in this section — intentional.** SuperUser-only deploy configuration. UI/CLI-only by design.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /superuser/deploy/settings` | — _(skip: SuperUser deploy settings — UI/CLI-only)_ | Read deploy branch/repo/token/auto-update | `apps/frontend/src/lib/api/superuser-deploy.ts` |
| `PUT /superuser/deploy/settings` | — _(skip: SuperUser deploy settings — UI/CLI-only)_ | Write deploy settings (token tri-state) | `apps/frontend/src/components/superuser/deploy-settings-card.tsx` |
| `POST /superuser/deploy/verify-repo` | — _(skip: SuperUser deploy settings — UI/CLI-only)_ | Verify repo URL+token vs GitHub API | `apps/frontend/src/components/superuser/deploy-settings-card.tsx` |


## Bam — Permissions admin (SuperUser)

> **⚠ No MCP tools in this section — intentional.** The permissions-matrix governance surface — groups, overrides, divergences. Intentionally UI/CLI-only: agents are gated *by* these policies, they do not edit them.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

Covers `permissions-admin.routes.ts` and `permissions-divergences.routes.ts`.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /superuser/permissions/catalog` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Browse permission catalog (filtered) | `apps/frontend/src/lib/api/superuser-permissions.ts` |
| `GET /superuser/permissions/divergences` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Raw permission-divergence log (paginated) | `apps/frontend/src/pages/superuser/permissions-divergences.tsx` |
| `GET /superuser/permissions/divergences/summary` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Divergence summary by permission/route | `apps/frontend/src/pages/superuser/permissions-divergences.tsx` |
| `GET /superuser/permissions/groups` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | List permission groups + counts | `apps/frontend/src/pages/superuser/permissions/groups-list.tsx` |
| `POST /superuser/permissions/groups` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Create a permission group (clone) | `apps/frontend/src/pages/superuser/permissions/groups-list.tsx` |
| `GET /superuser/permissions/groups/:id` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Get group + defaults + member count | `apps/frontend/src/lib/api/superuser-permissions.ts` |
| `PATCH /superuser/permissions/groups/:id` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Rename/redescribe a group | `apps/frontend/src/lib/api/superuser-permissions.ts` |
| `DELETE /superuser/permissions/groups/:id` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Soft-delete a group (no live members) | `apps/frontend/src/pages/superuser/permissions/groups-list.tsx` |
| `PUT /superuser/permissions/groups/:id/defaults` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Set group defaults (glob set_true/false) | `apps/frontend/src/lib/api/superuser-permissions.ts` |
| `POST /superuser/permissions/groups/:id/reset` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Reset group defaults to baseline | `apps/frontend/src/lib/api/superuser-permissions.ts` |
| `GET /superuser/permissions/users/:id` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | User memberships/overrides/effective matrix | `apps/frontend/src/components/superuser/user-permissions-tab.tsx` |
| `PUT /superuser/permissions/users/:id/membership` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Assign user to group at scope | `apps/frontend/src/components/superuser/user-permissions-tab.tsx` |
| `PUT /superuser/permissions/users/:id/overrides/:permission_id` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Set explicit user permission override | `apps/frontend/src/components/superuser/user-permissions-tab.tsx` |
| `DELETE /superuser/permissions/users/:id/overrides/:permission_id` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Clear a user permission override | `apps/frontend/src/components/superuser/user-permissions-tab.tsx` |
| `POST /superuser/permissions/users/:id/reattach` | — _(skip: permissions-matrix admin — UI/CLI-only)_ | Reattach user at scope (factory reset) | `apps/frontend/src/components/superuser/user-permissions-tab.tsx` |


## Bam — Integrations: GitHub

> **⚠ No MCP tools in this section — intentional.** Per-project GitHub credential config plus the inbound webhook receiver — UI-only credential management / public-inbound.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /projects/:id/github-integration` | — _(skip: GitHub integration config — UI-only)_ | Get project GitHub integration config | `apps/frontend/src/pages/settings.tsx` |
| `PUT /projects/:id/github-integration` | — _(skip: GitHub integration config — UI-only)_ | Upsert GitHub integration (reveals secret) | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /projects/:id/github-integration` | — _(skip: GitHub integration config — UI-only)_ | Disconnect GitHub integration | `apps/frontend/src/pages/settings.tsx` |
| `GET /tasks/:id/github-refs` | — _(skip: GitHub integration config — UI-only)_ | List linked commits/PRs for a task | `apps/frontend/src/pages/*task*` |
| `POST /webhooks/github` | — _(skip: inbound webhook — public-inbound)_ | Public webhook ingest (HMAC-verified) | external (GitHub) |


## Bam — Integrations: Slack

> **⚠ No MCP tools in this section — intentional.** Per-project Slack credential config plus the inbound slash-command / webhook receiver — UI-only / public-inbound.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /projects/:id/slack-integration` | — _(skip: Slack integration config — UI-only)_ | Get project Slack integration config | `apps/frontend/src/pages/settings.tsx` |
| `PUT /projects/:id/slack-integration` | — _(skip: Slack integration config — UI-only)_ | Upsert Slack integration (SSRF-guarded) | `apps/frontend/src/pages/settings.tsx` |
| `POST /projects/:id/slack-integration/test` | — _(skip: Slack integration config — UI-only)_ | Send a Slack test message | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /projects/:id/slack-integration` | — _(skip: Slack integration config — UI-only)_ | Disconnect Slack integration | `apps/frontend/src/pages/settings.tsx` |
| `POST /webhooks/slack/command` | — _(skip: inbound webhook — public-inbound)_ | Public Slack slash-command handler | external (Slack) |


## Bam — Integrations: Webhooks

> **⚠ No MCP tools in this section — intentional.** Outbound-webhook configuration (admin). UI-only.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /projects/:id/webhooks` | — _(skip: outbound-webhook config — admin/UI-only)_ | List project outbound webhooks | `apps/frontend/src/pages/settings.tsx` |
| `POST /projects/:id/webhooks` | — _(skip: outbound-webhook config — admin/UI-only)_ | Create webhook (secret hashed, shown once) | `apps/frontend/src/pages/settings.tsx` |
| `PATCH /webhooks/:id` | — _(skip: outbound-webhook config — admin/UI-only)_ | Update webhook url/events/secret/active | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /webhooks/:id` | — _(skip: outbound-webhook config — admin/UI-only)_ | Delete a webhook | `apps/frontend/src/pages/settings.tsx` |


## Bam — Calendar / iCal

> **⚠ No MCP tools in this section — intentional.** Token-authed binary `.ics` feeds and feed-token issuance — not an agent-consumable surface. Use the Book MCP tools for calendar data.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /me/calendar.ics` | — _(skip: binary .ics feed (token-auth) — not an agent surface)_ | My assigned tasks as .ics (token or session) | `apps/frontend/src/components/views/calendar-export-menu.tsx` |
| `GET /projects/:id/calendar.ics` | — _(skip: binary .ics feed (token-auth) — not an agent surface)_ | Project tasks as .ics (authed) | `apps/frontend/src/components/views/calendar-export-menu.tsx` |
| `GET /projects/:id/calendar-tokens` | — _(skip: iCal feed token (credential) — not an agent surface)_ | List project public calendar tokens | `apps/frontend/src/components/views/calendar-export-menu.tsx` |
| `POST /projects/:id/calendar-tokens` | — _(skip: iCal feed token (credential) — not an agent surface)_ | Mint a public calendar token | `apps/frontend/src/components/views/calendar-export-menu.tsx` |
| `DELETE /projects/:id/calendar-tokens/:tokenId` | — _(skip: iCal feed token (credential) — not an agent surface)_ | Revoke a public calendar token | `apps/frontend/src/components/views/calendar-export-menu.tsx` |
| `GET /public/projects/:id/calendar.ics` | — _(skip: binary .ics feed (token-auth) — not an agent surface)_ | Public token-auth project .ics feed | external (calendar clients) |


## Bam — LLM providers

> **⚠ No MCP tools in this section — intentional.** Org LLM-provider credential management — API keys and connectivity tests. UI/CLI-only secret handling.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /llm-providers` | — _(skip: LLM provider credentials admin — UI/CLI-only)_ | List LLM providers visible to caller | `apps/frontend/src/hooks/use-llm-providers.ts` |
| `POST /llm-providers` | — _(skip: LLM provider credentials admin — UI/CLI-only)_ | Create scoped LLM provider (SSRF-guarded) | `apps/frontend/src/pages/settings-llm-providers.tsx` |
| `GET /llm-providers/resolve` | — _(skip: LLM provider credentials admin — UI/CLI-only)_ | Resolve effective provider for context | `apps/frontend/src/hooks/use-llm-providers.ts` |
| `GET /llm-providers/:id` | — _(skip: LLM provider credentials admin — UI/CLI-only)_ | Get LLM provider detail | `apps/frontend/src/pages/settings-llm-providers.tsx` |
| `PATCH /llm-providers/:id` | — _(skip: LLM provider credentials admin — UI/CLI-only)_ | Update LLM provider | `apps/frontend/src/pages/settings-llm-providers.tsx` |
| `DELETE /llm-providers/:id` | — _(skip: LLM provider credentials admin — UI/CLI-only)_ | Delete LLM provider | `apps/frontend/src/pages/settings-llm-providers.tsx` |
| `POST /llm-providers/:id/test` | — _(skip: LLM provider credentials admin — UI/CLI-only)_ | Test provider connectivity | `apps/frontend/src/pages/settings-llm-providers.tsx` |


## Bam — API keys & Service accounts

> **⚠ No MCP tools in this section — intentional.** Raw API-key / service-account secret issuance, rotation, and revocation — credential material. CLI/UI-only by design.
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /auth/api-keys` | — _(skip: raw credential/API-key secrets — CLI/UI-only)_ | List own API keys (prefix hint) | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/api-keys` | — _(skip: raw credential/API-key secrets — CLI/UI-only)_ | Create an API key (shown once) | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/api-keys/:id/rotate` | — _(skip: raw credential/API-key secrets — CLI/UI-only)_ | Rotate an API key (7-day grace) | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /auth/api-keys/:id` | — _(skip: raw credential/API-key secrets — CLI/UI-only)_ | Revoke own API key | `apps/frontend/src/pages/settings.tsx` |
| `GET /auth/service-accounts` | — _(skip: raw credential/API-key secrets — CLI/UI-only)_ | List caller-visible service accounts | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/service-accounts` | — _(skip: raw credential/API-key secrets — CLI/UI-only)_ | Mint service account + key (shown once) | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/service-accounts/:id/rotate` | — _(skip: raw credential/API-key secrets — CLI/UI-only)_ | Rotate a service-account key | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /auth/service-accounts/:id` | — _(skip: raw credential/API-key secrets — CLI/UI-only)_ | Soft-disable a service account | `apps/frontend/src/pages/settings.tsx` |


> The `/v1/agents/*` identity & heartbeat endpoints and their `agent_*` MCP tools are documented under **Cross-app → Agent identity, audit & heartbeat** below.

## Banter (app)

- **Service:** `apps/banter-api` · internal :4002 · external `/banter/api/` · MCP module(s): `banter-tools`, `banter-subscription-tools`

External URL = `/banter/api/` + the path column. WebSocket realtime at `/banter/ws` (no REST/MCP surface; broadcast-only). `confirm`/`confirm_action` flags on destructive tools are tool-side gates, not separate endpoints.

### Channels

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/channels` | `banter_list_channels` | List caller's channels with unread counts | `apps/banter/src/hooks/use-channels.ts` |
| `POST /v1/channels` | `banter_create_channel` | Create a channel | `apps/banter/src/components/sidebar/banter-sidebar.tsx` |
| `POST /v1/channels/bulk` | — _(skip: bulk-admin write — deferred)_ | Bulk-create up to 50 channels | `apps/banter/src/components/sidebar/bulk-create-channels-dialog.tsx` |
| `GET /v1/channels/browse` | `banter_browse_channels` | List public channels (incl. unjoined) | `apps/banter/src/pages/channel-browser.tsx` |
| `GET /v1/channels/by-name/:name` | `banter_get_channel_by_name` | Resolve channel by name/slug/handle | — |
| `GET /v1/channels/:id` | `banter_get_channel` | Channel detail (UUID or slug) | `apps/banter/src/hooks/use-channels.ts` |
| `PATCH /v1/channels/:id` | `banter_update_channel`, `banter_archive_channel` | Update settings / archive (`is_archived`) | `apps/banter/src/components/channels/channel-settings.tsx` |
| `DELETE /v1/channels/:id` | `banter_delete_channel` | Soft-delete (archive) channel | `apps/banter/src/components/channels/channel-settings.tsx` |
| `POST /v1/channels/:id/join` | `banter_join_channel` | Join a public channel | `apps/banter/src/hooks/use-channels.ts` |
| `POST /v1/channels/:id/leave` | `banter_leave_channel` | Leave a channel | `apps/banter/src/hooks/use-channels.ts` |
| `GET /v1/channels/:id/members` | `banter_list_channel_members` | List channel members | `apps/banter/src/hooks/use-channels.ts` |
| `POST /v1/channels/:id/members` | `banter_add_channel_members` | Add members | `apps/banter/src/components/channels/channel-settings.tsx` |
| `POST /v1/channels/bulk-add-members` | — _(skip: org-onboarding bulk action (org-admin/SU), UI-driven from Bam People Manager + invite flow; agents use banter_add_channel_members per channel)_ | Add many users to many channels at once | `apps/frontend/src/components/people/add-to-channels-dialog.tsx` |
| `DELETE /v1/channels/:id/members/:userId` | `banter_remove_channel_member` | Remove a member | `apps/banter/src/components/channels/channel-settings.tsx` |
| `PATCH /v1/channels/:id/members/:userId` | — _(skip: member-role admin — not wrapped)_ | Update member role | `apps/banter/src/hooks/use-channels.ts` |
| `POST /v1/channels/:id/mark-read` | `banter_mark_read` | Update last-read cursor | `apps/banter/src/hooks/use-unread.ts` |
| `GET /v1/admin/channel-groups` | — _(skip: org-admin sidebar config — UI-only)_ | List sidebar channel groups | `apps/banter/src/components/sidebar/banter-sidebar.tsx` |
| `POST /v1/admin/channel-groups` | — _(skip: org-admin sidebar config — UI-only)_ | Create a channel group | `apps/banter/src/pages/admin.tsx` |
| `GET /v1/admin/channel-groups/:id` | — _(skip: org-admin sidebar config — UI-only)_ | Get a channel group | `apps/banter/src/pages/admin.tsx` |
| `PATCH /v1/admin/channel-groups/:id` | — _(skip: org-admin sidebar config — UI-only)_ | Update a channel group | `apps/banter/src/pages/admin.tsx` |
| `DELETE /v1/admin/channel-groups/:id` | — _(skip: org-admin sidebar config — UI-only)_ | Delete a channel group | `apps/banter/src/pages/admin.tsx` |
| `POST /v1/admin/channel-groups/reorder` | — _(skip: org-admin sidebar config — UI-only)_ | Reorder channel groups | `apps/banter/src/components/sidebar/banter-sidebar.tsx` |


### Messages, threads, reactions, pins

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/channels/:id/messages` | `banter_list_messages` | List channel messages (cursor paginated) | `apps/banter/src/hooks/use-messages.ts` |
| `POST /v1/channels/:id/messages` | `banter_post_message`, `banter_schedule_post`, `banter_post_call_text`, `banter_share_task`, `banter_share_sprint`, `banter_share_ticket` | Post message; scheduling/quiet-hours; embeds | `apps/banter/src/components/messages/message-compose.tsx` |
| `GET /v1/messages/:id` | `banter_get_message` | Get a single message | `apps/banter/src/hooks/use-messages.ts` |
| `PATCH /v1/messages/:id` | `banter_edit_message` | Edit own message | `apps/banter/src/hooks/use-messages.ts` |
| `DELETE /v1/messages/:id` | `banter_delete_message` | Soft-delete message | `apps/banter/src/hooks/use-messages.ts` |
| `GET /v1/messages/:id/thread` | `banter_list_thread_replies` | List thread replies | `apps/banter/src/hooks/use-threads.ts` |
| `POST /v1/messages/:id/thread` | `banter_reply_to_thread` | Post a thread reply | `apps/banter/src/components/threads/thread-panel.tsx` |
| `POST /v1/messages/:id/reactions` | `banter_react` | Toggle an emoji reaction | `apps/banter/src/hooks/use-reactions.ts` |
| `GET /v1/messages/:id/reactions` | `banter_list_reactions` | List reactions grouped by emoji | `apps/banter/src/hooks/use-reactions.ts` |
| `GET /v1/channels/:id/pins` | `banter_list_pins` | List pinned messages | `apps/banter/src/components/messages/message-timeline.tsx` |
| `POST /v1/channels/:id/pins` | `banter_pin_message` | Pin a message | `apps/banter/src/components/messages/message-item.tsx` |
| `DELETE /v1/channels/:id/pins/:messageId` | `banter_unpin_message` | Unpin a message | `apps/banter/src/hooks/use-messages.ts` |
| `GET /v1/bookmarks` | `banter_list_bookmarks` | List caller's bookmarks | `apps/banter/src/pages/bookmarks.tsx` |
| `POST /v1/bookmarks` | `banter_create_bookmark` | Create a bookmark | `apps/banter/src/components/messages/message-item.tsx` |
| `DELETE /v1/bookmarks/by-message/:messageId` | `banter_delete_bookmark` | Remove bookmark by message id | `apps/banter/src/hooks/use-messages.ts` |
| `DELETE /v1/bookmarks/:id` | `banter_delete_bookmark` | Remove bookmark by id | `apps/banter/src/pages/bookmarks.tsx` |


### DMs

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/dm` | `banter_list_dms` | List caller's DMs and group DMs | `apps/banter/src/components/sidebar/banter-sidebar.tsx` |
| `POST /v1/dm` | `banter_send_dm` | Create/reuse a DM channel (then posts) | `apps/banter/src/components/common/user-profile-popover.tsx` |
| `POST /v1/group-dm` | `banter_send_group_dm` | Create/reuse a group DM (then posts) | `apps/banter/src/components/sidebar/banter-sidebar.tsx` |


### Calls & huddles

All write endpoints return HTTP 410 Gone (calling moved to the Bureau docked-box); only read endpoints remain.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `POST /v1/channels/:id/calls` | `banter_start_call` | Gone (410); was start call | — |
| `GET /v1/channels/:id/calls` | `banter_list_calls` | Call history for a channel | `apps/banter/src/hooks/use-call-history.ts` |
| `GET /v1/calls/:id` | `banter_get_call`, `banter_get_active_huddle` | Call detail w/ participants | `apps/banter/src/pages/call-playback.tsx` |
| `GET /v1/calls/:id/participants` | `banter_list_call_participants` | List call participants | `apps/banter/src/pages/call-playback.tsx` |
| `GET /v1/calls/:id/transcript` | `banter_get_transcript` | Historical transcript segments | `apps/banter/src/pages/call-playback.tsx` |
| `PATCH /v1/calls/:id` | — _(skip: live-call control; calling moved to Bureau)_ | Gone (410); was recording toggles | — |
| `POST /v1/calls/:id/join` | `banter_join_call` | Gone (410); was join call | — |
| `POST /v1/calls/:id/leave` | `banter_leave_call` | Gone (410); was leave call | — |
| `POST /v1/calls/:id/end` | `banter_end_call` | Gone (410); was end call | — |
| `POST /v1/calls/:id/invite-agent` | `banter_invite_agent_to_call` | Gone (410); was voice-agent invite | — |
| `POST /v1/calls/:id/remove-agent` | — _(skip: live-call control; calling moved to Bureau)_ | Gone (410); was voice-agent removal | — |
| `PATCH /v1/calls/:id/media-state` | — _(skip: live-call control; calling moved to Bureau)_ | Gone (410); was mute/cam/screenshare | — |
| `POST /v1/webhooks/livekit` | — _(skip: inbound LiveKit webhook (HMAC) — internal)_ | LiveKit room-event webhook (HMAC) | — *(LiveKit SFU)* |


### Users & user groups

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/users/by-email` | `banter_find_user_by_email` | Resolve user by email | — |
| `GET /v1/users/by-handle/:handle` | `banter_find_user_by_handle` | Resolve user by slugified handle | — |
| `GET /v1/users/search` | `banter_list_users` | Fuzzy user search in org | `apps/banter/src/components/common/user-profile-popover.tsx` |
| `GET /v1/user-groups` | `banter_list_user_groups` | List org user groups | `apps/banter/src/pages/admin.tsx` |
| `POST /v1/user-groups` | `banter_create_user_group` | Create a user group | `apps/banter/src/pages/admin.tsx` |
| `GET /v1/user-groups/by-handle/:handle` | `banter_get_user_group_by_handle` | Resolve group by handle | — |
| `PATCH /v1/user-groups/:id` | `banter_update_user_group` | Update a user group | `apps/banter/src/pages/admin.tsx` |
| `DELETE /v1/user-groups/:id` | `banter_delete_user_group` | Delete a user group | `apps/banter/src/pages/admin.tsx` |
| `POST /v1/user-groups/:id/members` | `banter_add_group_members` | Add group members | `apps/banter/src/pages/admin.tsx` |
| `GET /v1/user-groups/:id/members` | `banter_list_group_members` | List group members | `apps/banter/src/pages/admin.tsx` |
| `DELETE /v1/user-groups/:id/members/:userId` | `banter_remove_group_member` | Remove a group member | `apps/banter/src/pages/admin.tsx` |


### Preferences, presence & unread

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/me/preferences` | `banter_get_preferences` | Get caller's preferences | `apps/banter/src/pages/preferences.tsx` |
| `PATCH /v1/me/preferences` | `banter_update_preferences` | Update caller's preferences | `apps/banter/src/pages/preferences.tsx` |
| `GET /v1/me/unread` | `banter_get_unread` | Unread summary across channels | `apps/banter/src/hooks/use-unread.ts` |
| `GET /v1/me/presence` | `banter_get_presence` | Get caller's presence row | `apps/banter/src/hooks/use-presence.ts` |
| `POST /v1/me/presence` | `banter_set_presence` | Upsert caller's presence | `apps/banter/src/hooks/use-presence.ts` |
| `GET /v1/channels/:id/presence` | `banter_list_channel_presence` | List non-offline channel members | `apps/banter/src/hooks/use-presence.ts` |


### Search & link preview

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/search/channels` | `banter_search_channels` | Full-text channel name/topic search | `apps/banter/src/pages/search.tsx` |
| `GET /v1/search/messages` | `banter_search_messages` | Full-text message search | `apps/banter/src/pages/search.tsx` |
| `GET /v1/search/transcripts` | `banter_search_transcripts` | Full-text transcript search | `apps/banter/src/pages/search.tsx` |
| `GET /v1/link-preview` | — _(skip: outbound URL fetch, not an agent surface)_ | Fetch OG/Twitter card for a URL | `apps/banter/src/components/messages/link-preview.tsx` |


### Scheduling

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/channels/:id/scheduled-messages` | `banter_list_scheduled_messages` | List pending scheduled posts | — |
| `DELETE /v1/scheduled-messages/:id` | `banter_cancel_scheduled_message` | Cancel a pending scheduled post | — |


### Agent subscriptions

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/agent-subscriptions` | `banter_list_subscriptions` | List caller's pattern subscriptions | — |
| `DELETE /v1/agent-subscriptions/:sid` | `banter_unsubscribe_pattern` | Disable a subscription | — |
| `POST /v1/channels/:id/agent-subscriptions` | `banter_subscribe_pattern` | Create a pattern subscription | — |
| `GET /v1/channels/:id/agent-subscriptions` | `banter_list_subscriptions` | Channel-scoped "who's listening" (admin) | — |


### Admin settings & files

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/admin/settings` | — _(skip: org/provider-credential admin — UI-only)_ | Get org Banter settings (masked) | `apps/banter/src/pages/admin.tsx` |
| `PATCH /v1/admin/settings` | — _(skip: org/provider-credential admin — UI-only)_ | Update org Banter settings | `apps/banter/src/pages/admin.tsx` |
| `POST /v1/admin/settings/test-livekit` | — _(skip: org/provider-credential admin — UI-only)_ | Test LiveKit credentials | `apps/banter/src/pages/admin-calling-settings.tsx` |
| `POST /v1/admin/settings/test-stt` | — _(skip: org/provider-credential admin — UI-only)_ | Test STT provider connectivity | `apps/banter/src/pages/admin-calling-settings.tsx` |
| `POST /v1/admin/settings/test-tts` | — _(skip: org/provider-credential admin — UI-only)_ | Test TTS provider connectivity | `apps/banter/src/pages/admin-calling-settings.tsx` |
| `POST /v1/admin/settings/push-voice-config` | — _(skip: org/provider-credential admin — UI-only)_ | Push voice config to voice agent | `apps/banter/src/pages/admin-calling-settings.tsx` |
| `POST /v1/files/upload` | — _(skip: multipart binary upload)_ | Multipart upload to MinIO | `apps/banter/src/components/messages/message-compose.tsx` |
| `POST /v1/files/presigned-upload` | — _(skip: binary upload presign)_ | Generate a presigned PUT URL | `apps/banter/src/components/messages/message-compose.tsx` |


### Slack import (admin)

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `POST /v1/admin/import/slack/upload` | — _(skip: Slack-import wizard (admin) — UI-only)_ | Upload .zip, fast-scan preview | `apps/api` (Bam settings wizard via proxy) |
| `GET /v1/admin/import/slack/` | — _(skip: Slack-import wizard (admin) — UI-only)_ | List recent imports for the org | `apps/api` (Bam settings wizard via proxy) |
| `GET /v1/admin/import/slack/:id/preview` | — _(skip: Slack-import wizard (admin) — UI-only)_ | Full users/channels for the wizard | `apps/api` (Bam settings wizard via proxy) |
| `POST /v1/admin/import/slack/:id/start` | — _(skip: Slack-import wizard (admin) — UI-only)_ | Persist mapping, enqueue worker job | `apps/api` (Bam settings wizard via proxy) |
| `GET /v1/admin/import/slack/:id/status` | — _(skip: Slack-import wizard (admin) — UI-only)_ | Poll the durable import row | `apps/api` (Bam settings wizard via proxy) |
| `DELETE /v1/admin/import/slack/:id` | — _(skip: Slack-import wizard (admin) — UI-only)_ | Abort + cleanup | `apps/api` (Bam settings wizard via proxy) |


### Feed (ranked stream, subscriptions, weights)

Banter Feed (`docs/plans/banter-feed-design-document.md`). Ranked cross-app
stream + the default-on follow/mute hierarchy + two-level tunable weights.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/feed` | `banter_feed_query` | Ranked feed for the caller (read-time scoring) | `apps/banter/src/hooks/use-feed.ts` |
| `POST /v1/feed/seen` | `banter_feed_mark_seen` | Mark entries seen (id list or seq watermark) | `apps/banter/src/hooks/use-feed.ts` |
| `POST /v1/feed/:id/dismiss` | `banter_feed_dismiss` | Dismiss a single entry | `apps/banter/src/hooks/use-feed.ts` |
| `GET /v1/feed/:id` | `banter_feed_explain` | Single hydrated entry / permalink (+ score breakdown) | `apps/banter/src/pages/feed.tsx` |
| `GET /v1/feed/subscriptions` | `banter_feed_subscription_list` | List explicit opt-out rows | `apps/banter/src/hooks/use-feed.ts` |
| `PUT /v1/feed/subscriptions` | `banter_feed_subscription_set` | Follow/unfollow/mute a scope | `apps/banter/src/hooks/use-feed.ts` |
| `DELETE /v1/feed/subscriptions/:id` | — _(skip: covered by banter_feed_subscription_set — 'following' reverts to default)_ | Remove an explicit row | — |
| `GET /v1/channels/:id/follow` | — _(skip: UI convenience alias over subscriptions; MCP uses banter_feed_subscription_list)_ | Effective channel follow state | `apps/banter/src/components/channels/channel-follow-button.tsx` |
| `PUT /v1/channels/:id/follow` | — _(skip: UI convenience alias over subscriptions; MCP uses banter_feed_subscription_set)_ | Set channel follow/mute | `apps/banter/src/components/channels/channel-follow-button.tsx` |
| `GET /v1/feed/weights` | `banter_feed_weights_get` | Effective merged weights + raw overrides | `apps/banter/src/pages/feed-settings.tsx` |
| `PUT /v1/feed/weights/org` | `banter_feed_weights_set_org` | Set org weight overrides (admin) | `apps/banter/src/pages/feed-settings.tsx` |
| `PUT /v1/feed/weights/platform` | — _(skip: SuperUser break-glass — deliberately not agent-exposed)_ | Set platform default weights | `apps/banter/src/pages/feed-settings.tsx` |
| `POST /v1/feed/weights/preview` | — _(skip: UI live-preview dry-run; agents read via banter_feed_query/explain)_ | Re-score the caller's feed against proposed weights | `apps/banter/src/pages/feed-settings.tsx` |


### Internal (service-to-service)

X-Internal-Secret gated; not user-facing, no MCP tools.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `POST /v1/internal/dm` | — _(skip: internal service-to-service route)_ | Send a DM between two users (bureau) | — *(internal)* |
| `POST /v1/internal/feed` | — _(skip: internal service-to-service route)_ | Post an activity-feed message | — *(internal)* |
| `POST /v1/internal/share` | — _(skip: internal service-to-service route)_ | Share a Bam entity into a channel | — *(internal)* |
| `POST /v1/internal/transcript` | — _(skip: internal service-to-service route)_ | Receive one live transcript segment | — *(voice-agent)* |
| `POST /v1/internal/transcription-callback` | — _(skip: internal service-to-service route)_ | Batch offline transcription callback | — *(voice-agent)* |


## Beacon (app)

- **Service:** `apps/beacon-api` · external `/beacon/api/` (WS `/beacon/ws`) · MCP module(s): `apps/mcp-server/src/tools/beacon-tools.ts`

All routes are registered under the `/v1` prefix, so external paths are `/beacon/api/v1/<path>`. The MCP tools target the beacon-api base URL directly (paths shown below are the in-service paths). Beacon write tools accept a UUID/slug/title and resolve via `resolveBeaconId` before calling the path.

Realtime T4 co-editing of article bodies runs on a Yjs WebSocket at `/beacon/ws` (a `GET /ws` upgrade on beacon-api): `— _(skip: realtime/ws/Yjs — CRDT sync, not a wrapped tool)_`. The shared doc is a `Y.Text` of the markdown body, persisted to `beacon_entries.yjs_state` and materialized back to `body_markdown`.

### CRUD, lifecycle, versions

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /beacons` | `beacon_create` | Create a new Beacon (Draft) | `apps/beacon/src/hooks/use-beacons.ts` |
| `GET /beacons` | `beacon_list` | List Beacons with filters | `apps/beacon/src/hooks/use-beacons.ts` |
| `GET /beacons/by-slug/:slug` | — _(skip: slug resolver — done internally)_ | Resolve slug to Beacon (MCP resolver) | — |
| `GET /beacons/stats` | `beacon_stats` | Org-wide Beacon statistics | `apps/beacon/src/hooks/use-beacons.ts` |
| `GET /beacons/:id` | `beacon_get` | Get one Beacon by UUID or slug | `apps/beacon/src/hooks/use-beacons.ts` |
| `PUT /beacons/:id` | `beacon_update` | Update Beacon, creates new version | `apps/beacon/src/hooks/use-beacons.ts` |
| `DELETE /beacons/:id` | `beacon_retire` | Retire (soft-delete) a Beacon | `apps/beacon/src/hooks/use-beacons.ts` |
| `POST /beacons/:id/challenge` | `beacon_challenge` | Flag Beacon for review | `apps/beacon/src/hooks/use-beacons.ts` |
| `POST /beacons/:id/publish` | `beacon_publish` | Transition Draft to Active | `apps/beacon/src/hooks/use-beacons.ts` |
| `POST /beacons/:id/restore` | `beacon_restore` | Restore Archived Beacon to Active | `apps/beacon/src/hooks/use-beacons.ts` |
| `POST /beacons/:id/verify` | `beacon_verify` | Record a verification event | `apps/beacon/src/hooks/use-beacons.ts` |
| `GET /beacons/:id/versions` | `beacon_versions` | List Beacon version history | `apps/beacon/src/hooks/use-beacons.ts` |
| `GET /beacons/:id/versions/:v` | `beacon_version_get` | Get a specific Beacon version | `apps/beacon/src/hooks/use-beacons.ts` |
| `POST /entries/upsert` | `beacon_upsert_by_slug` | Idempotent create-or-update by slug | — |

### Tags, links, comments, attachments

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /tags` | `beacon_tags_list` | List tags in scope with counts | `apps/beacon/src/hooks/use-beacons.ts` |
| `POST /beacons/:id/tags` | `beacon_tag_add` | Add tags to a Beacon | — |
| `DELETE /beacons/:id/tags/:tag` | `beacon_tag_remove` | Remove a tag from a Beacon | — |
| `GET /beacons/:id/links` | `beacon_links_list` | List a Beacon's links | `apps/beacon/src/hooks/use-beacons.ts` |
| `POST /beacons/:id/links` | `beacon_link_create` | Create a typed link between Beacons | — |
| `DELETE /beacons/:id/links/:linkId` | `beacon_link_remove` | Remove a Beacon link | — |
| `GET /beacons/:id/comments` | `beacon_comments_list` | List comments on a Beacon | `apps/beacon/src/hooks/use-comments.ts` |
| `POST /beacons/:id/comments` | `beacon_comment_add` | Create a comment / reply | `apps/beacon/src/hooks/use-comments.ts` |
| `PUT /beacons/:id/comments/:commentId` | `beacon_comment_edit` | Edit own comment | — |
| `DELETE /beacons/:id/comments/:commentId` | `beacon_comment_delete` | Delete comment (author/admin) | `apps/beacon/src/hooks/use-comments.ts` |
| `GET /beacons/:id/attachments` | `beacon_attachments_list` | List attachments on a Beacon | `apps/beacon/src/hooks/use-attachments.ts` |
| `POST /beacons/:id/attachments` | — _(skip: multipart upload)_ | Multipart attachment upload | `apps/beacon/src/hooks/use-attachments.ts` |
| `DELETE /beacons/:id/attachments/:attachmentId` | `beacon_attachment_delete` | Delete an attachment | `apps/beacon/src/hooks/use-attachments.ts` |

### Search, saved queries, graph, policy

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /search` | `beacon_search` | Hybrid semantic + keyword + graph search | `apps/beacon/src/hooks/use-search.ts` |
| `POST /search/context` | `beacon_search_context` | Agent-optimized retrieval, linked Beacons | — |
| `GET /search/suggest` | `beacon_suggest` | Typeahead title/tag suggestions | `apps/beacon/src/hooks/use-search.ts` |
| `POST /search/saved` | `beacon_query_save` | Save a named search query | `apps/beacon/src/hooks/use-search.ts` |
| `GET /search/saved` | `beacon_query_list` | List saved queries in scope | `apps/beacon/src/hooks/use-search.ts` |
| `GET /search/saved/:id` | `beacon_query_get` | Get a saved query by ID | — |
| `DELETE /search/saved/:id` | `beacon_query_delete` | Delete a saved query | `apps/beacon/src/hooks/use-search.ts` |
| `GET /graph/hubs` | `beacon_graph_hubs` | Most-connected Beacons (hubs) | `apps/beacon/src/hooks/use-graph.ts` |
| `GET /graph/neighbors` | `beacon_graph_neighbors` | Nodes/edges within N hops of a Beacon | `apps/beacon/src/hooks/use-graph.ts` |
| `GET /graph/recent` | `beacon_graph_recent` | Recently modified/verified Beacons | `apps/beacon/src/hooks/use-graph.ts` |
| `GET /policies` | `beacon_policy_get` | Effective governance policy for scope | `apps/beacon/src/hooks/use-policies.ts` |
| `PUT /policies` | `beacon_policy_set` | Set/update governance policy | `apps/beacon/src/hooks/use-policies.ts` |
| `GET /policies/resolve` | `beacon_policy_resolve` | Preview merged effective policy | `apps/beacon/src/hooks/use-policies.ts` |


## Brief (app)

- **Service:** `apps/brief-api` · external `/brief/api/` (WS `/brief/ws`) · MCP module(s): `apps/mcp-server/src/tools/brief-tools.ts`

All routes are registered under the `/v1` prefix, so external paths are `/brief/api/v1/<path>`. Brief write tools accept a UUID/slug/title and resolve via `resolveDocumentId` before calling the path.

### Documents CRUD, content, lifecycle

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /documents` | `brief_create` | Create a new document | `apps/brief/src/hooks/use-documents.ts` |
| `GET /documents` | `brief_list` | List documents with filters | `apps/brief/src/hooks/use-documents.ts` |
| `GET /documents/recent` | `brief_recent` | Recently updated documents | `apps/brief/src/hooks/use-documents.ts` |
| `GET /documents/search` | `brief_search` | Full-text document search | `apps/brief/src/hooks/use-search.ts` |
| `GET /documents/semantic-search` | `brief_semantic_search` | Qdrant vector search (text fallback) | `apps/brief/src/hooks/use-search.ts` |
| `GET /documents/starred` | `brief_starred` | User's starred documents | `apps/brief/src/hooks/use-documents.ts` |
| `GET /documents/stats` | `brief_stats` | Org-wide document statistics | `apps/brief/src/hooks/use-documents.ts` |
| `GET /documents/by-slug/:slug` | — _(skip: slug resolver — done internally)_ | Resolve slug to document (MCP resolver) | — |
| `GET /documents/:id` | `brief_get` | Get one document by UUID or slug | `apps/brief/src/hooks/use-documents.ts` |
| `PATCH /documents/:id` | `brief_update` | Update document metadata | `apps/brief/src/hooks/use-documents.ts` |
| `DELETE /documents/:id` | `brief_archive` | Archive document (soft-delete) | `apps/brief/src/hooks/use-documents.ts` |
| `POST /documents/:id/append` | `brief_append_content` | Append Markdown to document | — |
| `POST /documents/:id/duplicate` | `brief_duplicate` | Duplicate a document | `apps/brief/src/hooks/use-documents.ts` |
| `POST /documents/:id/promote` | `brief_promote_to_beacon` | Graduate document to a Beacon | `apps/brief/src/hooks/use-documents.ts` |
| `POST /documents/:id/restore` | `brief_restore` | Restore an archived document | `apps/brief/src/hooks/use-documents.ts` |
| `POST /documents/:id/star` | `brief_star` | Toggle document star | `apps/brief/src/hooks/use-documents.ts` |
| `PUT /documents/:id/content` | `brief_update_content` | Replace entire document content | — |
| `GET /documents/:id/yjs-state` | — _(skip: Yjs sync state)_ | Fetch raw Yjs state (base64) | `apps/brief/src/hooks/use-collaboration.ts` |
| `PUT /documents/:id/yjs-state` | — _(skip: Yjs sync state)_ | Persist Yjs state snapshot | `apps/brief/src/hooks/use-collaboration.ts` |

### Comments, versions, links, collaborators, embeds, templates, folders, export

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /documents/:id/comments` | `brief_comment_list` | List threaded comments | `apps/brief/src/hooks/use-comments.ts` |
| `POST /documents/:id/comments` | `brief_comment_add` | Create a comment | `apps/brief/src/hooks/use-comments.ts` |
| `PATCH /comments/:commentId` | `brief_comment_edit` | Edit comment body | — |
| `DELETE /comments/:commentId` | `brief_comment_delete` | Delete a comment | `apps/brief/src/hooks/use-comments.ts` |
| `POST /comments/:commentId/resolve` | `brief_comment_resolve` | Toggle comment resolved state | `apps/brief/src/hooks/use-comments.ts` |
| `POST /comments/:commentId/reactions` | `brief_comment_react` | Add a comment reaction | — |
| `DELETE /comments/:commentId/reactions/:emoji` | `brief_comment_unreact` | Remove a comment reaction | — |
| `GET /documents/:id/versions` | `brief_versions` | List version history | `apps/brief/src/hooks/use-versions.ts` |
| `POST /documents/:id/versions` | `brief_version_create` | Create a named version snapshot | `apps/brief/src/hooks/use-versions.ts` |
| `GET /documents/:id/versions/:versionId` | `brief_version_get` | Get a specific version | — |
| `POST /documents/:id/versions/:versionId/restore` | `brief_version_restore` | Restore document to a version | `apps/brief/src/hooks/use-versions.ts` |
| `GET /documents/:id/versions/:v1/diff/:v2` | `brief_version_diff` | Diff two versions (LCS line diff) | — |
| `GET /documents/:id/links` | `brief_links_list` | List task + beacon links | `apps/brief/src/hooks/use-links.ts` |
| `POST /documents/:id/links/task` | `brief_link_task` | Link document to a Bam task | — |
| `POST /documents/:id/links/beacon` | `brief_link_beacon` | Link document to a Beacon | — |
| `DELETE /links/:linkId` | `brief_link_remove` | Delete a link (document_id query) | — |
| `GET /documents/:id/collaborators` | `brief_collaborators_list` | List collaborators | — |
| `POST /documents/:id/collaborators` | `brief_collaborator_add` | Add a collaborator | — |
| `PATCH /collaborators/:collabId` | `brief_collaborator_update` | Update collaborator permission | — |
| `DELETE /collaborators/:collabId` | `brief_collaborator_remove` | Remove a collaborator | — |
| `POST /documents/:id/embeds` | — _(skip: embed/upload metadata record)_ | Record embed/upload metadata | — |
| `GET /documents/:id/embeds` | `brief_embeds_list` | List embeds for a document | — |
| `DELETE /embeds/:embedId` | `brief_embed_delete` | Delete an embed | — |
| `GET /documents/:id/export/markdown` | `brief_export_markdown` | Export document as Markdown | `apps/brief/src/components/document/export-menu.tsx` |
| `GET /documents/:id/export/html` | `brief_export_html` | Export document as styled HTML | `apps/brief/src/components/document/export-menu.tsx` |
| `GET /templates` | `brief_templates_list` | List system + org templates | `apps/brief/src/hooks/use-templates.ts` |
| `POST /templates` | `brief_template_create` | Create an org template | `apps/brief/src/hooks/use-templates.ts` |
| `PATCH /templates/:id` | `brief_template_update` | Update a template | — |
| `DELETE /templates/:id` | `brief_template_delete` | Delete a template | — |
| `GET /folders` | `brief_folders_list` | List folder tree | `apps/brief/src/hooks/use-folders.ts` |
| `POST /folders` | `brief_folder_create` | Create a folder | `apps/brief/src/hooks/use-folders.ts` |
| `PATCH /folders/:id` | `brief_folder_update` | Update a folder | `apps/brief/src/hooks/use-folders.ts` |
| `DELETE /folders/:id` | `brief_folder_delete` | Delete a folder | `apps/brief/src/hooks/use-folders.ts` |
| `POST /internal/can-read` | — _(skip: internal service-to-service route)_ | Cross-app read preflight (Bureau summon) | — *(internal service-to-service)* |
| `POST /internal/visibility/can-access` | — _(skip: internal service-to-service route)_ | General (entity_type, entity_id) preflight for service callers (Banter Feed fan-in worker) | — *(internal service-to-service)* |


## Bond (app)

- **Service:** `apps/bond-api` · external `/bond/api/` · MCP module(s): `bond-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /activities` | `bond_list_activities` | List CRM activities (filterable) | `apps/bond/src/hooks/use-activities.ts` |
| `POST /activities` | `bond_log_activity` | Log activity against contact/deal/company | `apps/bond/src/hooks/use-activities.ts` |
| `GET /activities/:id` | `bond_get_activity` | Get activity detail | — |
| `PATCH /activities/:id` | `bond_update_activity` | Update an activity | — |
| `DELETE /activities/:id` | `bond_delete_activity` | Delete an activity | `apps/bond/src/hooks/use-activities.ts` |
| `GET /analytics/conversion-rates` | `bond_get_conversion_rates` | Stage-to-stage conversion rates | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /analytics/deal-velocity` | `bond_get_deal_velocity` | Average time in each stage | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /analytics/forecast` | `bond_get_forecast` | Revenue forecast in 30/60/90 buckets | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /analytics/pipeline-summary` | `bond_get_pipeline_summary` | Pipeline value/count by stage | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /analytics/stale-deals` | `bond_get_stale_deals` | Deals exceeding rotting threshold | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /analytics/win-loss` | `bond_get_win_loss` | Win/loss ratio and analysis | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /companies` | `bond_list_companies` | List/filter companies | `apps/bond/src/hooks/use-companies.ts` |
| `POST /companies` | `bond_create_company` | Create company | `apps/bond/src/hooks/use-companies.ts` |
| `GET /companies/search` | `bond_search_companies` | Search companies by name/domain | — |
| `GET /companies/:id` | `bond_get_company` | Get company detail | `apps/bond/src/hooks/use-companies.ts` |
| `PATCH /companies/:id` | `bond_update_company` | Update company | `apps/bond/src/hooks/use-companies.ts` |
| `DELETE /companies/:id` | `bond_delete_company` | Delete company | `apps/bond/src/hooks/use-companies.ts` |
| `GET /companies/:id/contacts` | `bond_list_company_contacts` | Contacts at this company | `apps/bond/src/pages/company-detail.tsx` |
| `GET /companies/:id/deals` | `bond_list_company_deals` | Paginated deals at this company | `apps/bond/src/pages/company-detail.tsx` |
| `POST /companies/:id/restore` | `bond_restore_company` | Undelete soft-deleted company | `apps/bond/src/hooks/use-companies.ts` |
| `GET /contacts` | `bond_list_contacts` | List/filter contacts | `apps/bond/src/hooks/use-contacts.ts` |
| `POST /contacts` | `bond_create_contact` | Create contact | `apps/bond/src/hooks/use-contacts.ts` |
| `GET /contacts/export` | — _(skip: binary/CSV export)_ | Export contacts | — |
| `POST /contacts/import` | — _(skip: bulk import upload)_ | Bulk import contacts | — |
| `GET /contacts/search` | `bond_search_contacts` | Full-text contact search | — |
| `POST /contacts/upsert` | `bond_upsert_contact` | Idempotent create-or-update by email | — |
| `POST /internal/contacts` | — _(skip: internal service-to-service, INTERNAL_SERVICE_SECRET)_ | Internal upsert-by-email for anonymous public bookings (book-api) | `apps/book-api/src/routes/public-booking.routes.ts` |
| `GET /contacts/:id` | `bond_get_contact` | Get contact detail | `apps/bond/src/hooks/use-contacts.ts` |
| `PATCH /contacts/:id` | `bond_update_contact` | Update contact | `apps/bond/src/hooks/use-contacts.ts` |
| `DELETE /contacts/:id` | `bond_delete_contact` | Delete contact | `apps/bond/src/hooks/use-contacts.ts` |
| `GET /contacts/:id/duplicates` | `bond_find_duplicates` | Ranked duplicate candidates for contact | — |
| `POST /contacts/:id/merge` | `bond_merge_contacts` | Merge duplicate contacts | `apps/bond/src/hooks/use-contacts.ts` |
| `POST /contacts/:id/restore` | `bond_restore_contact` | Undelete soft-deleted contact | `apps/bond/src/hooks/use-contacts.ts` |
| `GET /custom-field-definitions` | `bond_list_custom_fields` | List custom field definitions | `apps/bond/src/hooks/use-custom-fields.ts` |
| `POST /custom-field-definitions` | `bond_create_custom_field` | Create custom field definition | `apps/bond/src/hooks/use-custom-fields.ts` |
| `GET /custom-field-definitions/:id` | `bond_get_custom_field` | Get custom field definition | — |
| `PATCH /custom-field-definitions/:id` | `bond_update_custom_field` | Update custom field definition | `apps/bond/src/hooks/use-custom-fields.ts` |
| `DELETE /custom-field-definitions/:id` | `bond_delete_custom_field` | Delete custom field definition | `apps/bond/src/hooks/use-custom-fields.ts` |
| `GET /deals` | `bond_list_deals` | List/filter deals | `apps/bond/src/hooks/use-deals.ts` |
| `POST /deals` | `bond_create_deal` | Create deal | `apps/bond/src/hooks/use-deals.ts` |
| `GET /deals/:id` | `bond_get_deal` | Get deal detail | `apps/bond/src/hooks/use-deals.ts` |
| `PATCH /deals/:id` | `bond_update_deal` | Update deal | `apps/bond/src/hooks/use-deals.ts` |
| `DELETE /deals/:id` | `bond_delete_deal` | Soft-delete deal | `apps/bond/src/hooks/use-deals.ts` |
| `POST /deals/:id/restore` | `bond_restore_deal` | Undelete soft-deleted deal | `apps/bond/src/hooks/use-deals.ts` |
| `PATCH /deals/:id/stage` | `bond_move_deal_stage` | Move deal to new stage | `apps/bond/src/hooks/use-deals.ts` |
| `POST /deals/:id/won` | `bond_close_deal_won` | Close deal as won | `apps/bond/src/hooks/use-deals.ts` |
| `POST /deals/:id/lost` | `bond_close_deal_lost` | Close deal as lost | `apps/bond/src/hooks/use-deals.ts` |
| `POST /deals/:id/duplicate` | `bond_duplicate_deal` | Duplicate deal | — |
| `GET /deals/:id/contacts` | `bond_list_deal_contacts` | List deal contacts | — |
| `POST /deals/:id/contacts` | `bond_add_deal_contact` | Add contact to deal | `apps/bond/src/hooks/use-deals.ts` |
| `DELETE /deals/:id/contacts/:contactId` | `bond_remove_deal_contact` | Remove contact from deal | `apps/bond/src/hooks/use-deals.ts` |
| `GET /deals/:id/stage-history` | `bond_get_deal_stage_history` | Stage transition history | `apps/bond/src/hooks/use-deals.ts` |
| `GET /deals/:id/activities` | `bond_list_deal_activities` | Activity timeline for a deal | `apps/bond/src/hooks/use-activities.ts` |
| `GET /deals/:id/related` | `bond_get_deal_related` | Cross-product links (Bill/Book/Bam) | `apps/bond/src/hooks/use-deals.ts` |
| `POST /imports/mappings` | `bond_create_import_mapping` | Upsert a single import mapping | — |
| `GET /imports/mappings` | `bond_list_import_mappings` | List import mappings | — |
| `GET /pipelines` | `bond_list_pipelines` | List pipelines | `apps/bond/src/hooks/use-pipelines.ts` |
| `POST /pipelines` | `bond_create_pipeline` | Create pipeline | `apps/bond/src/hooks/use-pipelines.ts` |
| `GET /pipelines/:id` | `bond_get_pipeline` | Get pipeline detail | `apps/bond/src/hooks/use-pipelines.ts` |
| `PATCH /pipelines/:id` | `bond_update_pipeline` | Update pipeline | `apps/bond/src/hooks/use-pipelines.ts` |
| `DELETE /pipelines/:id` | `bond_delete_pipeline` | Delete pipeline | — |
| `GET /pipelines/:id/stages` | `bond_list_stages` | List pipeline stages | — |
| `POST /pipelines/:id/stages` | `bond_create_stage` | Create stage | `apps/bond/src/hooks/use-pipelines.ts` |
| `PATCH /pipelines/:id/stages/:stageId` | `bond_update_stage` | Update stage | `apps/bond/src/hooks/use-pipelines.ts` |
| `DELETE /pipelines/:id/stages/:stageId` | `bond_delete_stage` | Delete stage | `apps/bond/src/hooks/use-pipelines.ts` |
| `POST /pipelines/:id/stages/reorder` | `bond_reorder_stages` | Reorder stages | `apps/bond/src/hooks/use-pipelines.ts` |
| `GET /scoring-rules` | `bond_list_scoring_rules` | List lead-scoring rules | `apps/bond/src/hooks/use-scoring.ts` |
| `POST /scoring-rules` | `bond_create_scoring_rule` | Create scoring rule | `apps/bond/src/hooks/use-scoring.ts` |
| `PATCH /scoring-rules/:id` | `bond_update_scoring_rule` | Update scoring rule | `apps/bond/src/hooks/use-scoring.ts` |
| `DELETE /scoring-rules/:id` | `bond_delete_scoring_rule` | Delete scoring rule | `apps/bond/src/hooks/use-scoring.ts` |
| `POST /scoring/recalculate` | `bond_score_lead` | Recalculate a contact's lead score | `apps/bond/src/hooks/use-scoring.ts` |
| `GET /user-settings` | `bond_get_user_settings` | Current user's Bond settings | `apps/bond/src/hooks/use-user-settings.ts` |
| `PATCH /user-settings` | `bond_update_user_settings` | Set/clear reply-to address | `apps/bond/src/hooks/use-user-settings.ts` |


## Bolt (app)

- **Service:** `apps/bolt-api` · external `/bolt/api/` · MCP module(s): `bolt-tools.ts`, `bolt-observability-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /actions` | `bolt_actions` | List MCP tools usable as actions | `apps/bolt/src/hooks/use-event-catalog.ts` |
| `POST /ai/explain` | `bolt_explain` | Explain an automation in natural language | — |
| `POST /ai/generate` | `bolt_generate` | Generate automation from NL prompt | — |
| `GET /automations` | `bolt_list` | List automations (filterable) | `apps/bolt/src/hooks/use-automations.ts` |
| `POST /automations` | `bolt_create` | Create automation | `apps/bolt/src/hooks/use-automations.ts` |
| `GET /automations/stats` | `bolt_stats` | Automation statistics | `apps/bolt/src/hooks/use-automations.ts` |
| `GET /automations/by-name/:name` | `bolt_get_automation_by_name` | Resolve automation by name | — |
| `GET /automations/:id` | `bolt_get` | Get automation with conditions/actions | `apps/bolt/src/hooks/use-automations.ts` |
| `PUT /automations/:id` | `bolt_update` | Full update of automation | `apps/bolt/src/hooks/use-automations.ts` |
| `PATCH /automations/:id` | `bolt_patch` | Partial metadata update | — |
| `DELETE /automations/:id` | `bolt_delete` | Delete automation | `apps/bolt/src/hooks/use-automations.ts` |
| `POST /automations/:id/enable` | `bolt_enable` | Enable automation | `apps/bolt/src/hooks/use-automations.ts` |
| `POST /automations/:id/disable` | `bolt_disable` | Disable automation | `apps/bolt/src/hooks/use-automations.ts` |
| `POST /automations/:id/duplicate` | `bolt_duplicate` | Duplicate automation | `apps/bolt/src/hooks/use-automations.ts` |
| `POST /automations/:id/test` | `bolt_test` | Test-fire with simulated event | `apps/bolt/src/hooks/use-automations.ts` |
| `GET /automations/:id/versions` | `bolt_list_versions` | List automation versions | — |
| `POST /automations/:id/versions/:vid/restore` | `bolt_restore_version` | Restore an automation version | — |
| `GET /automations/:id/executions` | `bolt_executions` | List executions for automation | `apps/bolt/src/hooks/use-executions.ts` |
| `GET /events` | `bolt_events` | Full trigger-event catalog | `apps/bolt/src/hooks/use-event-catalog.ts` |
| `GET /events/:source` | `bolt_events` | Events for a specific source | `apps/bolt/src/hooks/use-event-catalog.ts` |
| `GET /events/:event_id/trace` | `bolt_event_trace` | Full evaluation trail for an event | — |
| `GET /events/recent` | `bolt_recent_events` | Recent matched ingest events | — |
| `POST /events/ingest` | — _(skip: internal/service-secret ingest)_ | Internal event ingestion (service-secret) | — |
| `GET /executions` | `bolt_list_executions` | Org-wide execution list | `apps/bolt/src/hooks/use-executions.ts` |
| `GET /executions/:id` | `bolt_execution_detail` | Execution detail with steps | `apps/bolt/src/hooks/use-executions.ts` |
| `POST /executions/:id/retry` | `bolt_retry_execution` | Retry a failed execution | `apps/bolt/src/hooks/use-executions.ts` |
| `GET /templates` | `bolt_list_templates` | List pre-built automation templates | `apps/bolt/src/hooks/use-templates.ts` |
| `POST /templates/:id/instantiate` | `bolt_instantiate_template` | Create automation from template | `apps/bolt/src/hooks/use-templates.ts` |


## Bearing (app)

- **Service:** `apps/bearing-api` · external `/bearing/api/` · MCP module(s): `bearing-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /goals` | `bearing_goals` | List goals (filterable) | `apps/bearing/src/hooks/useGoals.ts` |
| `POST /goals` | `bearing_goal_create` | Create goal | `apps/bearing/src/hooks/useGoals.ts` |
| `GET /goals/export` | — _(skip: binary/CSV export)_ | Export goals as CSV | — |
| `GET /goals/:id` | `bearing_goal_get` | Get goal with key results | `apps/bearing/src/hooks/useGoals.ts` |
| `PATCH /goals/:id` | `bearing_goal_update` | Update goal | `apps/bearing/src/hooks/useGoals.ts` |
| `DELETE /goals/:id` | `bearing_goal_delete` | Delete goal | `apps/bearing/src/hooks/useGoals.ts` |
| `POST /goals/:id/status` | `bearing_goal_status_override` | Override goal status | `apps/bearing/src/hooks/useGoals.ts` |
| `GET /goals/:id/updates` | `bearing_goal_updates` | List goal updates | `apps/bearing/src/hooks/useGoals.ts` |
| `POST /goals/:id/updates` | `bearing_update_post` | Post a status update | `apps/bearing/src/hooks/useGoals.ts` |
| `GET /goals/:id/watchers` | `bearing_goal_watchers` | List goal watchers | `apps/bearing/src/hooks/useGoals.ts` |
| `POST /goals/:id/watchers` | `bearing_goal_watch` | Add watcher | `apps/bearing/src/hooks/useGoals.ts` |
| `DELETE /goals/:id/watchers/:userId` | `bearing_goal_unwatch` | Remove watcher | `apps/bearing/src/hooks/useGoals.ts` |
| `GET /goals/:id/history` | `bearing_goal_history` | Goal progress history | `apps/bearing/src/hooks/useGoals.ts` |
| `GET /goals/:id/key-results` | `bearing_kr_list` | List key results for goal | `apps/bearing/src/hooks/useKeyResults.ts` |
| `POST /goals/:id/key-results` | `bearing_kr_create` | Create key result | `apps/bearing/src/hooks/useKeyResults.ts` |
| `GET /key-results/:id` | `bearing_kr_get` | Get key result | `apps/bearing/src/hooks/useKeyResults.ts` |
| `PATCH /key-results/:id` | `bearing_kr_update` | Update key result | `apps/bearing/src/hooks/useKeyResults.ts` |
| `DELETE /key-results/:id` | `bearing_kr_delete` | Delete key result | `apps/bearing/src/hooks/useKeyResults.ts` |
| `POST /key-results/:id/value` | `bearing_kr_update` | Set current value (check-in) | `apps/bearing/src/hooks/useKeyResults.ts` |
| `GET /key-results/:id/links` | `bearing_kr_links` | List key-result links | `apps/bearing/src/hooks/useKeyResults.ts` |
| `POST /key-results/:id/links` | `bearing_kr_link` | Add link to Bam entity | `apps/bearing/src/hooks/useKeyResults.ts` |
| `DELETE /key-results/:id/links/:linkId` | `bearing_kr_unlink` | Remove key-result link | `apps/bearing/src/hooks/useKeyResults.ts` |
| `GET /key-results/:id/history` | `bearing_kr_history` | Key-result snapshot history | `apps/bearing/src/hooks/useKeyResults.ts` |
| `GET /key-results/export` | — _(skip: binary/CSV export)_ | Export key results as CSV | — |
| `GET /periods` | `bearing_periods` | List OKR periods | `apps/bearing/src/hooks/usePeriods.ts` |
| `POST /periods` | `bearing_period_create` | Create period | `apps/bearing/src/hooks/usePeriods.ts` |
| `GET /periods/:id` | `bearing_period_get` | Get period with stats | `apps/bearing/src/hooks/usePeriods.ts` |
| `PATCH /periods/:id` | `bearing_period_update` | Update period | `apps/bearing/src/hooks/usePeriods.ts` |
| `DELETE /periods/:id` | `bearing_period_delete` | Delete period | `apps/bearing/src/hooks/usePeriods.ts` |
| `POST /periods/:id/activate` | `bearing_period_activate` | Activate period | `apps/bearing/src/hooks/usePeriods.ts` |
| `POST /periods/:id/complete` | `bearing_period_complete` | Complete period | `apps/bearing/src/hooks/usePeriods.ts` |
| `GET /periods/:id/report` | — _(skip: SPA-only structured dashboard report; markdown `bearing_report` serves agents)_ | Structured period report (dashboard stat cards + progress-over-time chart) | `apps/bearing/src/hooks/useProgress.ts` |
| `GET /reports/period/:periodId` | `bearing_report` | Period summary report (markdown) | — |
| `GET /reports/at-risk` | `bearing_at_risk` | At-risk goals report | — |
| `GET /reports/owner/:userId` | `bearing_report` | A user's goals report | — |
| `POST /reports/generate` | `bearing_report` | Generate formatted report | — |


## Board / Blast / Bench / Blueprint — REST ↔ MCP map

Endpoint paths are route-relative (the `/v1` API prefix and nginx external prefix are
omitted from each row; see the per-app header line). UI call sites are best-effort.

## Board (app)

- **Service:** `apps/board-api` · external `/board/api/` · MCP module(s): `board-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `DELETE /collaborators/:collabId` | `board_remove_collaborator` | Remove a board collaborator | — |
| `PATCH /collaborators/:collabId` | `board_update_collaborator` | Update collaborator permission | — |
| `DELETE /links/:linkId` | `board_delete_link` | Delete element-task link | — |
| `GET /boards` | `board_list` | List boards with filters/pagination | `apps/board/src/hooks/use-boards.ts` |
| `POST /boards` | `board_create` | Create a board | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/recent` | `board_list_recent` | Recently updated boards | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/search` | `board_search` | Search board element text | — |
| `GET /boards/starred` | `board_list_starred` | User's starred boards | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/stats` | `board_org_stats` | Org-level board statistics | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id` | `board_get` | Get board metadata | `apps/board/src/hooks/use-boards.ts` |
| `PATCH /boards/:id` | `board_update` | Update board metadata | `apps/board/src/hooks/use-boards.ts` |
| `DELETE /boards/:id` | `board_archive` | Archive (soft-delete) board | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id/chat` | `board_read_chat` | List recent chat messages | `apps/board/src/hooks/use-chat.ts` |
| `POST /boards/:id/chat` | `board_post_chat` | Send a chat message | `apps/board/src/hooks/use-chat.ts` |
| `GET /boards/:id/collaborators` | `board_list_collaborators` | List collaborators | — |
| `POST /boards/:id/collaborators` | `board_add_collaborator` | Add a collaborator | — |
| `POST /boards/:id/duplicate` | `board_duplicate` | Duplicate board with elements | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id/elements` | `board_read_elements` | Read all canvas elements | `apps/board/src/hooks/use-elements.ts` |
| `GET /boards/:id/elements/frames` | `board_read_frames` | Read frames + contained elements | `apps/board/src/hooks/use-elements.ts` |
| `POST /boards/:id/elements/promote` | `board_promote_to_tasks` | Promote stickies to Bam tasks | — |
| `GET /boards/:id/elements/stickies` | `board_read_stickies` | Read sticky-note elements | `apps/board/src/hooks/use-elements.ts` |
| `POST /boards/:id/elements/sticky` | `board_add_sticky` | Create a sticky note | — |
| `POST /boards/:id/elements/text` | `board_add_text` | Create a text element | — |
| `POST /boards/:id/export` | `board_export` | Export scene (json/svg/png) | `apps/blueprint`/agent only |
| `GET /boards/:id/export/:format` | — _(skip: binary svg/png render)_ | Server-side svg/png render | — |
| `GET /boards/:id/integrity` | `board_check_integrity` | Per-board integrity check | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id/links` | `board_list_links` | List element-task links | — |
| `POST /boards/:id/lock` | — *(via `board_update locked`)* | Toggle board lock | `apps/board/src/hooks/use-boards.ts` |
| `DELETE /boards/:id/permanent` | `board_delete_permanent` | Hard-delete board (cascade) | `apps/board/src/hooks/use-boards.ts` |
| `POST /boards/:id/remediate` | `board_remediate_integrity` | Apply integrity fix (detach/reassign) | `apps/board/src/hooks/use-boards.ts` |
| `POST /boards/:id/restore` | `board_restore` | Restore archived board | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id/scene` | — _(skip: Excalidraw/Yjs scene sync)_ | Load saved Excalidraw scene | `apps/board/src/hooks/use-collaboration.ts` |
| `PUT /boards/:id/scene` | — _(skip: Excalidraw/Yjs scene sync)_ | Full scene save | `apps/board/src/hooks/use-collaboration.ts` |
| `POST /boards/:id/scene/beacon` | — _(skip: Excalidraw/Yjs scene sync)_ | sendBeacon scene flush on unload | `apps/board/src/pages/board-canvas.tsx` |
| `POST /boards/:id/star` | `board_star_toggle` | Toggle star on board | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id/stats` | `board_stats` | Single-board statistics | — |
| `GET /boards/:id/versions` | `board_list_versions` | List board versions | `apps/board/src/hooks/use-versions.ts` |
| `POST /boards/:id/versions` | `board_create_version` | Create named snapshot | `apps/board/src/hooks/use-versions.ts` |
| `POST /boards/:id/versions/:versionId/restore` | `board_restore_version` | Restore a version | `apps/board/src/hooks/use-versions.ts` |
| `GET /internal/can-read` (`POST`) | — *(internal)* | Bureau cross-app read preflight | — |
| `GET /templates` | `board_list_templates` | List board templates | `apps/board/src/hooks/use-templates.ts` |
| `POST /templates` | `board_create_template` | Create a template | — |
| `PATCH /templates/:id` | `board_update_template` | Update a template | — |
| `DELETE /templates/:id` | `board_delete_template` | Delete a template | — |
| `POST /templates/:id/instantiate` | `board_instantiate_template` | Create a board from template | `apps/board/src/hooks/use-templates.ts` |
| `— *(client-side)*` | `board_summarize` | Frame-grouped summary (reuses `/frames`) | — |


## Blast (app)

- **Service:** `apps/blast-api` · external `/blast/api/` (+ `/t/` tracking, `/unsub/`) · MCP module(s): `blast-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /analytics/engagement-trend` | `blast_get_engagement_trend` | Org engagement trend over time | `apps/blast/src/hooks/use-analytics.ts` |
| `GET /analytics/overview` | `blast_get_engagement_summary` | Org-level engagement metrics | `apps/blast/src/hooks/use-analytics.ts` |
| `GET /analytics/unsubscribe-check` | `blast_check_unsubscribed` | Check email unsubscribe status | — |
| `GET /campaigns` | `blast_list_campaigns` | List campaigns | `apps/blast/src/hooks/use-campaigns.ts` |
| `POST /campaigns` | `blast_draft_campaign` | Create draft campaign | `apps/blast/src/hooks/use-campaigns.ts` |
| `GET /campaigns/:id` | `blast_get_campaign` | Campaign detail + stats | `apps/blast/src/hooks/use-campaigns.ts` |
| `PATCH /campaigns/:id` | `blast_update_campaign` | Update campaign | `apps/blast/src/hooks/use-campaigns.ts` |
| `DELETE /campaigns/:id` | — _(skip: destructive delete — deferred (conservative))_ | Delete campaign | `apps/blast/src/hooks/use-campaigns.ts` |
| `GET /campaigns/:id/analytics` | `blast_get_campaign_analytics` | Engagement metrics for campaign | `apps/blast/src/hooks/use-campaigns.ts` |
| `GET /campaigns/:id/analytics/devices` | `blast_get_campaign_device_analytics` | Device-breakdown analytics | — |
| `POST /campaigns/:id/cancel` | `blast_cancel_campaign` | Cancel a campaign | — |
| `POST /campaigns/:id/pause` | `blast_pause_campaign` | Pause a campaign | — |
| `GET /campaigns/:id/recipients` | `blast_list_campaign_recipients` | List campaign recipients | `apps/blast/src/hooks/use-campaigns.ts` |
| `POST /campaigns/:id/schedule` | `blast_send_campaign` *(approval path)* | Schedule campaign send | `apps/blast/src/hooks/use-campaigns.ts` |
| `POST /campaigns/:id/send` | `blast_send_campaign` | Send campaign immediately | `apps/blast/src/hooks/use-campaigns.ts` |
| `GET /segments` | `blast_list_segments` | List contact segments | `apps/blast/src/hooks/use-segments.ts` |
| `POST /segments` | `blast_create_segment` | Create a segment | `apps/blast/src/hooks/use-segments.ts` |
| `GET /segments/:id` | `blast_get_segment` | Get a segment | `apps/blast/src/hooks/use-segments.ts` |
| `PATCH /segments/:id` | `blast_update_segment` | Update a segment | `apps/blast/src/hooks/use-segments.ts` |
| `DELETE /segments/:id` | — _(skip: destructive delete — deferred (conservative))_ | Delete a segment | `apps/blast/src/hooks/use-segments.ts` |
| `POST /segments/:id/count` | `blast_recalculate_segment_count` | Recalculate recipient count | `apps/blast/src/hooks/use-segments.ts` |
| `GET /segments/:id/preview` | `blast_preview_segment` | Preview matching contacts | — |
| `POST /segments/:id/evaluate` | `blast_evaluate_segment` | Full recipient evaluation for send | — |
| `GET /sender-domains` | — _(skip: sender-domain DKIM/credential config — admin)_ | List sender domains | `apps/blast/src/pages/domain-settings.tsx` |
| `POST /sender-domains` | — _(skip: sender-domain DKIM/credential config — admin)_ | Add sender domain | `apps/blast/src/pages/domain-settings.tsx` |
| `POST /sender-domains/:id/verify` | — _(skip: sender-domain DKIM/credential config — admin)_ | Verify sender domain | `apps/blast/src/pages/domain-settings.tsx` |
| `DELETE /sender-domains/:id` | — _(skip: sender-domain DKIM/credential config — admin)_ | Remove sender domain | `apps/blast/src/pages/domain-settings.tsx` |
| `GET /templates` | `blast_list_templates` | List email templates | `apps/blast/src/hooks/use-templates.ts` |
| `POST /templates` | `blast_create_template` | Create email template | `apps/blast/src/hooks/use-templates.ts` |
| `GET /templates/:id` | `blast_get_template` | Get template content | `apps/blast/src/hooks/use-templates.ts` |
| `PATCH /templates/:id` | `blast_update_template` | Update template | `apps/blast/src/hooks/use-templates.ts` |
| `DELETE /templates/:id` | — _(skip: destructive delete — deferred (conservative))_ | Delete template | `apps/blast/src/hooks/use-templates.ts` |
| `POST /templates/:id/duplicate` | `blast_duplicate_template` | Duplicate template | `apps/blast/src/hooks/use-templates.ts` |
| `POST /templates/:id/preview` | `blast_preview_template` | Render template with merge data | — |
| `GET /t/o/:token` | — *(public tracking)* | Open-tracking pixel | email client |
| `GET /t/c/:token` | — *(public tracking)* | Click-tracking redirect | email client |
| `GET /unsub/:token` | — *(public)* | Unsubscribe confirmation page | email client |
| `POST /unsub/:token` | — *(public)* | Process unsubscribe | email client |
| `POST /webhooks/bounce` | — *(inbound webhook)* | SMTP bounce notification | provider |
| `POST /webhooks/complaint` | — *(inbound webhook)* | SMTP complaint notification | provider |
| `— *(client-side)*` | `blast_draft_email_content` | AI-draft subject + body (LLM placeholder) | — |
| `— *(client-side)*` | `blast_suggest_subject_lines` | Generate 5 subject variants (LLM placeholder) | — |


## Bench (app)

- **Service:** `apps/bench-api` · external `/bench/api/` · MCP module(s): `bench-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /dashboards` | `bench_list_dashboards` | List dashboards | `apps/bench/src/hooks/use-dashboards.ts` |
| `POST /dashboards` | `bench_create_dashboard` | Create dashboard | `apps/bench/src/hooks/use-dashboards.ts` |
| `GET /dashboards/:id` | `bench_get_dashboard` | Get dashboard with widgets | `apps/bench/src/hooks/use-dashboards.ts` |
| `PATCH /dashboards/:id` | `bench_update_dashboard` | Update dashboard | `apps/bench/src/hooks/use-dashboards.ts` |
| `DELETE /dashboards/:id` | `bench_delete_dashboard` | Delete dashboard | `apps/bench/src/hooks/use-dashboards.ts` |
| `POST /dashboards/:id/duplicate` | `bench_duplicate_dashboard` | Clone dashboard | `apps/bench/src/hooks/use-dashboards.ts` |
| `POST /dashboards/:id/export` | `bench_export_dashboard` | Export dashboard (stub/queued) | — |
| `POST /dashboards/:id/widgets` | `bench_add_widget` | Add widget to dashboard | `apps/bench/src/hooks/use-widgets.ts` |
| `GET /data-sources` | `bench_list_data_sources` | List data sources + schemas | `apps/bench/src/hooks/use-data-sources.ts` |
| `GET /data-sources/:product/:entity` | `bench_get_data_source` | Data-source detail | `apps/bench/src/hooks/use-data-sources.ts` |
| `GET /materialized-views` | `bench_list_materialized_views` | List materialized views | — |
| `POST /materialized-views/:viewName/refresh` | `bench_refresh_materialized_view` | Refresh a materialized view | — |
| `POST /query/preview` | `bench_query_ad_hoc` | Ad-hoc structured query | `apps/bench/src/pages/explorer.tsx` |
| `GET /reports` | `bench_list_scheduled_reports` | List scheduled reports | `apps/bench/src/hooks/use-reports.ts` |
| `POST /reports` | `bench_create_scheduled_report` | Create scheduled report | `apps/bench/src/hooks/use-reports.ts` |
| `PATCH /reports/:id` | `bench_update_scheduled_report` | Update report | — |
| `DELETE /reports/:id` | `bench_delete_scheduled_report` | Delete report | `apps/bench/src/hooks/use-reports.ts` |
| `POST /reports/:id/send-now` | `bench_generate_report` | Trigger immediate report | `apps/bench/src/hooks/use-reports.ts` |
| `GET /saved-queries` | `bench_list_saved_queries` | List saved queries | `apps/bench/src/hooks/use-saved-queries.ts` |
| `POST /saved-queries` | `bench_create_saved_query` | Create saved query | `apps/bench/src/hooks/use-saved-queries.ts` |
| `GET /saved-queries/:id` | `bench_get_saved_query` | Get saved query | `apps/bench/src/hooks/use-saved-queries.ts` |
| `PATCH /saved-queries/:id` | `bench_update_saved_query` | Update saved query | `apps/bench/src/hooks/use-saved-queries.ts` |
| `DELETE /saved-queries/:id` | `bench_delete_saved_query` | Delete saved query | `apps/bench/src/hooks/use-saved-queries.ts` |
| `GET /widgets` | `bench_list_widgets` | List widgets across org | — |
| `GET /widgets/:id` | `bench_get_widget` | Get widget | `apps/bench/src/hooks/use-widgets.ts` |
| `PATCH /widgets/:id` | `bench_update_widget` | Update widget | `apps/bench/src/hooks/use-widgets.ts` |
| `DELETE /widgets/:id` | `bench_delete_widget` | Delete widget | `apps/bench/src/hooks/use-widgets.ts` |
| `POST /widgets/:id/query` | `bench_query_widget` | Execute widget query | `apps/bench/src/hooks/use-widgets.ts` |
| `POST /widgets/:id/refresh` | `bench_refresh_widget` | Force cache refresh + re-query | `apps/bench/src/hooks/use-widgets.ts` |
| `— *(composite)*` | `bench_summarize_dashboard` | Fan-out all widget queries for AI | — |
| `— *(composite)*` | `bench_detect_anomalies` | Compare last vs prior period (2× preview) | — |
| `— *(composite)*` | `bench_compare_periods` | Compare two time periods (2× preview) | — |


## Blueprint (app)

- **Service:** `apps/blueprint-api` · external `/blueprint/api/` (WS `/blueprint/ws`) · MCP module(s): `blueprint-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /diagrams` | `blueprint_list` | List diagrams with filters | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `POST /diagrams` | `blueprint_create` | Create a diagram | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `POST /diagrams/from-bam` | `blueprint_generate_from_bam` | Build diagram from Bam tasks | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `GET /diagrams/:id` | `blueprint_get` | Get diagram metadata | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `PATCH /diagrams/:id` | `blueprint_update` | Update diagram metadata | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `POST /diagrams/:id/archive` | `blueprint_archive` | Archive diagram (soft delete) | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `GET /diagrams/:id/collaborators` | `blueprint_list_collaborators` | List diagram collaborators | — |
| `POST /diagrams/:id/collaborators` | `blueprint_add_collaborator` | Add collaborator | — |
| `DELETE /diagrams/:id/collaborators/:userId` | `blueprint_remove_collaborator` | Remove collaborator | — |
| `GET /diagrams/:id/comments` | `blueprint_list_comments` | List anchored comments | — |
| `POST /diagrams/:id/comments` | `blueprint_add_comment` | Add a comment | — |
| `PATCH /diagrams/:id/comments/:cid` | `blueprint_update_comment` | Edit/resolve a comment | — |
| `GET /diagrams/:id/edges` | `blueprint_read_edges` | Read all edges | (via `/graph`) |
| `POST /diagrams/:id/edges` | `blueprint_add_edge` | Create an edge | `apps/blueprint/src/hooks/use-graph.ts` |
| `PATCH /diagrams/:id/edges/:edgeId` | `blueprint_update_edge` | Update an edge | `apps/blueprint/src/hooks/use-graph.ts` |
| `DELETE /diagrams/:id/edges/:edgeId` | `blueprint_delete_edge` | Delete an edge | `apps/blueprint/src/hooks/use-graph.ts` |
| `GET /diagrams/:id/export` | `blueprint_export` | Export json/mermaid/svg/png | `apps/blueprint/src/hooks/use-graph.ts` |
| `POST /diagrams/:id/generate` | `blueprint_generate` | Build graph from node/edge spec | — |
| `GET /diagrams/:id/graph` | — *(use read_nodes + read_edges)* | Full graph payload | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `POST /diagrams/:id/import` | `blueprint_import_mermaid` | Import Mermaid source | `apps/blueprint/src/hooks/use-graph.ts` |
| `POST /diagrams/:id/layout` | `blueprint_apply_layout` | Run ELK auto-layout | `apps/blueprint/src/hooks/use-graph.ts` |
| `GET /diagrams/:id/nodes` | `blueprint_read_nodes` | Read all nodes | (via `/graph`) |
| `POST /diagrams/:id/nodes` | `blueprint_add_node` | Add a node | `apps/blueprint/src/hooks/use-graph.ts` |
| `PATCH /diagrams/:id/nodes/:nodeId` | `blueprint_update_node` | Update a node | `apps/blueprint/src/hooks/use-graph.ts` |
| `DELETE /diagrams/:id/nodes/:nodeId` | `blueprint_delete_node` | Delete node (cascade edges) | `apps/blueprint/src/hooks/use-graph.ts` |
| `POST /diagrams/:id/nodes/:nodeId/duplicate` | `blueprint_duplicate_node` | Duplicate a node | `apps/blueprint/src/hooks/use-graph.ts` |
| `POST /diagrams/:id/nodes/:nodeId/link-entity` | `blueprint_link_entity` | Attach cross-product entity ref | `apps/blueprint/src/pages/editor.tsx` |
| `POST /diagrams/:id/nodes/:nodeId/move` | `blueprint_move_node` | Reposition a node | `apps/blueprint/src/hooks/use-graph.ts` |
| `POST /diagrams/:id/nodes/:nodeId/promote-to-task` | `blueprint_promote_node_to_task` | Build task payload from node | `apps/blueprint/src/pages/editor.tsx` |
| `POST /diagrams/:id/promote-to-tasks` | `blueprint_promote_graph_to_tasks` | Compile graph into task plan | `apps/blueprint/src/hooks/use-graph.ts` |
| `POST /diagrams/:id/star` | `blueprint_star` | Star a diagram | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `DELETE /diagrams/:id/star` | `blueprint_unstar` | Unstar a diagram | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `GET /diagrams/:id/versions` | `blueprint_list_versions` | List versions | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `POST /diagrams/:id/versions` | `blueprint_snapshot_version` | Snapshot a version | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `POST /diagrams/:id/versions/:n/restore` | `blueprint_restore_version` | Restore a version | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `POST /internal/sync-from-task` | — *(internal)* | Propagate Bam task edit into nodes | — |
| `GET /templates` | `blueprint_list_templates` | List diagram templates | — |
| `GET /ws` | — *(WebSocket)* | Realtime diagram subscription | `apps/blueprint/src/hooks/use-graph.ts` |
| `— *(client-side)*` | `blueprint_search` | Client-side name/description filter | — |


## Bin (app)

- **Service:** `apps/bin-api` · external `/bin/api/` · MCP module(s): `bin-tools.ts`
- Storage backbone + DAM + structured-data editor. Bytes flow through the
  proxied upload/serve path (presigned routes exist for deployments with a
  browser-reachable provider endpoint). The canonical artifact is the immutable
  asset **version**; structured edits mint a new version (never in-place).

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /assets` | `bin_asset_list` | List DAM assets (folder/project filters) | `apps/bin/src/hooks/use-bin.ts` |
| `POST /assets` | `bin_asset_create` | Create an asset (metadata; bytes follow) | `apps/bin/src/hooks/use-bin.ts` |
| `GET /assets/:id` | `bin_asset_get` | Get asset metadata (scan status, version) | `apps/bin/src/hooks/use-bin.ts` |
| `PATCH /assets/:id` | `bin_asset_update` | Rename / move to folder / set tags | `apps/bin/src/hooks/use-bin.ts` |
| `GET /tags` | `bin_tag_list` | Distinct org tags (filter pickers) | `apps/bin/src/hooks/use-bin.ts` |
| `POST /assets/:id/archive` | `bin_asset_archive` | Archive (soft delete) | — |
| `DELETE /assets/:id` | `bin_asset_delete` | Hard-delete (row + bytes, decoupled) | `apps/bin/src/hooks/use-bin.ts` |
| `POST /assets/bulk-delete` | `— _(skip: bulk convenience over bin_asset_delete; same bin.asset.delete gate)_` | Hard-delete many assets | `apps/bin/src/hooks/use-bin.ts` |
| `POST /assets/:id/scan-override` | `— _(skip: SuperUser/admin scan-block override — in-handler role gate)_` | Persistent per-file false-positive clear | `apps/bin/src/hooks/use-bin.ts` |
| `POST /assets/:id/upload` | `— _(skip: multipart/binary upload)_` | Proxied multipart upload → new version | `apps/bin/src/lib/api.ts` |
| `GET /assets/:id/raw` | `— _(skip: binary stream)_` | Scan-gated byte stream (`?acknowledge_risk` opens unscanned) | `apps/bin/src/hooks/use-bin.ts` |
| `GET /assets/:id/download` | `— _(skip: presigned URL/binary)_` | Presigned GET (public-endpoint deploys) | — |
| `GET /scan/overview` | `— _(skip: org scan-progress dashboard data)_` | Scan counts + policy + override capability | `apps/bin/src/hooks/use-bin.ts` |
| `PUT /scan/policy` | `— _(skip: SuperUser/admin org policy — in-handler role gate)_` | Set org allow-unscanned override | `apps/bin/src/hooks/use-bin.ts` |
| `GET /assets/:id/versions` | `bin_version_list` | List immutable versions | — |
| `POST /assets/:id/versions` | `— _(skip: presigned PUT/binary)_` | Reserve version + presigned PUT | — |
| `GET /versions/:id` | `— _(skip: covered by bin_version_list)_` | Get one version | — |
| `POST /versions/:id/complete` | `— _(skip: upload-finalize, pairs with presigned PUT)_` | Finalize an uploaded version | — |
| `GET /folders` | `bin_folder_list` | List folders | `apps/bin/src/hooks/use-bin.ts` |
| `POST /folders` | `bin_folder_create` | Create a folder | — |
| `PATCH /folders/:id` | `— _(skip: deferred — no folder-edit tool yet)_` | Rename/move a folder | — |
| `DELETE /folders/:id` | `— _(skip: deferred — no folder-delete tool yet)_` | Delete a folder | — |
| `GET /data/:id` | `bin_data_read` | Read records/tree (filter/columns/paging + schema) | `apps/bin/src/hooks/use-bin.ts` |
| `POST /data/:id/session` | `bin_data_open_session` | Open/resume editing session (ws room) | — |
| `POST /data/:id/rows` | `bin_data_append_rows` | Append rows → new version | `apps/bin/src/hooks/use-bin.ts` |
| `PATCH /data/:id/rows` | `bin_data_patch` | Patch record cells → new version | `apps/bin/src/hooks/use-bin.ts` |
| `PATCH /data/:id/tree` | `bin_data_patch_tree` | Set tree values at paths → new version | `apps/bin/src/hooks/use-bin.ts` |
| `POST /data/:id/array` | `bin_data_array_op` | Add/delete a row in any grid → new version | `apps/bin/src/hooks/use-bin.ts` |
| `GET /data/:id/comments` | `bin_data_comment_list` | List review comments | — |
| `POST /data/:id/comments` | `bin_data_comment_create` | Add an anchored comment | — |
| `POST /data/:id/comments/:cid/resolve` | `bin_data_comment_resolve` | Resolve/reopen a comment | — |
| `GET /ws` (`/bin/ws`) | — _(skip: realtime/ws — live edits + editor presence)_ | WebSocket: subscribe to an asset's live data-updated + presence events | `apps/bin/src/hooks/use-bin-realtime.ts` |


## Bay (app)

- **Service:** `apps/bay-api` · external `/bay/api/` · MCP module(s): `bay-tools.ts`
- Media review & approval, federated on top of Bin (BAY-1…4): canonical bytes are
  a `bin.asset` version; Bay owns the review layer (versions' media metadata,
  coordinate-anchored annotations, per-reviewer decisions). Agents review with the
  same tools/identity/audit trail as humans. The SPA, ffmpeg transcode/proxies
  (served via Bin `/raw?variant=`), and public guest review (`/bay/r/:token`) are
  all shipped.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `POST /review/resolve` | `bay_review_resolve` | Find-or-create the review for a Bin media asset | `apps/bay/src/pages/review-by-bin.tsx` |
| `POST /review-links` | `bay_review_link_create` | Mint a public guest-review share link | `apps/bay/src/pages/review-asset.tsx` |
| `GET /review-links` | — _(skip: SPA share-management list; resolver-done-internally)_ | List a review's share links | `apps/bay/src/hooks/use-bay.ts` |
| `DELETE /review-links/:id` | — _(skip: SPA share-management revoke)_ | Revoke (soft) a share link | `apps/bay/src/hooks/use-bay.ts` |
| `GET /v1/public/review/:token` | — _(skip: public-inbound, unauthenticated guest surface)_ | Public read-only review bundle | `apps/bay/src/pages/guest-review.tsx` |
| `GET /v1/public/review/:token/media` | — _(skip: public-inbound binary/range media stream)_ | Stream media for a guest (variant=proxy/poster) | `apps/bay/src/pages/guest-review.tsx` |
| `POST /v1/public/review/:token/comments` | — _(skip: public-inbound unauthenticated guest comment)_ | Guest comment on a shared review | `apps/bay/src/pages/guest-review.tsx` |
| `GET /ws` (`/bay/ws`) | — _(skip: realtime/ws — live annotations/decisions)_ | WebSocket: subscribe to a review version's live annotation/decision events | `apps/bay/src/hooks/use-bay-realtime.ts` |
| `GET /assets` | `bay_asset_list` | List review assets (project filter) | `apps/bay/src/hooks/use-bay.ts` |
| `POST /assets` | `bay_asset_create` | Create a review asset (media_kind) | — _(skip: SPA is a follow-up)_ |
| `GET /assets/:id` | `bay_asset_get` | Get asset metadata | — _(skip: SPA is a follow-up)_ |
| `POST /assets/:id/archive` | `bay_asset_archive` | Archive (soft delete) | — _(skip: SPA is a follow-up)_ |
| `GET /assets/:id/versions` | `bay_version_list` | List the immutable version stack | — _(skip: SPA is a follow-up)_ |
| `POST /assets/:id/versions` | `bay_version_create` | Add a version (refs Bin bytes + media_meta) | — _(skip: SPA is a follow-up)_ |
| `GET /versions/:id` | `bay_version_get` | Get one version | — _(skip: SPA is a follow-up)_ |
| `GET /versions/:id/annotations` | `bay_annotation_list` | List coordinate-anchored annotations | — _(skip: SPA is a follow-up)_ |
| `POST /versions/:id/annotations` | `bay_annotation_create` | Post a frame/region/timecode/viewpoint note | — _(skip: SPA is a follow-up)_ |
| `POST /annotations/:id/resolve` | `bay_annotation_resolve` | Resolve/reopen an annotation | — _(skip: SPA is a follow-up)_ |
| `GET /versions/:id/decisions` | `bay_decision_list` | List per-reviewer decisions | — _(skip: SPA is a follow-up)_ |
| `PUT /versions/:id/decision` | `bay_decision_set` | Upsert the caller's review decision | — _(skip: SPA is a follow-up)_ |


## Blip (app)

- **Service:** `apps/blip-api` (internal `:4018/v1`) · external `/blip/api/` · MCP module(s): `blip-tools.ts`
- Telemetry / log-ingest. Tracked apps ship reports through write-only ingest
  keys; entries land in an append-only monthly-partitioned store; humans and
  agents query, tail, watch, and compile them with the same tools/identity/audit
  trail. Canonical bytes for screen captures and JSONL exports live in Bin. The
  public-inbound ingest POST and the live-tail WebSocket are intentionally
  MCP-skipped (§15). Destructive tools (`blip_app_delete`, `blip_key_revoke`,
  `blip_entry_purge`, `blip_watch_delete`) use the inline `confirm_action`
  two-step preview, the `bin_asset_archive` pattern. (REST paths below are
  relative to the `:4018/v1` base the MCP module targets; the external surface
  prefixes them with `/blip/api`.)

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `POST /blip/ingest/v1` | — _(skip: public-inbound — ingest-key write path)_ | Ingest one/many reports | — |
| `GET /blip/ws` | — _(skip: realtime/ws — live tail)_ | Live-tail WebSocket | `apps/blip` viewer |
| `POST /apps` | `blip_app_create` | Declare a tracked app | `apps/blip` |
| `GET /apps` | `blip_app_list` | List tracked apps | `apps/blip` |
| `GET /apps/:id` | `blip_app_get` | App detail + health | `apps/blip` |
| `PATCH /apps/:id` | `blip_app_update` | Edit app config | `apps/blip` |
| `DELETE /apps/:id` | `blip_app_delete` | Delete app + its data (confirm) | `apps/blip` |
| `POST /apps/:id/collection` | `blip_collection_set` | Start/stop collection | `apps/blip` |
| `POST /apps/:id/keys` | `blip_key_create` | Mint a key (token shown once) | `apps/blip` |
| `GET /apps/:id/keys` | `blip_key_list` | List keys (never the secret) | `apps/blip` |
| `POST /keys/:id/suspend` | `blip_key_suspend` | Suspend / resume | `apps/blip` |
| `POST /keys/:id/revoke` | `blip_key_revoke` | Revoke (terminal, confirm) | `apps/blip` |
| `PATCH /keys/:id` | `blip_key_update` | Label / rate-limit override | `apps/blip` |
| `PUT /apps/:id/rate-limit` | `blip_ratelimit_set` | App default rate limit | `apps/blip` |
| `PUT /apps/:id/retention` | `blip_retention_set` | Retention policy (per type) | `apps/blip` |
| `PUT /apps/:id/transform` | `blip_transform_set` | PII transform rules | `apps/blip` |
| `GET /apps/:id/types` | `blip_report_types_list` | Observed report types | `apps/blip` |
| `GET /apps/:id/types/:t/fields` | `blip_field_catalog_list` | Field catalog for a type | `apps/blip` |
| `POST /apps/:id/types/:t/fields/:f/index` | `blip_field_index` | Promote a field to indexed | `apps/blip` |
| `POST /apps/:id/types/:t/fields/:f/metric` | `blip_field_set_metric` | Mark/unmark a Bench metric | `apps/blip` |
| `POST /apps/:id/entries/query` | `blip_entry_query` | Filter/sort/paginate (`format=jsonl` option) | `apps/blip` |
| `POST /apps/:id/entries/tail` | `blip_entry_tail` | Incremental pull: entries with `seq > cursor` | `apps/blip` |
| `POST /apps/:id/entries/purge` | `blip_entry_purge` | Purge a collection (confirm) | `apps/blip` |
| `POST /apps/:id/entries/export` | `blip_entry_export` | Freeze a collection to a Bin JSONL asset | `apps/blip` |
| `GET /captures/:ref/url` | `blip_capture_url` | Presigned GET URL (short TTL) for a capture/thumbnail | `apps/blip` |
| `POST /apps/:id/timelapse` | `blip_timelapse_create` | Compile capture-bearing entries into a video | `apps/blip` |
| `GET /timelapse/:id` | `blip_timelapse_get` | Job status + Bin video asset when ready | `apps/blip` |
| `GET /apps/:id/timelapse` | `blip_timelapse_list` | List timelapse jobs for an app | `apps/blip` |
| `POST /apps/:id/watches` | `blip_watch_create` | Create a match/window watch | `apps/blip` |
| `GET /apps/:id/watches` | `blip_watch_list` | List watches for an app | `apps/blip` |
| `GET /watches/:id` | `blip_watch_get` | Watch detail | `apps/blip` |
| `PATCH /watches/:id` | `blip_watch_update` | Edit a watch | `apps/blip` |
| `POST /watches/:id/enabled` | `blip_watch_set_enabled` | Enable / disable | `apps/blip` |
| `DELETE /watches/:id` | `blip_watch_delete` | Delete a watch (confirm) | `apps/blip` |
| `POST /apps/:id/watches/test` | `blip_watch_test` | Dry-run a predicate over recent entries | `apps/blip` |
| `GET /watches/:id/history` | `blip_watch_history` | Recent firings of a watch | `apps/blip` |
| `POST /views` | `blip_view_create` | Create a saved view | `apps/blip` |
| `GET /apps/:id/types/:t/views` | `blip_view_list` | List views for a type | `apps/blip` |
| `PATCH /views/:id` | `blip_view_update` | Edit a view | `apps/blip` |
| `DELETE /views/:id` | `blip_view_delete` | Delete a view | `apps/blip` |


## Book · Blank · Bill · Bureau · Helpdesk — REST ↔ MCP map

External-path note: all five APIs are reached through nginx. Book/Blank/Bill/Bureau nginx
`location` blocks proxy `/<svc>/api/` to the upstream root, and the upstream registers most
route groups under a `/v1` prefix — so a route `GET /events` is reached externally at
`/book/api/v1/events`. Book/Bill public routes (`/meet/:slug`, `/invoice/:token`) and Blank
public routes (`/forms/:slug`) carry no `/v1` prefix. Helpdesk nginx rewrites `/helpdesk/api/*`
→ `/helpdesk/*` upstream; helpdesk routes already include their own `/helpdesk` (or `/v1`,
or `/helpdesk/agents`) segment in-code.

## Book (app)

- **Service:** `apps/book-api` · external `/book/api/` · MCP module(s): `book-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /book/api/v1/availability/:userId` | `book_get_availability` | Free/busy slots for one user | `apps/book/src/pages/event-form.tsx` |
| `POST /book/api/v1/availability/meeting-time-mixed` | `book_find_meeting_time_for_users` | Mixed human/agent meeting-slot finder | — |
| `GET /book/api/v1/availability/team` | `book_get_team_availability` | Common free slots across users | `apps/book/src/pages/event-form.tsx` |
| `GET /book/api/v1/booking-pages` | `book_list_booking_pages` | List public booking pages | `apps/book/src/hooks/use-booking-pages.ts` |
| `GET /book/api/v1/booking-pages/:id` | — _(skip: editor load; covered by list tool)_ | Load one booking page for the editor | `apps/book/src/hooks/use-booking-pages.ts` |
| `POST /book/api/v1/booking-pages` | `book_create_booking_page` | Create a scheduling link page | `apps/book/src/hooks/use-booking-pages.ts` |
| `PATCH /book/api/v1/booking-pages/:id` | `book_update_booking_page` | Update a booking page | `apps/book/src/pages/booking-page-editor.tsx` |
| `DELETE /book/api/v1/booking-pages/:id` | `book_delete_booking_page` | Delete a booking page | `apps/book/src/hooks/use-booking-pages.ts` |
| `GET /book/api/v1/calendars` | `book_list_calendars` | List caller's calendars (resolver source) | `apps/book/src/hooks/use-calendars.ts` |
| `POST /book/api/v1/calendars` | `book_create_calendar` | Create a calendar | `apps/book/src/hooks/use-calendars.ts` |
| `PATCH /book/api/v1/calendars/:id` | `book_update_calendar` | Update a calendar | `apps/book/src/hooks/use-calendars.ts` |
| `DELETE /book/api/v1/calendars/:id` | `book_delete_calendar` | Delete a calendar | `apps/book/src/hooks/use-calendars.ts` |
| `POST /book/api/v1/calendars/:id/ical` | — _(skip: iCal feed token mint)_ | Mint an iCal feed token | `apps/book/src/pages/connections.tsx` |
| `GET /book/api/v1/calendars/:id/ical` | — _(skip: public token-auth .ics feed)_ | Public token-auth `.ics` feed | — (external calendar client) |
| `GET /book/api/v1/connections` | `book_list_connections` | List external calendar connections | `apps/book/src/hooks/use-connections.ts` |
| `POST /book/api/v1/connections/ics` | `book_create_connection` | Subscribe to an .ics feed (no-OAuth provider path) | `apps/book/src/hooks/use-connections.ts` |
| `POST /book/api/v1/connections/google` | — _(skip: needs operator Google OAuth creds; not yet wired)_ | Connect a Google calendar | `apps/book/src/pages/connections.tsx` |
| `POST /book/api/v1/connections/microsoft` | — _(skip: needs operator Microsoft OAuth creds; not yet wired)_ | Connect a Microsoft calendar | `apps/book/src/pages/connections.tsx` |
| `DELETE /book/api/v1/connections/:id` | `book_delete_connection` | Remove a calendar connection (and its mirror events) | `apps/book/src/hooks/use-connections.ts` |
| `POST /book/api/v1/connections/:id/sync` | `book_sync_connection` | Force-sync a connection (runs the engine inline) | `apps/book/src/hooks/use-connections.ts` |
| `POST /book/api/v1/internal/connections/sync-due` | — _(skip: internal service-to-service; worker sync sweep)_ | Sync all due connections | `apps/worker/src/jobs/book-calendar-sync.job.ts` |
| `GET /book/api/v1/events` | `book_list_events` | List events in a date range | `apps/book/src/hooks/use-events.ts` |
| `POST /book/api/v1/events` | `book_create_event` | Create an event with attendees | `apps/book/src/hooks/use-events.ts` |
| `GET /book/api/v1/events/:id` | `book_get_event` | Get one event | `apps/book/src/pages/event-detail.tsx` |
| `PATCH /book/api/v1/events/:id` | `book_update_event` | Update an event | `apps/book/src/hooks/use-events.ts` |
| `DELETE /book/api/v1/events/:id` | `book_cancel_event` | Soft-cancel an event | `apps/book/src/hooks/use-events.ts` |
| `POST /book/api/v1/events/:id/rsvp` | `book_rsvp_event` | Accept/decline/tentative RSVP | `apps/book/src/pages/event-detail.tsx` |
| `GET /book/api/v1/timeline` | `book_get_timeline` | Cross-product aggregated timeline | `apps/book/src/pages/timeline.tsx` |
| `GET /book/api/v1/working-hours` | `book_get_working_hours` | Get caller's working hours | `apps/book/src/pages/connections.tsx` |
| `PUT /book/api/v1/working-hours` | `book_set_working_hours` | Set caller's working hours | `apps/book/src/pages/connections.tsx` |
| `GET /book/api/meet/:slug` | — _(skip: public-inbound booking page)_ | Public booking-page info | `apps/book/src/pages/meet.tsx` |
| `GET /book/api/meet/:slug/slots` | — _(skip: public-inbound booking page)_ | Public available slots | `apps/book/src/pages/meet.tsx` |
| `POST /book/api/meet/:slug/book` | — _(skip: public-inbound booking intake)_ | Public slot booking | `apps/book/src/pages/meet.tsx` |
| `GET /book/api/v1/availability/team` *(reused)* | `book_find_meeting_time` | AI: top-3 common slots (client-side intersect) | — |


## Blank (app)

- **Service:** `apps/blank-api` · external `/blank/api/` · MCP module(s): `blank-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /blank/api/v1/fields/:id` *(none)* | — | *(no field GET; see PATCH/DELETE)* | — |
| `PATCH /blank/api/v1/fields/:id` | `blank_update_field` | Update a form field | `apps/blank/src/pages/form-builder.tsx` |
| `DELETE /blank/api/v1/fields/:id` | `blank_delete_field` | Delete a form field | `apps/blank/src/pages/form-builder.tsx` |
| `GET /blank/api/v1/forms` | `blank_list_forms` | List forms (status/project filters) | `apps/blank/src/hooks/use-forms.ts` |
| `POST /blank/api/v1/forms` | `blank_create_form` | Create a form with inline fields | `apps/blank/src/hooks/use-forms.ts` |
| `GET /blank/api/v1/forms/:id` | `blank_get_form` | Get a form with its fields | `apps/blank/src/hooks/use-forms.ts` |
| `PATCH /blank/api/v1/forms/:id` | `blank_update_form` | Update form metadata/settings | `apps/blank/src/pages/form-settings.tsx` |
| `DELETE /blank/api/v1/forms/:id` | `blank_delete_form` | Delete a form | `apps/blank/src/hooks/use-forms.ts` |
| `GET /blank/api/v1/forms/:id/analytics` | `blank_summarize_responses` · `blank_get_form_analytics` | Per-field response aggregation | `apps/blank/src/pages/form-analytics.tsx` |
| `POST /blank/api/v1/forms/:id/close` | `blank_close_form` | Close a form to submissions | `apps/blank/src/pages/form-settings.tsx` |
| `POST /blank/api/v1/forms/:id/duplicate` | `blank_duplicate_form` | Clone a form | `apps/blank/src/hooks/use-forms.ts` |
| `GET /blank/api/v1/forms/:id/embed-code` | `blank_get_embed_code` | Get embed snippet | `apps/blank/src/pages/form-settings.tsx` |
| `POST /blank/api/v1/forms/:id/fields` | `blank_add_field` | Add a field to a form | `apps/blank/src/pages/form-builder.tsx` |
| `POST /blank/api/v1/forms/:id/fields/reorder` | `blank_reorder_fields` | Bulk reorder fields | `apps/blank/src/pages/form-builder.tsx` |
| `POST /blank/api/v1/forms/:id/publish` | `blank_publish_form` | Publish a draft form | `apps/blank/src/pages/form-settings.tsx` |
| `GET /blank/api/v1/forms/:id/submissions` | `blank_list_submissions` | List a form's submissions | `apps/blank/src/pages/form-responses.tsx` |
| `GET /blank/api/v1/forms/:id/submissions/export` | `blank_export_submissions` | Export submissions as CSV | `apps/blank/src/pages/form-responses.tsx` |
| `GET /blank/api/v1/submissions/:id` | `blank_get_submission` | Get one submission's data | `apps/blank/src/pages/form-responses.tsx` |
| `GET /blank/api/v1/submissions/:id/files/:idx` | — _(skip: multipart/binary download, org-scoped auth)_ | Stream a stored submission attachment from MinIO | `apps/blank/src/pages/form-responses.tsx` |
| `DELETE /blank/api/v1/submissions/:id` | `blank_delete_submission` | Delete a submission | `apps/blank/src/pages/form-responses.tsx` |
| `GET /blank/api/forms/:slug` | — _(skip: public-inbound form render)_ | Public rendered form HTML | `apps/blank/src/pages/public-form.tsx` |
| `GET /blank/api/forms/:slug/definition` | — _(skip: public-inbound form definition)_ | Public form field definitions | `apps/blank/src/pages/public-form.tsx` |
| `POST /blank/api/forms/:slug/submit` | — _(skip: public-inbound form intake)_ | Public submit a response | `apps/blank/src/pages/public-form.tsx` |
| `POST /blank/api/forms/:slug/upload` | — _(skip: public-inbound multipart file upload)_ | Public store a submission file in MinIO | `apps/blank-api/src/lib/form-renderer.ts` |
| `— *(client-side)*` | `blank_generate_form` | AI builds a form spec from NL description | — |


## Bill (app)

- **Service:** `apps/bill-api` · external `/bill/api/` · MCP module(s): `bill-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /bill/api/v1/clients` | `bill_list_clients` | List/search billing clients | `apps/bill/src/hooks/use-clients.ts` |
| `POST /bill/api/v1/clients` | `bill_create_client` | Create a billing client | `apps/bill/src/hooks/use-clients.ts` |
| `GET /bill/api/v1/clients/:id` | `bill_get_client` | Get one client | `apps/bill/src/pages/client-detail.tsx` |
| `PATCH /bill/api/v1/clients/:id` | `bill_update_client` | Update a client | `apps/bill/src/hooks/use-clients.ts` |
| `DELETE /bill/api/v1/clients/:id` | `bill_delete_client` | Delete a client | `apps/bill/src/hooks/use-clients.ts` |
| `GET /bill/api/v1/expenses` | `bill_list_expenses` | List expenses (filters) | `apps/bill/src/hooks/use-expenses.ts` |
| `POST /bill/api/v1/expenses` | `bill_create_expense` | Log an expense | `apps/bill/src/hooks/use-expenses.ts` |
| `PATCH /bill/api/v1/expenses/:id` | `bill_update_expense` | Update an expense | `apps/bill/src/hooks/use-expenses.ts` |
| `DELETE /bill/api/v1/expenses/:id` | `bill_delete_expense` | Delete an expense | `apps/bill/src/hooks/use-expenses.ts` |
| `POST /bill/api/v1/expenses/:id/approve` | `bill_approve_expense` | Approve an expense | `apps/bill/src/pages/expense-list.tsx` |
| `POST /bill/api/v1/expenses/:id/reject` | `bill_reject_expense` | Reject an expense | `apps/bill/src/pages/expense-list.tsx` |
| `POST /bill/api/v1/expenses/:id/reimburse` | — _(skip: deferred — UI-only terminal state transition, approved→reimbursed)_ | Mark an approved expense reimbursed | `apps/bill/src/pages/expense-list.tsx` |
| `POST /bill/api/v1/expenses/:id/receipt` | — _(skip: multipart receipt upload)_ | Upload a receipt file | `apps/bill/src/pages/expense-new.tsx` |
| `GET /bill/api/v1/invoices` | `bill_list_invoices` | List invoices (filters) | `apps/bill/src/hooks/use-invoices.ts` |
| `POST /bill/api/v1/invoices` | `bill_create_invoice` | Create a draft invoice | `apps/bill/src/hooks/use-invoices.ts` |
| `GET /bill/api/v1/invoices/:id` | `bill_get_invoice` | Get invoice detail | `apps/bill/src/pages/invoice-detail.tsx` |
| `PATCH /bill/api/v1/invoices/:id` | `bill_update_invoice` | Update an invoice | `apps/bill/src/pages/invoice-edit.tsx` |
| `DELETE /bill/api/v1/invoices/:id` | `bill_delete_invoice` | Delete an invoice | `apps/bill/src/hooks/use-invoices.ts` |
| `POST /bill/api/v1/invoices/:id/duplicate` | `bill_duplicate_invoice` | Duplicate an invoice | `apps/bill/src/pages/invoice-detail.tsx` |
| `POST /bill/api/v1/invoices/:id/finalize` | `bill_finalize_invoice` | Finalize, assign number, lock | `apps/bill/src/pages/invoice-detail.tsx` |
| `GET /bill/api/v1/invoices/:id/jobs` | `bill_get_invoice_jobs` | Latest PDF/email job state | `apps/bill/src/pages/invoice-detail.tsx` |
| `POST /bill/api/v1/invoices/:id/line-items` | `bill_add_line_item` | Add a line item | `apps/bill/src/pages/invoice-edit.tsx` |
| `PATCH /bill/api/v1/invoices/:id/line-items/:itemId` | `bill_update_line_item` | Update a line item | `apps/bill/src/pages/invoice-edit.tsx` |
| `DELETE /bill/api/v1/invoices/:id/line-items/:itemId` | `bill_delete_line_item` | Delete a line item | `apps/bill/src/pages/invoice-edit.tsx` |
| `POST /bill/api/v1/invoices/:id/payments` | `bill_record_payment` | Record a payment | `apps/bill/src/pages/invoice-detail.tsx` |
| `GET /bill/api/v1/invoices/:id/pdf` | — _(skip: binary PDF export)_ | Generate/return invoice PDF | `apps/bill/src/pages/invoice-detail.tsx` |
| `POST /bill/api/v1/invoices/:id/send` | `bill_send_invoice` | Mark sent, queue email | `apps/bill/src/pages/invoice-detail.tsx` |
| `POST /bill/api/v1/invoices/:id/void` | `bill_void_invoice` | Void an invoice | `apps/bill/src/pages/invoice-detail.tsx` |
| `POST /bill/api/v1/invoices/from-deal` | `bill_create_invoice_from_deal` | Draft invoice from a Bond deal | — |
| `POST /bill/api/v1/invoices/from-time-entries` | `bill_create_invoice_from_time` | Invoice from Bam time entries | `apps/bill/src/pages/invoice-from-time.tsx` |
| `GET /bill/api/v1/recurring-invoices` | `bill_list_recurring_invoices` | List recurring/subscription schedules | `apps/bill/src/hooks/use-recurring.ts` |
| `POST /bill/api/v1/recurring-invoices` | `bill_create_recurring_invoice` | Create a recurring schedule | `apps/bill/src/pages/recurring-list.tsx` |
| `GET /bill/api/v1/recurring-invoices/:id` | `bill_get_recurring_invoice` | Get a schedule + line-item template | `apps/bill/src/hooks/use-recurring.ts` |
| `PATCH /bill/api/v1/recurring-invoices/:id` | `bill_update_recurring_invoice` | Update a recurring schedule | `apps/bill/src/hooks/use-recurring.ts` |
| `POST /bill/api/v1/recurring-invoices/:id/pause` | `bill_pause_recurring_invoice` | Pause generation | `apps/bill/src/pages/recurring-list.tsx` |
| `POST /bill/api/v1/recurring-invoices/:id/resume` | `bill_resume_recurring_invoice` | Resume generation | `apps/bill/src/pages/recurring-list.tsx` |
| `POST /bill/api/v1/recurring-invoices/:id/cancel` | `bill_cancel_recurring_invoice` | Cancel a schedule permanently | `apps/bill/src/pages/recurring-list.tsx` |
| `POST /bill/api/v1/recurring-invoices/:id/generate-now` | `bill_generate_recurring_invoice_now` | Materialise an invoice immediately | `apps/bill/src/pages/recurring-list.tsx` |
| `DELETE /bill/api/v1/payments/:id` | `bill_delete_payment` | Delete a payment | `apps/bill/src/pages/invoice-detail.tsx` |
| `GET /bill/api/v1/rates` | `bill_list_rates` | List billing rates | `apps/bill/src/hooks/use-rates.ts` |
| `POST /bill/api/v1/rates` | `bill_create_rate` | Create a rate | `apps/bill/src/hooks/use-rates.ts` |
| `PATCH /bill/api/v1/rates/:id` | `bill_update_rate` | Update a rate | `apps/bill/src/hooks/use-rates.ts` |
| `DELETE /bill/api/v1/rates/:id` | `bill_delete_rate` | Delete a rate | `apps/bill/src/hooks/use-rates.ts` |
| `GET /bill/api/v1/rates/resolve` | `bill_resolve_rate` | Resolve effective rate (project/user/date) | — |
| `GET /bill/api/v1/reports/outstanding` | `bill_get_outstanding` | Outstanding-balance report | `apps/bill/src/hooks/use-reports.ts` |
| `GET /bill/api/v1/reports/overdue` | `bill_get_overdue` | Overdue invoices report | `apps/bill/src/hooks/use-reports.ts` |
| `GET /bill/api/v1/reports/profitability` | `bill_get_profitability` | Revenue-vs-expense per project | `apps/bill/src/hooks/use-reports.ts` |
| `GET /bill/api/v1/reports/revenue` | `bill_get_revenue_summary` | Revenue summary by month | `apps/bill/src/hooks/use-reports.ts` |
| `GET /bill/api/v1/settings` | `bill_get_settings` | Get org billing settings | `apps/bill/src/pages/settings.tsx` |
| `PUT /bill/api/v1/settings` | `bill_update_settings` | Update org billing settings | `apps/bill/src/pages/settings.tsx` |
| `GET /bill/api/invoice/:token` | — _(skip: public token-auth invoice view)_ | Public token-auth invoice view | — (public link) |
| `GET /bill/api/invoice/:token/pdf` | — _(skip: public binary PDF)_ | Public token-auth invoice PDF | — (public link) |


## Bureau (app)

- **Service:** `apps/bureau-api` · external `/bureau/api/` · MCP module(s): `bureau-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /bureau/api/v1/bookings/:id` *(none)* | — | *(no booking GET; PATCH/DELETE only)* | — |
| `PATCH /bureau/api/v1/bookings/:id` | `bureau_update_booking` | Update a room booking window | — |
| `DELETE /bureau/api/v1/bookings/:id` | `bureau_cancel_booking` | Soft-cancel a booking (confirm) | `apps/bureau/src/pages/booking.tsx` |
| `GET /bureau/api/v1/chat/rooms` | `bureau_list_chats` | List caller's chat threads | `apps/bureau/src/pages/chats.tsx` |
| `GET /bureau/api/v1/chat/rooms/:roomKey/messages` | `bureau_get_chat_messages` | Chat transcript recovery | `apps/bureau/src/pages/chats.tsx` |
| `PATCH /bureau/api/v1/chat/rooms/:roomKey/retention` | `bureau_set_chat_retention` | Set chat retention (admin) | `apps/bureau/src/pages/chats.tsx` |
| `GET /bureau/api/v1/floors` | `bureau_list_floors` | List floors with occupancy | `apps/bureau/src/hooks/use-floors.ts` |
| `POST /bureau/api/v1/floors` | `bureau_create_floor` | Create a floor (admin) | `apps/bureau/src/pages/admin/floor-list.tsx` |
| `GET /bureau/api/v1/floors/:id` | `bureau_get_floor` | Floor detail + rooms + occupancy | `apps/bureau/src/hooks/use-floors.ts` |
| `PATCH /bureau/api/v1/floors/:id` | `bureau_update_floor` | Update/unarchive a floor (admin) | `apps/bureau/src/pages/admin/floor-editor.tsx` |
| `DELETE /bureau/api/v1/floors/:id` | `bureau_delete_floor` | Soft-delete a floor (admin) | `apps/bureau/src/pages/admin/floor-list.tsx` |
| `POST /bureau/api/v1/floors/:id/background` | `bureau_set_floor_background` | Set floor background URL (admin) | `apps/bureau/src/pages/admin/floor-editor.tsx` |
| `POST /bureau/api/v1/knocks` | `bureau_knock` | Knock on an office door | `apps/bureau/src/stores/bureau-store.ts` |
| `PATCH /bureau/api/v1/knocks/:id` | `bureau_respond_knock` | Owner admits/defers/declines | `apps/bureau/src/stores/bureau-store.ts` |
| `GET /bureau/api/v1/knocks/inbox` | `bureau_knock_inbox` | Pending knocks for the owner | `apps/bureau/src/stores/bureau-store.ts` |
| `POST /bureau/api/v1/knocks/leave-note` | `bureau_leave_note` | DND fallback: DM the owner | `apps/bureau/src/stores/bureau-store.ts` |
| `GET /bureau/api/v1/offices` | `bureau_list_offices` | All offices + owners (admin) | `apps/bureau/src/pages/admin/offices.tsx` |
| `POST /bureau/api/v1/offices/assign` | `bureau_assign_office` | Assign an office to a user (admin) | `apps/bureau/src/pages/admin/offices.tsx` |
| `GET /bureau/api/v1/offices/mine` | `bureau_my_office` | Caller's owned office | `apps/bureau/src/pages/floor-list.tsx` |
| `GET /bureau/api/v1/presence` | `bureau_get_presence` | Org-wide live presence snapshot | — |
| `GET /bureau/api/v1/presence/here` | `bureau_who_is_here` | Co-presence by URL chip | `apps/bureau/src/hooks/use-bureau-ws.ts` |
| `GET /bureau/api/v1/presence/locate` | `bureau_locate_user` | Locate a user's current room/floor | — |
| `GET /bureau/api/v1/presence/where/:userId` | `bureau_where_is_user` | Locate a user ("Hunt") | `apps/bureau/src/hooks/use-bureau-ws.ts` |
| `PATCH /bureau/api/v1/me/status` | `bureau_set_status` | Set + persist caller's presence status | — |
| `POST /bureau/api/v1/ring` | — _(skip: realtime ring signal — not wrapped)_ | Ring a user on a surface | `apps/bureau/src/hooks/use-bureau-ws.ts` |
| `GET /bureau/api/v1/rooms` | `bureau_list_rooms` | List org rooms (bookable filter) + floor name | `apps/bureau/src/hooks/use-rooms.ts` |
| `GET /bureau/api/v1/rooms/:id` | `bureau_who_is_in_room` | Room detail + live occupants | `apps/bureau/src/components/floor-editor/room-inspector.tsx` |
| `POST /bureau/api/v1/rooms` | `bureau_create_room` | Create a room on a floor | `apps/bureau/src/pages/admin/floor-editor.tsx` |
| `PATCH /bureau/api/v1/rooms/:id` | `bureau_update_room` | Update room fields | `apps/bureau/src/components/floor-editor/room-inspector.tsx` |
| `DELETE /bureau/api/v1/rooms/:id` | `bureau_delete_room` | Soft-delete a room (admin) | `apps/bureau/src/pages/admin/floor-editor.tsx` |
| `POST /bureau/api/v1/rooms/:id/acl` | — _(skip: room ACL admin — not wrapped)_ | Upsert a room ACL entry | `apps/bureau/src/components/floor-editor/room-inspector.tsx` |
| `DELETE /bureau/api/v1/rooms/:id/acl/:userId` | — _(skip: room ACL admin — not wrapped)_ | Remove a room ACL entry | `apps/bureau/src/components/floor-editor/room-inspector.tsx` |
| `GET /bureau/api/v1/rooms/:id/bookings` | `bureau_list_bookings` | List room bookings in a window | `apps/bureau/src/hooks/use-rooms.ts` |
| `POST /bureau/api/v1/rooms/:id/bookings` | `bureau_book_room` | Reserve a room (confirm) | `apps/bureau/src/pages/booking.tsx` |
| `PATCH /bureau/api/v1/rooms/:id/door` | `bureau_set_door_state` | Set room default privacy | `apps/bureau/src/components/floor-editor/room-inspector.tsx` |
| `POST /bureau/api/v1/rooms/:id/token` | `bureau_move_self` | Mint LiveKit token / enter room | `apps/bureau/src/hooks/use-bureau-ws.ts` |
| `POST /bureau/api/v1/summon` | `bureau_summon` | Summon co-occupants to a URL (confirm) | `apps/bureau/src/stores/bureau-store.ts` |
| `GET /bureau/api/v1/summons/:id` | `bureau_get_summon` | Summon audit-row lookup | — |
| `POST /bureau/api/v1/summons/:id/grant-access` | `bureau_summon_grant_access` | Grant-and-summon follow-up | `apps/bureau/src/stores/bureau-store.ts` |
| `POST /bureau/api/v1/surface-huddle/token` | — _(skip: LiveKit token mint)_ | Mint surface-huddle LiveKit token | `apps/bureau/src/hooks/use-bureau-ws.ts` |
| `GET /bureau/api/v1/settings` | `bureau_get_settings` | Get org Bureau settings | `apps/bureau/src/pages/admin/settings.tsx` |
| `PATCH /bureau/api/v1/settings` | `bureau_update_settings` | Update Bureau settings (admin) | `apps/bureau/src/pages/admin/settings.tsx` |


## Helpdesk (app)

- **Service:** `apps/helpdesk-api` · external `/helpdesk/api/` · MCP module(s): `helpdesk-tools.ts`, `dedupe-tools.ts`, `phrase-count-tools.ts`

(nginx rewrites `/helpdesk/api/*` → `/helpdesk/*`; the in-code `/helpdesk` segment below is what
the upstream registers, so external path = `/helpdesk/api/` + the part after `/helpdesk/`.)

> **Helpdesk auth coupling (whole surface).** helpdesk-api authenticates against its OWN credential
> system — a `helpdesk_session` cookie (customer/admin) or a per-agent `X-Agent-Key` (`hdag_`-prefixed)
> on `/helpdesk/api/agents/*` — NOT the Bam Bearer token + `X-Org-Id` that the MCP wrappers forward.
> A Bam service-account Bearer is rejected by both `requireAdminAuth` and `requireAgentAuth` (verified
> by local smoke: even `helpdesk_get_settings` returns `UNAUTHORIZED`). So the `/helpdesk/api/agents/*`
> mutation routes are left `—`, and the helpdesk MCP tools are only reachable when the forwarded
> credential maps to a valid helpdesk session/agent key. Giving the MCP service account first-class
> helpdesk access (mint + thread an `X-Agent-Key`, or have helpdesk-api trust a Bam service token) is a
> tracked cross-service auth follow-up. Fixed this pass: the `by-number` resolver path now targets the
> real agent route (`/helpdesk/agents/tickets/by-number/:number`) — it reaches the route (then gates on
> the agent key) instead of 404-ing on a path that never existed.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /helpdesk/api/agents/agents/queue` | — _(skip: agent routes require X-Agent-Key, not Bearer — deferred)_ | Agent SLA-aware ticket queue | — (agent console) |
| `GET /helpdesk/api/agents/tickets` | `list_tickets` *(via customer route)* | Agent: org-scoped ticket list | — |
| `GET /helpdesk/api/agents/tickets/:id` | — _(skip: agent routes require X-Agent-Key, not Bearer — deferred)_ | Agent: ticket detail + internal msgs | — |
| `GET /helpdesk/api/agents/tickets/:id/similar` | `helpdesk_find_similar_tickets` | Ranked similar/duplicate tickets | — |
| `POST /helpdesk/api/agents/tickets/:id/close` | — _(skip: agent routes require X-Agent-Key, not Bearer — deferred)_ | Agent: close a ticket | — |
| `POST /helpdesk/api/agents/tickets/:id/merge` | — _(skip: agent routes require X-Agent-Key, not Bearer — deferred)_ | Agent: true-merge into a primary | — |
| `POST /helpdesk/api/agents/tickets/:id/messages` | — _(skip: agent routes require X-Agent-Key, not Bearer — deferred)_ | Agent: post reply/internal note | — |
| `PATCH /helpdesk/api/agents/tickets/:id` | — _(skip: agent routes require X-Agent-Key, not Bearer — deferred)_ | Agent: update status/priority/category | — |
| `GET /helpdesk/api/agents/tickets/by-number/:number` | `helpdesk_get_ticket_by_number` | Resolve ticket by human number | — |
| `GET /helpdesk/api/agents/tickets/search` | `helpdesk_search_tickets` | Fuzzy ticket search (agent, org-scoped) | — |
| `GET /helpdesk/api/admin/projects` | — _(skip: admin project resolver (used internally))_ | List org projects for default picker | `apps/helpdesk/src/pages/org-picker.tsx` |
| `GET /helpdesk/api/events` | — _(skip: SSE event stream — not an agent surface)_ | Replay event log across own tickets | `apps/helpdesk/src/hooks/use-tickets.ts` |
| `GET /helpdesk/api/public-settings` | `helpdesk_get_public_settings` | Public helpdesk settings (no auth) | `apps/helpdesk/src/pages/register.tsx` |
| `GET /helpdesk/api/public/orgs` | — _(skip: public portal discovery (resolver))_ | Public org-picker list | `apps/helpdesk/src/pages/org-picker.tsx` |
| `GET /helpdesk/api/public/orgs/:slug` | — _(skip: public portal discovery (resolver))_ | Public org/portal discovery | `apps/helpdesk/src/stores/tenant.store.ts` |
| `GET /helpdesk/api/settings` | `helpdesk_get_settings` · `helpdesk_set_default_project` | Full settings (admin) | `apps/helpdesk/src/app.tsx` |
| `PATCH /helpdesk/api/settings` | `helpdesk_update_settings` · `helpdesk_set_default_project` | Update settings (admin) | `apps/helpdesk/src/app.tsx` |
| `GET /helpdesk/api/tickets` | `list_tickets` | List caller's own tickets | `apps/helpdesk/src/hooks/use-tickets.ts` |
| `POST /helpdesk/api/tickets` | — _(skip: public/customer ticket intake — customer JWT)_ | Create a ticket (customer) | `apps/helpdesk/src/pages/new-ticket.tsx` |
| `GET /helpdesk/api/tickets/search` | `helpdesk_search_tickets` *(agent route)* | Customer FTS over own tickets | `apps/helpdesk/src/pages/tickets-list.tsx` |
| `GET /helpdesk/api/tickets/:id` | `get_ticket` | Ticket detail + messages | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `GET /helpdesk/api/tickets/by-number/:number` *(agent)* | `helpdesk_get_ticket_by_number` | Resolve by number — tool uses agent route | — |
| `GET /helpdesk/api/tickets/:id/activity` | — _(skip: customer-portal route — customer JWT, not Bearer)_ | Ticket audit trail | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `GET /helpdesk/api/tickets/:id/attachments` | — _(skip: multipart attachment upload/download)_ | List ticket attachments | `apps/helpdesk/src/hooks/use-attachments.ts` |
| `POST /helpdesk/api/tickets/:id/attachments` | — _(skip: multipart attachment upload/download)_ | Upload a ticket attachment | `apps/helpdesk/src/hooks/use-attachments.ts` |
| `DELETE /helpdesk/api/tickets/:id/attachments/:attachmentId` | — _(skip: multipart attachment upload/download)_ | Delete a ticket attachment | `apps/helpdesk/src/hooks/use-attachments.ts` |
| `GET /helpdesk/api/tickets/:id/events` | — _(skip: SSE event stream — not an agent surface)_ | Per-ticket event-log replay | `apps/helpdesk/src/hooks/use-tickets.ts` |
| `GET /helpdesk/api/tickets/:id/messages` | — _(skip: customer-portal route — customer JWT, not Bearer)_ | Paginated message history | `apps/helpdesk/src/hooks/use-ticket-messages.ts` |
| `POST /helpdesk/api/tickets/:id/messages` | `reply_to_ticket` | Post a message (customer/agent) | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `PATCH /helpdesk/api/tickets/:id` *(agent route)* | `update_ticket_status` | Update ticket status (tool → agent route) | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `POST /helpdesk/api/tickets/:id/close` | — _(skip: customer-portal route — customer JWT, not Bearer)_ | Customer closes own ticket | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `POST /helpdesk/api/tickets/:id/reopen` | — _(skip: customer-portal route — customer JWT, not Bearer)_ | Customer reopens a ticket | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `POST /helpdesk/api/tickets/:id/update-priority` | — _(skip: customer-portal route — customer JWT, not Bearer)_ | Customer changes priority | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `POST /helpdesk/api/tickets/:id/mark-duplicate` | — _(skip: customer-portal route — customer JWT, not Bearer)_ | Customer flags duplicate | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `DELETE /helpdesk/api/tickets/:id/mark-duplicate` | — _(skip: customer-portal route — customer JWT, not Bearer)_ | Customer clears duplicate flag | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `POST /helpdesk/api/upload` | — _(skip: multipart attachment upload/download)_ | Generic multipart file upload | `apps/helpdesk/src/pages/new-ticket.tsx` |
| `GET /helpdesk/api/v1/tickets/analytics/count-by-phrase` | `helpdesk_ticket_count_by_phrase` | Ticket counts bucketed by phrase | — |
| `POST /helpdesk/api/v1/helpdesk-users/upsert` | `helpdesk_upsert_user` | Idempotent helpdesk-user upsert | — |


## Cross-app / agentic platform surface

External prefix for the Bam api is `/b3/api/`, so a route shown as `POST /v1/proposals` is reachable externally at `/b3/api/v1/proposals`. Routes whose path begins with `/internal/` are service-to-service only (NOT exposed through nginx) and are labeled accordingly. A handful of MCP tools fan out across several apps with no single backing endpoint; those are marked `— *(composite)*` with the services they hit named in the description.

## Cross-app — Agent identity, audit & heartbeat

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/agent-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /v1/agents` | `agent_list` | List agent runners in caller's active org | — |
| `GET /v1/agents/:agent_user_id/audit` | `agent_audit` | Paginated `activity_log` stream for one agent | — |
| `POST /v1/agents/heartbeat` | `agent_heartbeat` | Service-account only; upsert `agent_runners` row | — |
| `POST /v1/agents/self-report` | `agent_self_report` | Service-account only; append `agent.self_report` log | — |


## Cross-app — Approval queues (proposals)

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/proposal-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /v1/approvals` | — _(skip: deprecated — use proposal_create / proposal_list)_ | Deprecated fire-and-forget `approval.requested` emitter | — |
| `GET /v1/proposals` | `proposal_list` | List proposals visible to caller | — |
| `POST /v1/proposals` | `proposal_create` | Create a durable, decidable proposal | — |
| `POST /v1/proposals/:id/decide` | `proposal_decide` | Approve / reject / request_revision a proposal | — |


## Cross-app — Visibility preflight

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/visibility-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /v1/visibility/can_access` | `can_access` | Preflight whether an asker may see an entity | — |


## Cross-app — Unified activity

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/activity-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /v1/activity/unified` | `activity_query` | Unified activity for one `(entity_type, entity_id)` | — |
| `GET /v1/activity/unified/by-actor` | `activity_by_actor` | Unified activity by actor, org-scoped | — |


## Cross-app — Read plane (search, resolve, composite views)

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/search-tools.ts`, `apps/mcp-server/src/tools/resolve-tools.ts`, `apps/mcp-server/src/tools/composite-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `— *(composite)*` | `account_view` | Account page: fans out to bond, helpdesk, bill, bam, activity | — |
| `— *(composite)*` | `project_view` | Project overview: bam, bearing, brief, beacon | — |
| `— *(composite)*` | `resolve_references` | Fuzzy mention resolver across bam, bond, helpdesk, brief | — |
| `— *(composite)*` | `search_everything` | Unified search across bam, helpdesk, bond, brief, beacon, banter, board | — |
| `— *(composite)*` | `user_view` | Person profile: bam, bond, helpdesk, bearing, activity | — |


## Cross-app — Entity links

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/entity-links-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `DELETE /v1/entity-links/:id` | `entity_link_remove` | Remove a cross-app entity link | — |
| `GET /v1/entity-links` | `entity_links_list` | List links for an entity (src/dst/both) | — |
| `POST /v1/entity-links` | `entity_link_create` | Create a cross-app link with cycle detection | — |


## Cross-app — Federated attachments

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/attachment-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /v1/attachments` | `attachment_list` | List attachments for a parent entity, preflighted | — |
| `GET /v1/attachments/:id` | `attachment_get` | Get one attachment's metadata, visibility-gated | — |
| `GET /v1/attachments/_meta` | `attachment_meta` | Supported parent types and scan-status values | — |


## Cross-app — Agent policies & outbound webhooks

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/agent-policy-tools.ts`, `apps/mcp-server/src/tools/agent-webhook-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /v1/agent-policies` | `agent_policy_list` | List agent policy rows in caller's org | `apps/frontend/src/pages/superuser/agents-list.tsx` |
| `GET /v1/agent-policies/:agent_user_id` | `agent_policy_get` | Get one agent's kill-switch + allowlist policy | — |
| `POST /v1/agent-policies/:agent_user_id` | `agent_policy_set` | Upsert an agent policy (enabled, allowed_tools, etc.) | `apps/frontend/src/pages/superuser/agents-list.tsx` |
| `POST /v1/agent-policies/:agent_user_id/check` | — _(skip: internal policy-check (register-tool wrapper))_ | Internal tool-name allow/deny check (register-tool wrapper) | — |
| `GET /v1/agent-webhook-deliveries` | `agent_webhook_deliveries_list` | List recent outbound webhook deliveries | — |
| `POST /v1/agent-webhook-deliveries/:delivery_id/redeliver` | `agent_webhook_redeliver` | Re-enqueue a webhook delivery | — |
| `POST /v1/agent-runners/:runner_user_id/webhook` | `agent_webhook_configure` | Configure a runner's outbound webhook + secret | — |
| `POST /v1/agent-runners/:runner_user_id/webhook/rotate` | `agent_webhook_rotate_secret` | Rotate the webhook HMAC signing secret | — |


## Cross-app — Dedupe / phrase counts / expertise / ingest-fingerprint

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/dedupe-tools.ts`, `apps/mcp-server/src/tools/phrase-count-tools.ts`, `apps/mcp-server/src/tools/expertise-tools.ts`, `apps/mcp-server/src/tools/ingest-fingerprint-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /v1/dedupe-decisions/pending` | `dedupe_list_pending` | List pending / due-for-resurface dedupe pairs | — |
| `POST /v1/dedupe-decisions` | `dedupe_record_decision` | Record a canonicalized dedupe decision | — |
| `POST /v1/expertise/for-topic` | `expertise_for_topic` | Rank org experts for a topic across signals | — |
| `bond-api GET /contacts/:id/duplicates` | `bond_find_duplicates` | Likely duplicate contacts (bond-api, not Bam api) | — |
| `helpdesk-api GET /helpdesk/agents/tickets/:id/similar` | `helpdesk_find_similar_tickets` | Similar tickets (helpdesk-api, not Bam api) | — |
| `api GET /v1/tasks/analytics/count-by-phrase` | `bam_task_count_by_phrase` | Time-bucketed task phrase counts | — |
| `helpdesk-api GET /v1/tickets/analytics/count-by-phrase` | `helpdesk_ticket_count_by_phrase` | Time-bucketed ticket phrase counts (helpdesk-api) | — |
| `— *(composite)*` | `ingest_fingerprint_check` | Redis SET NX EX dedup; no Bam endpoint, org from `/auth/me` | — |


## Cross-app — Internal service-to-service endpoints

> **⚠ No MCP tools in this section — intentional.** Almost all are `/internal/*` routes authenticated by a shared service secret and called server-to-server (worker, bolt-api, helpdesk). Not exposed through nginx; not an agent surface.

- **Surface:** cross-app · API `apps/api` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /internal/helpdesk/comments` | — _(skip: internal service-to-service route)_ | Internal: post a Bam comment from a helpdesk ticket | — |
| `GET /internal/helpdesk/queue` | — _(skip: internal service-to-service route)_ | Session-auth proxy to helpdesk ticket queue | `apps/frontend/src/pages/helpdesk-agent-queue.tsx` |
| `POST /internal/helpdesk/tasks` | — _(skip: internal service-to-service route)_ | Internal: create a Bam task from a helpdesk ticket | — |
| `POST /internal/helpdesk/tasks/:id/move-to-terminal-phase` | — _(skip: internal service-to-service route)_ | Internal: close ticket's task into terminal phase | — |
| `POST /internal/helpdesk/tasks/:id/reopen` | — _(skip: internal service-to-service route)_ | Internal: reopen ticket's task to first non-terminal phase | — |
| `POST /internal/llm/chat` | — _(skip: internal service-to-service route)_ | Internal: proxy chat completion through stored provider keys | — |
| `POST /internal/permissions/dual-read` | — _(skip: internal service-to-service route)_ | Internal: MCP permission dual-read + divergence telemetry | — |
| `GET /public/config` | `get_public_config` | Public runtime flags (signup/bootstrap) | `apps/frontend/src` (usePublicConfig) |
| `POST /public/beta-signup` | `submit_beta_signup` | Public beta "notify me" form submission | — |


## CLI (`apps/api/src/cli.ts`)

- **Surface:** CLI · run inside the api container: `docker compose exec api node dist/cli.js <command>` (or via `railway ssh --service api` in prod).

`cli.ts` is a deliberately small **bootstrap / break-glass** surface — 11 commands, almost all identity/credential operations. The table maps each command to where the same capability exists as REST / MCP / UI, to surface gaps.

| CLI command | What it does | REST endpoint | MCP tool | UI | Notes / gap |
|---|---|---|---|---|---|
| `create-admin` | Create org + owner user (+ optional SuperUser) | `POST /auth/bootstrap` (first-run only) | `platform_create_org` (org only) | `/b3/bootstrap` (first-run) | No ongoing "create org **with** owner + password" on any surface — CLI is the only path after bootstrap |
| `create-user` | Create a user in an existing org, any role, with a password | `POST /org/members/invite` (≈) | `bam_invite_member` (≈) | `/b3/people` → Invite | Invite is email-based, role member/admin only, no direct password set — CLI can set a password and viewer/guest roles |
| `grant-superuser` | Promote a user to SuperUser by email | `PATCH /v1/platform/users/:id/superuser` | — | SuperUser → People | **No MCP tool** to grant/revoke SuperUser |
| `revoke-superuser` | Remove SuperUser by email | `PATCH /v1/platform/users/:id/superuser` | — | SuperUser → People | same |
| `create-api-key` | Issue a scoped user API key | `POST /org/members/:userId/api-keys` · `POST /auth/api-keys` (self) | — | People → Access · Settings | **No MCP tool** — agents cannot mint keys |
| `revoke-api-key` | Revoke an API key by prefix | `DELETE /org/members/:userId/api-keys/:keyId` · `DELETE /auth/api-keys/:id` | — | People → Access · Settings | **No MCP tool** |
| `create-service-account` | Mint locked `bbam_svc_` service account + key | `POST /auth/service-accounts` | — | Settings | **No MCP tool** |
| `create-helpdesk-agent-key` | Mint a per-agent helpdesk API key (`hdag_`) | — | — | — | **CLI-only** (helpdesk routes only *verify* keys; no mint endpoint/tool/UI) |
| `revoke-helpdesk-agent-key` | Revoke a helpdesk agent key by prefix | — | — | — | **CLI-only** |
| `list-orgs` | List all orgs (id / slug / name) | `GET /v1/platform/orgs` | `platform_list_orgs` | SuperUser → Orgs | Fully covered on all surfaces |
| `reset-password` | Reset a user's password by email | `POST /org/members/:userId/reset-password` | `bam_admin_reset_password` | People → Access | Fully covered on all surfaces |

### What we could add (candidates to consider)

- **MCP credential tools.** There are no MCP tools to create/revoke API keys, mint service accounts, or grant/revoke SuperUser — all CLI/REST/UI only. If agents should self-provision or rotate credentials, these are the gaps (security-sensitive — gate behind `confirm_action` / HITL).
- **Programmatic user creation.** No REST or MCP path creates a user with a password and an arbitrary role (viewer/guest) outside the email-invite flow; only the CLI can. A `bam_create_user` endpoint + tool would close it.
- **Helpdesk agent keys are CLI-only.** No REST/MCP/UI path to mint or revoke `hdag_` keys. Confirm this is intentional; if not, expose a minimal admin endpoint/UI.
- **Intentionally NOT in the CLI** (and fine that way): the full SuperUser org/user admin, permissions admin, and per-app product surfaces. The CLI is a bootstrap/break-glass tool, not an admin console — don't grow it into one.

---

## Known drift & gaps flagged during the survey

Noticed while mapping; **not fixed here** — flagging for follow-up:

- **Bearing client/server path mismatches:** `POST /key-results/:id/set-value` (FIXED 2026-06-17 — client now posts `/key-results/:id/value`) and `GET /periods/:id/report` (FIXED 2026-06-17 — a structured `/periods/:id/report` route now backs the dashboard stat cards + progress chart). **Still open:** the SPA calls `POST /goals/:id/override-status` while the server route is `POST /goals/:id/status` — the Override-status control still 404s. Same wrong-path family as the set-value bug; one-line fix in `apps/bearing/src/hooks/useGoals.ts`.
- **Bureau presence tools wired (FIXED 2026-06-17):** `bureau_get_presence`, `bureau_locate_user`, `bureau_set_status` now back real endpoints in `apps/bureau-api/src/routes/me-status.routes.ts` (`GET /v1/presence`, `GET /v1/presence/locate`, `PATCH /v1/me/status`) over the live Redis presence store. `bureau_set_status` persists the chosen status durably (`bureau:user:{id}:status`) so it survives reconnects and applies even when the caller has no live web session.
- **Banter calling endpoints return HTTP 410 Gone:** `banter_start_call` / `join` / `leave` / `end` / `invite_agent` tools still exist, but calling moved to the Bureau docked-box and the endpoints are tombstoned.
- **Board / Blueprint granular write endpoints are MCP/agent-only:** the SPAs persist via `PUT /boards/:id/scene` (Board) and read via the composite `/graph` endpoint (Blueprint); many element/node write endpoints are reachable only through MCP tools, not the UI.
- **LLM-placeholder tools (stubbed, no model wired):** `blast_draft_email_content`, `blast_suggest_subject_lines`, `blank_generate_form`, `blank_summarize_responses`.
- **Coverage hotspots worth a deliberate decision:** entire areas have zero MCP tools — Bam attachments/uploads/versions, custom-fields/labels/phases mutations, comment edit/delete, OAuth/guests, iCal, LLM providers, and most SuperUser admin. Decide per-area whether agent access is wanted before filling them in.

## Basis (app)

- **Service:** `apps/basis-api` · external `/basis/api/` · MCP module(s): `basis-tools.ts` · added on the `suite-brainstorm` branch.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /metrics` | `basis_list_metrics` | List governed metrics (certification filter) | `apps/basis/src/lib/api.ts` |
| `GET /metrics` (name filter) | `basis_search_metrics` | Search metrics by name/slug | — _(skip: same endpoint, client-side filter)_ |
| `POST /metrics` | `basis_define_metric` | Define a draft metric + first version | `apps/basis/src/lib/api.ts` |
| `GET /metrics/:id` | `basis_get_metric` | Get metric + current version | `apps/basis/src/lib/api.ts` |
| `PATCH /metrics/:id` | `basis_update_metric` | Update metric metadata (name/owner/target/...) | `apps/basis/src/lib/api.ts` |
| `POST /metrics/:id/versions` | `basis_add_metric_version` | New immutable definition version | `apps/basis/src/lib/api.ts` |
| `GET /metrics/:id/versions` | `basis_list_versions` | Version history | `apps/basis/src/app.tsx` |
| `POST /metrics/:id/certify` | `basis_certify_metric` | Certify (truth-flip, confirm) | `apps/basis/src/app.tsx` |
| `POST /metrics/:id/decertify` | `basis_decertify_metric` | Return to draft (confirm) | `apps/basis/src/app.tsx` |
| `DELETE /metrics/:id` | `basis_deprecate_metric` | Deprecate (destructive, confirm) | `apps/basis/src/app.tsx` |
| `GET /metrics/:id/resolve` | `basis_metric_lineage` | Query config + presentation envelope | — _(skip: internal Bench binding)_ |
| `GET /metrics/:id/value` | `basis_metric_value` | Scalar value over a period | — _(skip: agent-only read)_ |
| `POST /metrics/:id/explain` | `basis_explain_change` / `basis_rank_drivers` | Why did it change (decomposition + per-viewer correlation) | — _(skip: agent-only read)_ |
| `GET /settings` | `basis_get_settings` | Per-org Basis settings | `apps/basis/src/lib/api.ts` |
| `PUT /settings` | `basis_update_settings` | Update per-org settings | `apps/basis/src/lib/api.ts` |
| `GET /health`, `GET /health/ready` | — _(skip: probe)_ | Health / readiness | — |
| `/basis/ws` | — _(skip: realtime/ws)_ | Redis-PubSub `explanation.ready` notifications | — |

A Basis provider IS registered in the platform `search_everything` fan-out (`searchBasisMetrics` in `apps/mcp-server/src/tools/search-tools.ts`), adding the `metric` entity type and the `basis` source. Metric hits are org-scoped by the caller's session RLS (like Banter/Board hits, metrics are not in the Wave 2 `can_access` allowlist because a metric is org-global, not per-user-restricted). Metrics are also directly searchable via `basis_search_metrics`. All 16 `basis_*` tools are fail-closed under `agent_policies` until an operator allowlists `basis.*`. The Basis SPA's Definition Builder reads Bench's governed data-source catalog (`GET /bench/api/v1/data-sources`, covered by `bench_list_data_sources`) to populate its source/measure/dimension pickers, so a human references real columns rather than typing raw field names.

**SPA scope note (§5 drift):** the design called for 5 pages (Catalog, Detail, Definition Builder, Why-Did-It-Change Explorer, Settings); 2 shipped (Catalog + Detail, the latter covering define/certify/decertify/deprecate + version history). The Definition Builder, Why-Did-It-Change Explorer, and Settings pages are deferred, so `GET /metrics/:id/value`, `POST /metrics/:id/explain`, and `GET|PUT /settings` have no UI call site yet.

## Braid (app)

- **Service:** `apps/braid-api` · external `/braid/api/` · MCP module(s): `braid-tools.ts` · added on the `suite-brainstorm` branch.

Identity-resolution / golden-record CDP. 13 `braid_*` tools (spec section 10 of `docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md`). Read tools that surface source records take an explicit `asker_user_id` and pass it through so braid-api runs `can_access` fail-closed. The two truth-flip tools (`braid_merge_profiles`, `braid_split_profile`) use the Redis-backed confirm-token two-step flow (`apps/mcp-server/src/lib/confirm-token-store.ts`). All `braid_*` tools are fail-closed under `agent_policies` until an operator allowlists `braid.*`; following the basis satellite pattern (round-3 BP3-1), `braid_*` is intentionally NOT added to `EXPLICIT_TOOL_OVERRIDES`.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/profiles` | `braid_list_profiles` | List golden profiles (kind/status filter) | `apps/braid/src/lib/api.ts` |
| `GET /v1/profiles` (name/email filter) | `braid_search_profiles` | Search profiles by display_name/primary_email | — _(skip: same endpoint, client-side filter)_ |
| `GET /v1/profiles/:id` | `braid_get_profile` | Get a golden profile (member identities + recent decisions embedded) | `apps/braid/src/lib/api.ts` |
| `GET /v1/profiles/:id/identities` | — _(skip: resolver-done-internally)_ | Member source identities | — |
| `GET /v1/profiles/:id/timeline` | `braid_profile_timeline` | Cross-app timeline (fail-closed per viewer) | `apps/braid/src/lib/api.ts` |
| `GET /v1/profiles/:id/decisions` | — _(skip: resolver-done-internally)_ | Merge/split audit history | — |
| `POST /v1/resolve` | `braid_resolve` | Resolve a source record to its golden id (flagship) | `apps/braid/src/lib/api.ts` |
| `GET /v1/candidates` | `braid_list_candidates` | List review-queue candidates (sort -score) | `apps/braid/src/lib/api.ts` |
| `GET /v1/candidates/:id` | — _(skip: agent-only read; candidate detail deferred, evidence surfaces via `braid_list_candidates` + the proposal inbox route)_ | Candidate detail + evidence | `apps/braid/src/lib/api.ts` |
| `POST /v1/candidates/:id/merge` | `braid_merge_profiles` | Confirm a queued candidate merge (truth-flip, confirm) | `apps/braid/src/lib/api.ts` |
| `POST /v1/candidates/:id/reject` | `braid_reject_candidate` | Reject a candidate (identity-level suppression) | `apps/braid/src/lib/api.ts` |
| `POST /v1/profiles/merge` | `braid_merge_profiles` | Merge two profiles directly (truth-flip, confirm) | `apps/braid/src/lib/api.ts` |
| `POST /v1/profiles/:id/split` | `braid_split_profile` | Unmerge or split (destructive, confirm) | `apps/braid/src/lib/api.ts` |
| `GET /v1/survivorship-rules` | `braid_list_survivorship_rules` | List per-field winner rules | `apps/braid/src/lib/api.ts` |
| `PUT /v1/survivorship-rules/:kind/:field` | `braid_set_survivorship_rule` | Upsert a survivorship rule | `apps/braid/src/lib/api.ts` |
| `GET /v1/settings` | `braid_get_settings` | Get per-org Braid settings | `apps/braid/src/lib/api.ts` |
| `PATCH /v1/settings` | — _(skip: settings/enablement admin; source-type enablement gate is admin UI-only, no agent tool)_ | Update per-org settings | `apps/braid/src/lib/api.ts` |
| `POST /v1/candidates` (propose) | `braid_propose_merge` | Upsert a candidate + register an `agent_proposals` HITL row | — |
| `POST /internal/events` | — _(skip: internal service-to-service; bolt-api ingest trigger, `INTERNAL_SERVICE_SECRET`)_ | Ingest-trigger from bolt-api | — |
| `POST /internal/proposal-decided` | — _(skip: internal service-to-service; proposal.decided delivery, `INTERNAL_SERVICE_SECRET`)_ | proposal.decided delivery | — |
| `POST /v1/internal/resolve` | — _(skip: internal service-to-service; Bulwark counterparty resolution, `INTERNAL_SERVICE_SECRET`, fails closed on empty)_ | Internal golden-id resolution for Bulwark (spec 7.4) | — |
| `/braid/ws` | — _(skip: realtime/ws)_ | Redis-PubSub refs-only notifications | — |
| `GET /health`, `GET /readyz` | — _(skip: probe)_ | Health / readiness | — |

`braid_propose_merge` is MCP-only: no dedicated propose route exists on braid-api yet, so the tool POSTs to the `/v1/candidates` surface per spec 10 (braid-api upserts the candidate and inserts the `agent_proposals` row). `braid_merge_profiles` backs two endpoints (`/candidates/:id/merge` when a `candidate_id` is given, `/profiles/merge` for a direct pair). Section counts: 21 REST endpoints, 12 with a tool, 9 without (all annotated), 1 MCP-only tool (`braid_propose_merge`) — 13 `braid_*` tools total.

## Bulwark (app)

- **Service:** `apps/bulwark-api` · external `/bulwark/api/` · MCP module(s): `apps/mcp-server/src/tools/bulwark-tools.ts` (M5, shipped) · added on the `suite-brainstorm` branch.

AI contract-obligation monitor. 16 `bulwark_*` tools (spec section 10 of `docs/brainstorming/2026_07_19_03_00_APP_DESIGN_bulwark.md`), registered via `registerBulwarkTools` in `apps/mcp-server/src/server.ts` (env `BULWARK_API_URL`). Every ledger read/write route is project-membership-scoped (SH1/SH3, org-admin override, no-project org fallback SK3). Reads that surface source records take an explicit `asker_user_id` and pass it through so bulwark-api runs `can_access` fail-closed; the source-scoped writes (`PATCH /obligations/:id`, `POST /obligations/:id/trigger`, `POST /deadlines/:id/discharge`) layer the same asker preflight on top of the bearer's project-scope guard (SH1, Braid #60). State-change confirm tools (`bulwark_delete_contract`, `bulwark_reject_obligation`, `bulwark_waive_deadline`, `bulwark_discard_notice`) use the Redis-backed confirm-token two-step flow. All `bulwark_*` tools are fail-closed under `agent_policies` until an operator allowlists `bulwark.*`; following the basis/braid satellite pattern, `bulwark_*` is intentionally NOT added to `EXPLICIT_TOOL_OVERRIDES`.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/contracts` | `bulwark_list_contracts` | List tracked contracts (project-scoped) | `ObligationLedgerPage` (Contracts rail) |
| `POST /v1/contracts` | `bulwark_extract_obligations` | Register from a Bin asset; enqueues extraction (Bin `can_access` preflight) | `ObligationLedgerPage` "Register contract" |
| `GET /v1/contracts/:id` | `bulwark_get_contract` | Contract detail + rollup (embeds obligations) | `ContractDetailPage` |
| `PATCH /v1/contracts/:id` | — _(skip: metadata edit, SPA-surfaced)_ | Update contract metadata | — _(not surfaced; no metadata-edit UI)_ |
| `DELETE /v1/contracts/:id` | `bulwark_delete_contract` | Delete a tracked contract (owner/admin floor, confirm) | `ContractDetailPage` "Delete" |
| `POST /v1/contracts/:id/extract` | `bulwark_extract_obligations` | Re-run extraction (hash-skip conditional; Bin preflight) | `ContractDetailPage` "Extract" |
| `GET /v1/contracts/:id/obligations` | — _(skip: resolver-done-internally; `bulwark_get_contract` embeds obligations)_ | Ledger for a contract | `ContractDetailPage` / `ObligationLedgerPage` (embedded) |
| `GET /v1/obligations` | `bulwark_list_obligations` | List obligations / review queue (sort -confidence) | `ObligationLedgerPage` |
| `GET /v1/obligations/:id` | `bulwark_get_obligation` | Obligation detail + verified cited_span | — _(not surfaced; embedded in ledger/detail)_ |
| `PATCH /v1/obligations/:id` | `bulwark_confirm_obligation` | Confirm / edit / bind an obligation | `ObligationLedgerPage` "Confirm" / "Edit / bind" |
| `PATCH /v1/obligations/:id` (reject) | `bulwark_reject_obligation` | Reject an obligation (destructive, confirm) | `ObligationLedgerPage` "Reject" |
| `POST /v1/obligations/:id/trigger` | `bulwark_trigger_obligation` | Manual trigger (unbound / no-project only) | `ObligationLedgerPage` "Mark occurred" |
| `GET /v1/deadlines` | `bulwark_list_deadlines` | Deadline radar (project-scoped) | `DeadlineRadarPage` + `NoticeReviewQueuePage` |
| `GET /v1/deadlines/:id` | — _(skip: resolver-done-internally; `bulwark_check_notice_risk` + `bulwark_list_deadlines` surface deadline data; the notice body is a UI-only read gated behind `bulwark.notice.draft`)_ | Deadline detail | — _(not surfaced; internal resolver)_ |
| `POST /v1/deadlines/:id/draft-notice` | `bulwark_draft_notice` | Draft/re-draft a notice + register proposal | `DeadlineRadarPage` "Draft notice" |
| `POST /v1/deadlines/:id/approve-send` | — _(skip: UI-only send surface; the MCP send path is the proposal approve)_ | Approve+send a notice directly | `NoticeReviewQueuePage` "Approve and send" |
| `POST /v1/deadlines/:id/discharge` | `bulwark_waive_deadline` | Mark discharged/waived (waive confirm) | `DeadlineRadarPage` "Discharge" / "Waive" |
| `POST /v1/deadlines/:id/discard-notice` | `bulwark_discard_notice` | Discard a bad notice draft (notice_status=discarded; clock untouched; confirm) | `NoticeReviewQueuePage` "Discard draft" |
| `GET /v1/waiver-risks` | `bulwark_check_notice_risk` | Open waiver risks (flagship, with `GET /v1/deadlines` for a job) | `DeadlineRadarPage` (waiver-risks banner) |
| `GET /v1/vendor-tiers` | — _(skip: compliance-matrix management, SPA-only)_ | List vendor tiers | `VendorComplianceMatrixPage` |
| `POST /v1/vendor-tiers` | — _(skip: compliance-matrix management, SPA-only)_ | Add a vendor tier | `VendorComplianceMatrixPage` "Add vendor tier" |
| `GET /v1/compliance-docs` | `bulwark_list_compliance` | Vendor compliance matrix (project-scoped) | `VendorComplianceMatrixPage` |
| `POST /v1/compliance-docs/:id/chase` | `bulwark_chase_compliance` | Draft a chase + register proposal | `VendorComplianceMatrixPage` "Chase" |
| `POST /v1/compliance-docs/:id/approve-send` | — _(skip: UI-only send surface; the MCP send path is the proposal approve)_ | Approve+send a chase directly | `VendorComplianceMatrixPage` "Send" |
| `GET /v1/settings` | — _(skip: settings SPA-surfaced)_ | Get org settings | `SettingsPage` |
| `PATCH /v1/settings` | — _(skip: settings SPA-surfaced)_ | Update org settings (owner/admin floor) | `SettingsPage` "Save settings" |
| `POST /v1/internal/events` | — _(skip: internal service-to-service; bolt-api ingest trigger, `INTERNAL_SERVICE_SECRET`, fails closed on empty)_ | Ingest-trigger from bolt-api | — |
| `POST /v1/internal/proposal-decided` | — _(skip: internal service-to-service; proposal.decided delivery, `INTERNAL_SERVICE_SECRET`)_ | proposal.decided delivery | — |
| `/bulwark/ws` | — _(skip: realtime/ws; project-scoped refs-only frames)_ | Redis-PubSub project-scoped notifications | — |
| `GET /health`, `GET /readyz` | — _(skip: probe)_ | Health / readiness | — |

`bulwark_extract_obligations` (flagship) backs two endpoints (`POST /v1/contracts` and `POST /v1/contracts/:id/extract`). `bulwark_check_notice_risk` (flagship) surfaces `GET /v1/deadlines` + `GET /v1/waiver-risks` for a job. `PATCH /v1/obligations/:id` backs two tools by intent (`bulwark_confirm_obligation` for confirm/edit/bind, `bulwark_reject_obligation` for reject). Section counts: 29 REST endpoints (27 distinct paths; PATCH obligations and the two flagship multi-endpoint tools counted per row), 16 with a `bulwark_*` tool, the remainder skip-annotated — 16 `bulwark_*` tools total.

