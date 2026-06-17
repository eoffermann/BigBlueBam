# BigBlueBam — REST Endpoint ↔ MCP Tool ↔ UI Surface Map

> **⚠ KEEP THIS CURRENT.** This is the single map of our REST / MCP / CLI / UI surface.
> **Any time you add, remove, rename, or consolidate a REST endpoint; add, change, or remove an MCP tool; change a `cli.ts` command; or wire/unwire a UI call site — update the relevant table in this file in the SAME change.**
> A stale surface map is worse than none. This is not yet CI-enforced, so it is on us to keep it honest.

_Last full survey: 2026-06-16._

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
| Bam — Work management | 88 | 49 | 39 | 2 |
| Bam — Org, auth, admin & integrations | 153 | 25 | 128 | 0 |
| Banter | 99 | 46 | 53 | 0 |
| Beacon | 29 | 22 | 7 | 0 |
| Brief | 52 | 15 | 37 | 0 |
| Bond | 68 | 18 | 50 | 0 |
| Bolt | 28 | 14 | 14 | 0 |
| Bearing | 35 | 14 | 21 | 0 |
| Board | 42 | 10 | 32 | 1 |
| Blast | 40 | 11 | 29 | 2 |
| Bench | 29 | 8 | 21 | 3 |
| Blueprint | 38 | 19 | 19 | 1 |
| Book | 27 | 8 | 19 | 1 |
| Blank | 21 | 9 | 12 | 1 |
| Bill | 43 | 12 | 31 | 0 |
| Bureau | 37 | 13 | 24 | 3 |
| Helpdesk | 37 | 11 | 26 | 0 |
| Cross-app platform | 41 | 30 | 11 | 6 |
| **Total** | **907** | **334** | **573** | **20** |

_Counts are summed from the per-section tables. Some endpoints are shared by multiple MCP tools and many are internal / webhook / public-inbound (not user-facing), so treat the totals as close approximations of the surface size, not an exact public-API inventory. The biggest agent-coverage gaps are in **Bam org/admin** (SuperUser & permissions admin, integrations, credentials — intentionally UI/CLI-only) and the per-app long tails (collaborators, versions, templates, settings)._

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
| `PATCH /projects/:id` | — | Update project (admin) | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /projects/:id` | — | Archive project (admin) | `apps/frontend/src/pages/settings.tsx` |
| `GET /projects/:id/members` | — | List project members | `apps/frontend/src/pages/board.tsx` |
| `POST /projects/:id/members` | — | Add a project member | `apps/frontend/src/pages/settings.tsx` |
| `POST /projects/:id/slack-integration/test` | `test_slack_webhook` | Send a test Slack webhook message | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /projects/:id/github-integration` | `disconnect_github_integration` | Remove project GitHub integration | `apps/frontend/src/pages/settings.tsx` |


## Bam — Tasks
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `task-tools.ts`, `member-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects/:id/board` | — | Board state (phases + tasks + sprint) | `apps/frontend/src/stores/board.store.ts` |
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
| `GET /sprints/:id` | — | Get one sprint | `apps/frontend/src/hooks/use-sprints.ts` |
| `PATCH /sprints/:id` | — | Update sprint fields | `apps/frontend/src/hooks/use-sprints.ts` |
| `POST /sprints/:id/start` | `start_sprint` | Start a planned sprint | `apps/frontend/src/hooks/use-sprints.ts` |
| `POST /sprints/:id/complete` | `complete_sprint` | Complete sprint + carry-forward | `apps/frontend/src/components/board/carry-forward-dialog.tsx` |
| `POST /sprints/:id/cancel` | — | Cancel sprint, dump tasks to backlog | `apps/frontend/src/hooks/use-sprints.ts` |
| `GET /sprints/:id/report` | `get_sprint_report` / `get_burndown` | Sprint summary + burndown | `apps/frontend/src/pages/sprint-report.tsx` |


## Bam — Epics
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `epic-tools.ts`, `bam-resolver-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects/:id/epics` | `bam_list_epics` | List epics with task counts | `apps/frontend/src/components/board/epic-manager.tsx` |
| `POST /projects/:id/epics` | `bam_create_epic` | Create an epic | `apps/frontend/src/components/board/epic-manager.tsx` |
| `GET /epics/:id` | `bam_get_epic` | Get epic + rollup | `apps/frontend/src/pages/epic-detail.tsx` |
| `GET /epics/:id/tasks` | — | List tasks linked to epic | `apps/frontend/src/pages/epic-detail.tsx` |
| `PATCH /epics/:id` | `bam_update_epic` | Update/close an epic | `apps/frontend/src/pages/epic-detail.tsx` |
| `DELETE /epics/:id` | — | Delete an epic | `apps/frontend/src/components/board/epic-manager.tsx` |


## Bam — Comments & Reactions
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `comment-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /tasks/:id/comments` | `list_comments` | List comments on a task | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `POST /tasks/:id/comments` | `add_comment` | Add a comment (accepts human_id) | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `PATCH /comments/:id` | — | Edit own comment (revisioned) | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `GET /comments/:id/revisions` | — | Comment edit history | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `DELETE /comments/:id` | — | Delete own comment | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `POST /comments/:id/reactions` | — | Toggle an emoji reaction | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `GET /comments/:id/reactions` | — | List reactions grouped by emoji | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |


## Bam — Time tracking
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `task-tools.ts`, `report-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /tasks/:id/time-entries` | `log_time` | Log time on a task | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `GET /tasks/:id/time-entries` | — | List a task's time entries | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `GET /me/time-entries` | — | List own time entries (date range) | — |
| `GET /projects/:id/reports/time-tracking` | `get_time_tracking_report` | Per-user time aggregation | `apps/frontend/src/pages/project-reports.tsx` |


## Bam — Templates
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `template-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects/:id/task-templates` | `list_templates` | List project task templates | `apps/frontend/src/components/tasks/template-manager.tsx` |
| `POST /projects/:id/task-templates` | — | Create a task template | `apps/frontend/src/components/tasks/template-manager.tsx` |
| `POST /projects/:id/task-templates/:templateId/apply` | `create_from_template` | Create a task from a template | `apps/frontend/src/components/tasks/template-picker.tsx` |
| `DELETE /task-templates/:id` | — | Delete a task template | `apps/frontend/src/components/tasks/template-manager.tsx` |


## Bam — Custom fields / Labels / Phases / States
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `bam-resolver-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /projects/:id/custom-fields` | — | List project custom-field defs | `apps/frontend/src/components/board/custom-field-manager.tsx` |
| `POST /projects/:id/custom-fields` | — | Create a custom-field def | `apps/frontend/src/components/board/custom-field-manager.tsx` |
| `PATCH /custom-fields/:id` | — | Update a custom-field def | `apps/frontend/src/components/board/custom-field-manager.tsx` |
| `DELETE /custom-fields/:id` | — | Delete a custom-field def | `apps/frontend/src/components/board/custom-field-manager.tsx` |
| `GET /labels` | `bam_list_labels` | Org-wide label list (no project_id) | — |
| `GET /projects/:id/labels` | `bam_list_labels` | Project label list | `apps/frontend/src/pages/board.tsx` |
| `POST /projects/:id/labels` | — | Create a label | `apps/frontend/src/pages/board.tsx` |
| `PATCH /labels/:id` | — | Update a label | `apps/frontend/src/pages/board.tsx` |
| `DELETE /labels/:id` | — | Delete a label | `apps/frontend/src/pages/board.tsx` |
| `GET /projects/:id/phases` | `bam_list_phases` | List phases (board columns) | `apps/frontend/src/components/board/phase-manager.tsx` |
| `POST /projects/:id/phases` | — | Create a phase | `apps/frontend/src/components/board/phase-manager.tsx` |
| `POST /projects/:id/phases/reorder` | — | Reorder phases | `apps/frontend/src/components/board/phase-manager.tsx` |
| `PATCH /phases/:id` | — | Update a phase | `apps/frontend/src/components/board/phase-manager.tsx` |
| `DELETE /phases/:id` | — | Delete phase (optional migrate) | `apps/frontend/src/components/board/phase-manager.tsx` |
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
- **Service:** `apps/api` · external `/b3/api/` (uploads/files at `/files/`) · MCP module(s): none in scope

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /tasks/:id/attachments` | — | Attach a file record to a task | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `GET /tasks/:id/attachments` | — | List a task's attachments | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `DELETE /attachments/:id` | — | Delete an attachment | `apps/frontend/src/components/tasks/task-detail-drawer.tsx` |
| `POST /upload` | — | Multipart upload to MinIO | `apps/frontend/src/components/common/image-upload.tsx` |
| `GET /files/*` | — | Proxy file download from MinIO | `apps/frontend/src/components/common/image-upload.tsx` |
| `GET /version` | — | Public version info | `apps/frontend/src/hooks/use-version.ts` |
| `POST /version/check` | — | Force version check (SuperUser) | — |


## Bam — Import
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `import-tools.ts`, `task-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /projects/:id/import/csv` | `import_csv` / `bam_import_csv` | Commit CSV import | `apps/frontend/src/components/import/import-dialog.tsx` |
| `POST /projects/:id/import/csv/preview` | `bam_import_csv` *(dry_run)* | Dry-run CSV import (writes nothing) | `apps/frontend/src/components/import/import-dialog.tsx` |
| `POST /projects/:id/import/github` | `import_github_issues` | Import GitHub issues as tasks | `apps/frontend/src/components/import/import-dialog.tsx` |
| `POST /projects/:id/import/jira` | — | Import Jira export rows | `apps/frontend/src/components/import/import-dialog.tsx` |
| `POST /projects/:id/import/trello` | — | Import Trello board JSON | `apps/frontend/src/components/import/import-dialog.tsx` |
| — *(composite)* | `suggest_branch_name` | Fetches `/tasks/:id`, slugifies a branch name | — |


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
| `GET /org` | — | Get current org + member/owner counts | `apps/frontend/src/lib/api/people.ts` |
| `PATCH /org` | — | Update org name/logo/settings | `apps/frontend/src/pages/settings.tsx` |
| `GET /org/launchpad-apps` | — | Get org Launchpad override + platform default | `apps/frontend/src/pages/settings.tsx` |
| `PUT /org/launchpad-apps` | `set_org_launchpad_apps` | Set/clear org Launchpad override | `apps/frontend/src/pages/settings.tsx` |
| `GET /org/members` | `list_members` | List org members (guest-scoped subset) | `apps/frontend/src/pages/people/index.tsx` |
| `PATCH /org/members/:userId` | — | Update member org role | `apps/frontend/src/pages/people/detail.tsx` |
| `DELETE /org/members/:userId` | — | Remove member from org | `apps/frontend/src/pages/people/detail.tsx` |
| `GET /org/members/:userId` | — | Get member detail | `apps/frontend/src/pages/people/detail.tsx` |
| `GET /org/members/:userId/activity` | — | Member activity feed (paginated) | `apps/frontend/src/pages/people/detail.tsx` |
| `GET /org/members/:userId/api-keys` | — | List a member's API keys | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/api-keys` | — | Create API key for a member | `apps/frontend/src/pages/people/detail.tsx` |
| `DELETE /org/members/:userId/api-keys/:keyId` | — | Revoke a member's API key | `apps/frontend/src/pages/people/detail.tsx` |
| `GET /org/members/:userId/deletion-eligibility` | — | Probe admin account-deletion eligibility | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/delete-account` | — | Cross-org soft-delete of an account | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/force-password-change` | — | Force password change on next login | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/reset-ftue` | — | Reset a member's welcome tour (FTUE) so it re-fires on next login | `apps/frontend/src/pages/people-manager/detail.tsx` |
| `GET /org/members/:userId/projects` | — | List member's projects in org | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/projects` | — | Add member to projects | `apps/frontend/src/pages/people/detail.tsx` |
| `PATCH /org/members/:userId/projects/:projectId` | — | Update member's project role | `apps/frontend/src/pages/people/detail.tsx` |
| `DELETE /org/members/:userId/projects/:projectId` | — | Remove member from a project | `apps/frontend/src/pages/people/detail.tsx` |
| `PATCH /org/members/:userId/active` | — | Enable/disable a member | `apps/frontend/src/pages/people/detail.tsx` |
| `PATCH /org/members/:userId/profile` | — | Update member display name/timezone | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/reset-password` | `bam_admin_reset_password` | Reset member password, return new value | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/send-password-reset` | `bam_send_password_reset_link` | Email member a reset link | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/sign-out-everywhere` | — | Revoke all member sessions | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/:userId/transfer-ownership` | — | Transfer org ownership to member | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /org/members/invite` | `bam_invite_member` | Invite/add a member to the org | `apps/frontend/src/pages/people/index.tsx` |
| `POST /org/members/invite/bulk` | — | Bulk-invite up to 100 members | `apps/frontend/src/pages/people/import-members-dialog.tsx` |
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
| `PATCH /auth/me` | `update_me` | Update own profile fields | `apps/frontend/src/pages/settings.tsx` |
| `GET /auth/orgs` | `list_my_orgs` | List caller's org memberships | `apps/frontend/src/components/layout/org-switcher.tsx` |
| `POST /auth/bootstrap` | — | First-run SuperUser/org bootstrap | `apps/frontend/src/pages/*bootstrap*` |
| `POST /auth/change-password` | `change_my_password` | Change own password | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/login` | — | Password (+TOTP) login, sets cookie | `apps/frontend/src/pages/login.tsx` |
| `POST /auth/logout` | `logout` | Invalidate cookie session | `apps/frontend/src/components/layout/app-layout.tsx` |
| `POST /auth/password-reset/consume` | — | Consume reset token, set password | `apps/frontend/src/pages/password-reset.tsx` |
| `POST /auth/password-reset/request` | — | Request self-serve reset email (opaque) | `apps/frontend/src/pages/login.tsx` |
| `POST /auth/register` | — | Public signup (kill-switchable) | `apps/frontend/src/pages/login.tsx` |
| `POST /auth/switch-org` | `switch_active_org` | Switch active org, rotate session | `apps/frontend/src/components/layout/org-switcher.tsx` |
| `POST /auth/verify-email/:token` | — | Finalize email-change verification | `apps/frontend/src/pages/*verify*` |


## Bam — Notifications (me)
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `me-tools`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /me/notifications` | `list_my_notifications` | Caller's notification feed | `apps/frontend/src/components/layout/app-layout.tsx` |
| `POST /me/notifications/:id/read` | `mark_notification_read` | Mark one notification read | `apps/frontend/src/components/layout/app-layout.tsx` |
| `POST /me/notifications/mark-all-read` | `mark_all_notifications_read` | Mark all notifications read | `apps/frontend/src/components/layout/app-layout.tsx` |
| `POST /me/notifications/mark-read` | `mark_notifications_read` | Mark several notifications read | `apps/frontend/src/components/layout/app-layout.tsx` |


## Bam — OAuth / SSO
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /auth/oauth/providers` | — | List enabled OAuth providers | `apps/frontend/src/pages/login.tsx` |
| `GET /auth/oauth/:provider/authorize` | — | Build provider authorize URL + state | `apps/frontend/src/pages/login.tsx` |
| `POST /auth/oauth/:provider/callback` | — | Exchange code, sign in or create user | `apps/frontend/src/pages/login.tsx` |
| `POST /auth/oauth/:provider/link` | — | Link external account to current user | `apps/frontend/src/pages/settings.tsx` |


## Bam — Guests
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/guests` | — | List guest users in org | `apps/frontend/src/pages/people/index.tsx` |
| `DELETE /v1/guests/:id` | — | Remove/deactivate a guest | `apps/frontend/src/pages/people/detail.tsx` |
| `PATCH /v1/guests/:id/scope` | — | Update guest project/channel access | `apps/frontend/src/pages/people/detail.tsx` |
| `POST /v1/guests/accept/:token` | — | Public: accept invitation, create guest | `apps/frontend/src/pages/guest-accept.tsx` |
| `POST /v1/guests/invite` | — | Create a guest invitation | `apps/frontend/src/pages/people/index.tsx` |
| `GET /v1/guests/invitations` | — | List pending guest invitations | `apps/frontend/src/pages/people/index.tsx` |
| `DELETE /v1/guests/invitations/:id` | — | Revoke a guest invitation | `apps/frontend/src/pages/people/index.tsx` |
| `POST /v1/guests/invitations/:id/resend` | — | Re-send guest invitation email | `apps/frontend/src/pages/people/index.tsx` |


## Bam — Platform / SuperUser org & user admin
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `platform-tools`

Covers `platform.routes.ts` (`/v1/platform/*`) and `superuser.routes.ts` (`/superuser/*`, mounted under that prefix).

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /audit-log` | — | SuperUser audit trail (filtered) | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /beta-signups` | `list_beta_signups` | List public beta-gate signups | `apps/frontend/src/pages/superuser/index.tsx` |
| `POST /context/clear` | — | Clear SuperUser active-org context | `apps/frontend/src/lib/api/superuser.ts` |
| `POST /context/switch` | — | Switch SuperUser into an org context | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /organizations` | — | SuperUser org list (cursor-paginated) | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /organizations/:id` | — | SuperUser org detail + activity | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /overview` | — | Platform-wide stat counters | `apps/frontend/src/pages/superuser/index.tsx` |
| `GET /platform-settings` | `get_platform_settings` | Read signup kill-switch flags | `apps/frontend/src/pages/superuser/index.tsx` |
| `PATCH /platform-settings` | `set_public_signup_disabled` · `set_helpdesk_signup_disabled` | Toggle signup kill-switches | `apps/frontend/src/pages/superuser/index.tsx` |
| `GET /superuser/calling-credentials` | — | LiveKit/voice provider config summary | `apps/frontend/src/pages/superuser/platform-calling-settings.tsx` |
| `GET /users` | — | SuperUser user list (filtered) | `apps/frontend/src/lib/api/superuser-users.ts` |
| `GET /users/:id` | — | SuperUser user detail | `apps/frontend/src/lib/api/superuser-users.ts` |
| `DELETE /users/:id` | — | SuperUser soft-delete an account | `apps/frontend/src/lib/api/superuser-users.ts` |
| `PATCH /users/:id/active` | — | Enable/disable a user | `apps/frontend/src/lib/api/superuser-users.ts` |
| `PATCH /users/:id/email` | — | Initiate email change for a user | `apps/frontend/src/lib/api/superuser-users.ts` |
| `GET /users/:id/login-history` | — | User login history (paginated) | `apps/frontend/src/lib/api/superuser-users.ts` |
| `POST /users/:id/memberships` | — | Add user org membership | `apps/frontend/src/lib/api/superuser-users.ts` |
| `DELETE /users/:id/memberships/:orgId` | — | Remove user org membership | `apps/frontend/src/lib/api/superuser-users.ts` |
| `PATCH /users/:id/memberships/:orgId` | — | Change user's org membership role | `apps/frontend/src/lib/api/superuser-users.ts` |
| `GET /users/:id/projects` | — | List a user's projects | `apps/frontend/src/lib/api/superuser-users.ts` |
| `POST /users/:id/set-default-org` | — | Set user's default org | `apps/frontend/src/lib/api/superuser-users.ts` |
| `GET /users/:id/sessions` | — | List user sessions | `apps/frontend/src/lib/api/superuser-users.ts` |
| `DELETE /users/:id/sessions/:sessionId` | — | Revoke one user session | `apps/frontend/src/lib/api/superuser-users.ts` |
| `POST /users/:id/sessions/revoke-all` | — | Revoke all user sessions | `apps/frontend/src/lib/api/superuser-users.ts` |
| `GET /v1/platform/audit-log` | — | Platform-admin audit trail | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /v1/platform/impersonation-sessions` | — | List active impersonations | `apps/frontend/src/lib/api/superuser.ts` |
| `POST /v1/platform/impersonate` | — | Start impersonating a user | `apps/frontend/src/lib/api/superuser.ts` |
| `POST /v1/platform/stop-impersonation` | — | Stop impersonating | `apps/frontend/src/components/layout/app-layout.tsx` |
| `GET /v1/platform/orgs` | `platform_list_orgs` | List all orgs (member counts) | `apps/frontend/src/lib/api/superuser.ts` |
| `POST /v1/platform/orgs` | `platform_create_org` | Create a new org | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /v1/platform/orgs/:id` | `platform_get_org` | Get org by id (member count) | `apps/frontend/src/lib/api/superuser.ts` |
| `PATCH /v1/platform/orgs/:id` | `platform_update_org` | Update org (rename regenerates slug) | `apps/frontend/src/lib/api/superuser.ts` |
| `DELETE /v1/platform/orgs/:id` | `platform_delete_org` | Soft-delete an org | `apps/frontend/src/lib/api/superuser.ts` |
| `GET /v1/platform/orgs/:id/members` | — | List members of any org | `apps/frontend/src/lib/api/superuser.ts` |
| `PATCH /v1/platform/users/:id/superuser` | — | Toggle SuperUser flag | `apps/frontend/src/lib/api/superuser.ts` |


## Bam — Launchpad
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): `platform-tools`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /launchpad/apps` | `get_launchpad_apps` | Resolved Launchpad app list for caller | `apps/frontend/src/components/layout/app-layout.tsx` |
| `PUT /system-settings/launchpad_default_apps` | `set_platform_launchpad_defaults` | Set/clear platform Launchpad default | `apps/frontend/src/pages/superuser/index.tsx` |


## Bam — System settings (SuperUser)
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /root-redirect` | — | Public: resolve site root redirect/bootstrap | nginx/site redirect |
| `GET /system-settings` | — | List all settings (secrets masked) | `apps/frontend/src/components/settings/smtp-settings-form.tsx` |
| `GET /system-settings/:key` | — | Read one setting (secrets masked) | `apps/frontend/src/pages/superuser/platform-calling-settings.tsx` |
| `PUT /system-settings/:key` | `set_platform_launchpad_defaults`* | Update one setting (per-key validated) | `apps/frontend/src/components/settings/smtp-settings-form.tsx` |
| `POST /system-settings/password_policy/preview` | — | Preview passwords from draft policy | `apps/frontend/src/components/superuser/password-policy-card.tsx` |
| `POST /system-settings/smtp/test` | — | Verify/send SMTP test message | `apps/frontend/src/components/settings/smtp-settings-form.tsx` |

`*` `set_platform_launchpad_defaults` targets only the `launchpad_default_apps` key of `PUT /system-settings/:key`; no general-purpose system-settings tool exists. Counted as tool-less for the PUT row tally below.


## Bam — Deploy settings (SuperUser)
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /superuser/deploy/settings` | — | Read deploy branch/repo/token/auto-update | `apps/frontend/src/lib/api/superuser-deploy.ts` |
| `PUT /superuser/deploy/settings` | — | Write deploy settings (token tri-state) | `apps/frontend/src/components/superuser/deploy-settings-card.tsx` |
| `POST /superuser/deploy/verify-repo` | — | Verify repo URL+token vs GitHub API | `apps/frontend/src/components/superuser/deploy-settings-card.tsx` |


## Bam — Permissions admin (SuperUser)
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

Covers `permissions-admin.routes.ts` and `permissions-divergences.routes.ts`.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /superuser/permissions/catalog` | — | Browse permission catalog (filtered) | `apps/frontend/src/lib/api/superuser-permissions.ts` |
| `GET /superuser/permissions/divergences` | — | Raw permission-divergence log (paginated) | `apps/frontend/src/pages/superuser/permissions-divergences.tsx` |
| `GET /superuser/permissions/divergences/summary` | — | Divergence summary by permission/route | `apps/frontend/src/pages/superuser/permissions-divergences.tsx` |
| `GET /superuser/permissions/groups` | — | List permission groups + counts | `apps/frontend/src/pages/superuser/permissions/groups-list.tsx` |
| `POST /superuser/permissions/groups` | — | Create a permission group (clone) | `apps/frontend/src/pages/superuser/permissions/groups-list.tsx` |
| `GET /superuser/permissions/groups/:id` | — | Get group + defaults + member count | `apps/frontend/src/lib/api/superuser-permissions.ts` |
| `PATCH /superuser/permissions/groups/:id` | — | Rename/redescribe a group | `apps/frontend/src/lib/api/superuser-permissions.ts` |
| `DELETE /superuser/permissions/groups/:id` | — | Soft-delete a group (no live members) | `apps/frontend/src/pages/superuser/permissions/groups-list.tsx` |
| `PUT /superuser/permissions/groups/:id/defaults` | — | Set group defaults (glob set_true/false) | `apps/frontend/src/lib/api/superuser-permissions.ts` |
| `POST /superuser/permissions/groups/:id/reset` | — | Reset group defaults to baseline | `apps/frontend/src/lib/api/superuser-permissions.ts` |
| `GET /superuser/permissions/users/:id` | — | User memberships/overrides/effective matrix | `apps/frontend/src/components/superuser/user-permissions-tab.tsx` |
| `PUT /superuser/permissions/users/:id/membership` | — | Assign user to group at scope | `apps/frontend/src/components/superuser/user-permissions-tab.tsx` |
| `PUT /superuser/permissions/users/:id/overrides/:permission_id` | — | Set explicit user permission override | `apps/frontend/src/components/superuser/user-permissions-tab.tsx` |
| `DELETE /superuser/permissions/users/:id/overrides/:permission_id` | — | Clear a user permission override | `apps/frontend/src/components/superuser/user-permissions-tab.tsx` |
| `POST /superuser/permissions/users/:id/reattach` | — | Reattach user at scope (factory reset) | `apps/frontend/src/components/superuser/user-permissions-tab.tsx` |


## Bam — Integrations: GitHub
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /projects/:id/github-integration` | — | Get project GitHub integration config | `apps/frontend/src/pages/settings.tsx` |
| `PUT /projects/:id/github-integration` | — | Upsert GitHub integration (reveals secret) | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /projects/:id/github-integration` | — | Disconnect GitHub integration | `apps/frontend/src/pages/settings.tsx` |
| `GET /tasks/:id/github-refs` | — | List linked commits/PRs for a task | `apps/frontend/src/pages/*task*` |
| `POST /webhooks/github` | — | Public webhook ingest (HMAC-verified) | external (GitHub) |


## Bam — Integrations: Slack
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /projects/:id/slack-integration` | — | Get project Slack integration config | `apps/frontend/src/pages/settings.tsx` |
| `PUT /projects/:id/slack-integration` | — | Upsert Slack integration (SSRF-guarded) | `apps/frontend/src/pages/settings.tsx` |
| `POST /projects/:id/slack-integration/test` | — | Send a Slack test message | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /projects/:id/slack-integration` | — | Disconnect Slack integration | `apps/frontend/src/pages/settings.tsx` |
| `POST /webhooks/slack/command` | — | Public Slack slash-command handler | external (Slack) |


## Bam — Integrations: Webhooks
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /projects/:id/webhooks` | — | List project outbound webhooks | `apps/frontend/src/pages/settings.tsx` |
| `POST /projects/:id/webhooks` | — | Create webhook (secret hashed, shown once) | `apps/frontend/src/pages/settings.tsx` |
| `PATCH /webhooks/:id` | — | Update webhook url/events/secret/active | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /webhooks/:id` | — | Delete a webhook | `apps/frontend/src/pages/settings.tsx` |


## Bam — Calendar / iCal
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /me/calendar.ics` | — | My assigned tasks as .ics (token or session) | `apps/frontend/src/components/views/calendar-export-menu.tsx` |
| `GET /projects/:id/calendar.ics` | — | Project tasks as .ics (authed) | `apps/frontend/src/components/views/calendar-export-menu.tsx` |
| `GET /projects/:id/calendar-tokens` | — | List project public calendar tokens | `apps/frontend/src/components/views/calendar-export-menu.tsx` |
| `POST /projects/:id/calendar-tokens` | — | Mint a public calendar token | `apps/frontend/src/components/views/calendar-export-menu.tsx` |
| `DELETE /projects/:id/calendar-tokens/:tokenId` | — | Revoke a public calendar token | `apps/frontend/src/components/views/calendar-export-menu.tsx` |
| `GET /public/projects/:id/calendar.ics` | — | Public token-auth project .ics feed | external (calendar clients) |


## Bam — LLM providers
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /llm-providers` | — | List LLM providers visible to caller | `apps/frontend/src/hooks/use-llm-providers.ts` |
| `POST /llm-providers` | — | Create scoped LLM provider (SSRF-guarded) | `apps/frontend/src/pages/settings-llm-providers.tsx` |
| `GET /llm-providers/resolve` | — | Resolve effective provider for context | `apps/frontend/src/hooks/use-llm-providers.ts` |
| `GET /llm-providers/:id` | — | Get LLM provider detail | `apps/frontend/src/pages/settings-llm-providers.tsx` |
| `PATCH /llm-providers/:id` | — | Update LLM provider | `apps/frontend/src/pages/settings-llm-providers.tsx` |
| `DELETE /llm-providers/:id` | — | Delete LLM provider | `apps/frontend/src/pages/settings-llm-providers.tsx` |
| `POST /llm-providers/:id/test` | — | Test provider connectivity | `apps/frontend/src/pages/settings-llm-providers.tsx` |


## Bam — API keys & Service accounts
- **Service:** `apps/api` · external `/b3/api/` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /auth/api-keys` | — | List own API keys (prefix hint) | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/api-keys` | — | Create an API key (shown once) | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/api-keys/:id/rotate` | — | Rotate an API key (7-day grace) | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /auth/api-keys/:id` | — | Revoke own API key | `apps/frontend/src/pages/settings.tsx` |
| `GET /auth/service-accounts` | — | List caller-visible service accounts | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/service-accounts` | — | Mint service account + key (shown once) | `apps/frontend/src/pages/settings.tsx` |
| `POST /auth/service-accounts/:id/rotate` | — | Rotate a service-account key | `apps/frontend/src/pages/settings.tsx` |
| `DELETE /auth/service-accounts/:id` | — | Soft-disable a service account | `apps/frontend/src/pages/settings.tsx` |


> The `/v1/agents/*` identity & heartbeat endpoints and their `agent_*` MCP tools are documented under **Cross-app → Agent identity, audit & heartbeat** below.

## Banter (app)

- **Service:** `apps/banter-api` · internal :4002 · external `/banter/api/` · MCP module(s): `banter-tools`, `banter-subscription-tools`

External URL = `/banter/api/` + the path column. WebSocket realtime at `/banter/ws` (no REST/MCP surface; broadcast-only). `confirm`/`confirm_action` flags on destructive tools are tool-side gates, not separate endpoints.

### Channels

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/channels` | `banter_list_channels` | List caller's channels with unread counts | `apps/banter/src/hooks/use-channels.ts` |
| `POST /v1/channels` | `banter_create_channel` | Create a channel | `apps/banter/src/components/sidebar/banter-sidebar.tsx` |
| `POST /v1/channels/bulk` | — | Bulk-create up to 50 channels | `apps/banter/src/components/sidebar/bulk-create-channels-dialog.tsx` |
| `GET /v1/channels/browse` | `banter_browse_channels` | List public channels (incl. unjoined) | `apps/banter/src/pages/channel-browser.tsx` |
| `GET /v1/channels/by-name/:name` | `banter_get_channel_by_name` | Resolve channel by name/slug/handle | — |
| `GET /v1/channels/:id` | `banter_get_channel` | Channel detail (UUID or slug) | `apps/banter/src/hooks/use-channels.ts` |
| `PATCH /v1/channels/:id` | `banter_update_channel`, `banter_archive_channel` | Update settings / archive (`is_archived`) | `apps/banter/src/components/channels/channel-settings.tsx` |
| `DELETE /v1/channels/:id` | `banter_delete_channel` | Soft-delete (archive) channel | `apps/banter/src/components/channels/channel-settings.tsx` |
| `POST /v1/channels/:id/join` | `banter_join_channel` | Join a public channel | `apps/banter/src/hooks/use-channels.ts` |
| `POST /v1/channels/:id/leave` | `banter_leave_channel` | Leave a channel | `apps/banter/src/hooks/use-channels.ts` |
| `GET /v1/channels/:id/members` | — | List channel members | `apps/banter/src/hooks/use-channels.ts` |
| `POST /v1/channels/:id/members` | `banter_add_channel_members` | Add members | `apps/banter/src/components/channels/channel-settings.tsx` |
| `DELETE /v1/channels/:id/members/:userId` | `banter_remove_channel_member` | Remove a member | `apps/banter/src/components/channels/channel-settings.tsx` |
| `PATCH /v1/channels/:id/members/:userId` | — | Update member role | `apps/banter/src/hooks/use-channels.ts` |
| `POST /v1/channels/:id/mark-read` | — | Update last-read cursor | `apps/banter/src/hooks/use-unread.ts` |
| `GET /v1/admin/channel-groups` | — | List sidebar channel groups | `apps/banter/src/components/sidebar/banter-sidebar.tsx` |
| `POST /v1/admin/channel-groups` | — | Create a channel group | `apps/banter/src/pages/admin.tsx` |
| `GET /v1/admin/channel-groups/:id` | — | Get a channel group | `apps/banter/src/pages/admin.tsx` |
| `PATCH /v1/admin/channel-groups/:id` | — | Update a channel group | `apps/banter/src/pages/admin.tsx` |
| `DELETE /v1/admin/channel-groups/:id` | — | Delete a channel group | `apps/banter/src/pages/admin.tsx` |
| `POST /v1/admin/channel-groups/reorder` | — | Reorder channel groups | `apps/banter/src/components/sidebar/banter-sidebar.tsx` |


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
| `GET /v1/messages/:id/reactions` | — | List reactions grouped by emoji | `apps/banter/src/hooks/use-reactions.ts` |
| `GET /v1/channels/:id/pins` | — | List pinned messages | `apps/banter/src/components/messages/message-timeline.tsx` |
| `POST /v1/channels/:id/pins` | `banter_pin_message` | Pin a message | `apps/banter/src/components/messages/message-item.tsx` |
| `DELETE /v1/channels/:id/pins/:messageId` | `banter_unpin_message` | Unpin a message | `apps/banter/src/hooks/use-messages.ts` |
| `GET /v1/bookmarks` | — | List caller's bookmarks | `apps/banter/src/pages/bookmarks.tsx` |
| `POST /v1/bookmarks` | — | Create a bookmark | `apps/banter/src/components/messages/message-item.tsx` |
| `DELETE /v1/bookmarks/by-message/:messageId` | — | Remove bookmark by message id | `apps/banter/src/hooks/use-messages.ts` |
| `DELETE /v1/bookmarks/:id` | — | Remove bookmark by id | `apps/banter/src/pages/bookmarks.tsx` |


### DMs

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/dm` | — | List caller's DMs and group DMs | `apps/banter/src/components/sidebar/banter-sidebar.tsx` |
| `POST /v1/dm` | `banter_send_dm` | Create/reuse a DM channel (then posts) | `apps/banter/src/components/common/user-profile-popover.tsx` |
| `POST /v1/group-dm` | `banter_send_group_dm` | Create/reuse a group DM (then posts) | `apps/banter/src/components/sidebar/banter-sidebar.tsx` |


### Calls & huddles

All write endpoints return HTTP 410 Gone (calling moved to the Bureau docked-box); only read endpoints remain.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `POST /v1/channels/:id/calls` | `banter_start_call` | Gone (410); was start call | — |
| `GET /v1/channels/:id/calls` | `banter_list_calls` | Call history for a channel | `apps/banter/src/hooks/use-call-history.ts` |
| `GET /v1/calls/:id` | `banter_get_call`, `banter_get_active_huddle` | Call detail w/ participants | `apps/banter/src/pages/call-playback.tsx` |
| `GET /v1/calls/:id/participants` | — | List call participants | `apps/banter/src/pages/call-playback.tsx` |
| `GET /v1/calls/:id/transcript` | `banter_get_transcript` | Historical transcript segments | `apps/banter/src/pages/call-playback.tsx` |
| `PATCH /v1/calls/:id` | — | Gone (410); was recording toggles | — |
| `POST /v1/calls/:id/join` | `banter_join_call` | Gone (410); was join call | — |
| `POST /v1/calls/:id/leave` | `banter_leave_call` | Gone (410); was leave call | — |
| `POST /v1/calls/:id/end` | `banter_end_call` | Gone (410); was end call | — |
| `POST /v1/calls/:id/invite-agent` | `banter_invite_agent_to_call` | Gone (410); was voice-agent invite | — |
| `POST /v1/calls/:id/remove-agent` | — | Gone (410); was voice-agent removal | — |
| `PATCH /v1/calls/:id/media-state` | — | Gone (410); was mute/cam/screenshare | — |
| `POST /v1/webhooks/livekit` | — | LiveKit room-event webhook (HMAC) | — *(LiveKit SFU)* |


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
| `DELETE /v1/user-groups/:id` | — | Delete a user group | `apps/banter/src/pages/admin.tsx` |
| `POST /v1/user-groups/:id/members` | `banter_add_group_members` | Add group members | `apps/banter/src/pages/admin.tsx` |
| `GET /v1/user-groups/:id/members` | — | List group members | `apps/banter/src/pages/admin.tsx` |
| `DELETE /v1/user-groups/:id/members/:userId` | `banter_remove_group_member` | Remove a group member | `apps/banter/src/pages/admin.tsx` |


### Preferences, presence & unread

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/me/preferences` | `banter_get_preferences` | Get caller's preferences | `apps/banter/src/pages/preferences.tsx` |
| `PATCH /v1/me/preferences` | `banter_update_preferences` | Update caller's preferences | `apps/banter/src/pages/preferences.tsx` |
| `GET /v1/me/unread` | `banter_get_unread` | Unread summary across channels | `apps/banter/src/hooks/use-unread.ts` |
| `GET /v1/me/presence` | — | Get caller's presence row | `apps/banter/src/hooks/use-presence.ts` |
| `POST /v1/me/presence` | `banter_set_presence` | Upsert caller's presence | `apps/banter/src/hooks/use-presence.ts` |
| `GET /v1/channels/:id/presence` | — | List non-offline channel members | `apps/banter/src/hooks/use-presence.ts` |


### Search & link preview

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/search/channels` | — | Full-text channel name/topic search | `apps/banter/src/pages/search.tsx` |
| `GET /v1/search/messages` | `banter_search_messages` | Full-text message search | `apps/banter/src/pages/search.tsx` |
| `GET /v1/search/transcripts` | `banter_search_transcripts` | Full-text transcript search | `apps/banter/src/pages/search.tsx` |
| `GET /v1/link-preview` | — | Fetch OG/Twitter card for a URL | `apps/banter/src/components/messages/link-preview.tsx` |


### Scheduling

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/channels/:id/scheduled-messages` | — | List pending scheduled posts | — |
| `DELETE /v1/scheduled-messages/:id` | — | Cancel a pending scheduled post | — |


### Agent subscriptions

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/agent-subscriptions` | `banter_list_subscriptions` | List caller's pattern subscriptions | — |
| `DELETE /v1/agent-subscriptions/:sid` | `banter_unsubscribe_pattern` | Disable a subscription | — |
| `POST /v1/channels/:id/agent-subscriptions` | `banter_subscribe_pattern` | Create a pattern subscription | — |
| `GET /v1/channels/:id/agent-subscriptions` | — | Channel-scoped "who's listening" (admin) | — |


### Admin settings & files

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /v1/admin/settings` | — | Get org Banter settings (masked) | `apps/banter/src/pages/admin.tsx` |
| `PATCH /v1/admin/settings` | — | Update org Banter settings | `apps/banter/src/pages/admin.tsx` |
| `POST /v1/admin/settings/test-livekit` | — | Test LiveKit credentials | `apps/banter/src/pages/admin-calling-settings.tsx` |
| `POST /v1/admin/settings/test-stt` | — | Test STT provider connectivity | `apps/banter/src/pages/admin-calling-settings.tsx` |
| `POST /v1/admin/settings/test-tts` | — | Test TTS provider connectivity | `apps/banter/src/pages/admin-calling-settings.tsx` |
| `POST /v1/admin/settings/push-voice-config` | — | Push voice config to voice agent | `apps/banter/src/pages/admin-calling-settings.tsx` |
| `POST /v1/files/upload` | — | Multipart upload to MinIO | `apps/banter/src/components/messages/message-compose.tsx` |
| `POST /v1/files/presigned-upload` | — | Generate a presigned PUT URL | `apps/banter/src/components/messages/message-compose.tsx` |


### Slack import (admin)

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `POST /v1/admin/import/slack/upload` | — | Upload .zip, fast-scan preview | `apps/api` (Bam settings wizard via proxy) |
| `GET /v1/admin/import/slack/` | — | List recent imports for the org | `apps/api` (Bam settings wizard via proxy) |
| `GET /v1/admin/import/slack/:id/preview` | — | Full users/channels for the wizard | `apps/api` (Bam settings wizard via proxy) |
| `POST /v1/admin/import/slack/:id/start` | — | Persist mapping, enqueue worker job | `apps/api` (Bam settings wizard via proxy) |
| `GET /v1/admin/import/slack/:id/status` | — | Poll the durable import row | `apps/api` (Bam settings wizard via proxy) |
| `DELETE /v1/admin/import/slack/:id` | — | Abort + cleanup | `apps/api` (Bam settings wizard via proxy) |


### Internal (service-to-service)

X-Internal-Secret gated; not user-facing, no MCP tools.

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `POST /v1/internal/dm` | — | Send a DM between two users (bureau) | — *(internal)* |
| `POST /v1/internal/feed` | — | Post an activity-feed message | — *(internal)* |
| `POST /v1/internal/share` | — | Share a Bam entity into a channel | — *(internal)* |
| `POST /v1/internal/transcript` | — | Receive one live transcript segment | — *(voice-agent)* |
| `POST /v1/internal/transcription-callback` | — | Batch offline transcription callback | — *(voice-agent)* |


## Beacon (app)

- **Service:** `apps/beacon-api` · external `/beacon/api/` · MCP module(s): `apps/mcp-server/src/tools/beacon-tools.ts`

All routes are registered under the `/v1` prefix, so external paths are `/beacon/api/v1/<path>`. The MCP tools target the beacon-api base URL directly (paths shown below are the in-service paths). Beacon write tools accept a UUID/slug/title and resolve via `resolveBeaconId` before calling the path.

### CRUD, lifecycle, versions

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /beacons` | `beacon_create` | Create a new Beacon (Draft) | `apps/beacon/src/hooks/use-beacons.ts` |
| `GET /beacons` | `beacon_list` | List Beacons with filters | `apps/beacon/src/hooks/use-beacons.ts` |
| `GET /beacons/by-slug/:slug` | — | Resolve slug to Beacon (MCP resolver) | — |
| `GET /beacons/stats` | — | Org-wide Beacon statistics | `apps/beacon/src/hooks/use-beacons.ts` |
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
| `GET /beacons/:id/links` | — | List a Beacon's links | `apps/beacon/src/hooks/use-beacons.ts` |
| `POST /beacons/:id/links` | `beacon_link_create` | Create a typed link between Beacons | — |
| `DELETE /beacons/:id/links/:linkId` | `beacon_link_remove` | Remove a Beacon link | — |
| `GET /beacons/:id/comments` | — | List comments on a Beacon | `apps/beacon/src/hooks/use-comments.ts` |
| `POST /beacons/:id/comments` | — | Create a comment / reply | `apps/beacon/src/hooks/use-comments.ts` |
| `PUT /beacons/:id/comments/:commentId` | — | Edit own comment | — |
| `DELETE /beacons/:id/comments/:commentId` | — | Delete comment (author/admin) | `apps/beacon/src/hooks/use-comments.ts` |
| `GET /beacons/:id/attachments` | — | List attachments on a Beacon | `apps/beacon/src/hooks/use-attachments.ts` |
| `POST /beacons/:id/attachments` | — | Multipart attachment upload | `apps/beacon/src/hooks/use-attachments.ts` |
| `DELETE /beacons/:id/attachments/:attachmentId` | — | Delete an attachment | `apps/beacon/src/hooks/use-attachments.ts` |

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
| `GET /documents/recent` | — | Recently updated documents | `apps/brief/src/hooks/use-documents.ts` |
| `GET /documents/search` | `brief_search` | Full-text document search | `apps/brief/src/hooks/use-search.ts` |
| `GET /documents/semantic-search` | — | Qdrant vector search (text fallback) | `apps/brief/src/hooks/use-search.ts` |
| `GET /documents/starred` | — | User's starred documents | `apps/brief/src/hooks/use-documents.ts` |
| `GET /documents/stats` | — | Org-wide document statistics | `apps/brief/src/hooks/use-documents.ts` |
| `GET /documents/by-slug/:slug` | — | Resolve slug to document (MCP resolver) | — |
| `GET /documents/:id` | `brief_get` | Get one document by UUID or slug | `apps/brief/src/hooks/use-documents.ts` |
| `PATCH /documents/:id` | `brief_update` | Update document metadata | `apps/brief/src/hooks/use-documents.ts` |
| `DELETE /documents/:id` | `brief_archive` | Archive document (soft-delete) | `apps/brief/src/hooks/use-documents.ts` |
| `POST /documents/:id/append` | `brief_append_content` | Append Markdown to document | — |
| `POST /documents/:id/duplicate` | `brief_duplicate` | Duplicate a document | `apps/brief/src/hooks/use-documents.ts` |
| `POST /documents/:id/promote` | `brief_promote_to_beacon` | Graduate document to a Beacon | `apps/brief/src/hooks/use-documents.ts` |
| `POST /documents/:id/restore` | `brief_restore` | Restore an archived document | `apps/brief/src/hooks/use-documents.ts` |
| `POST /documents/:id/star` | — | Toggle document star | `apps/brief/src/hooks/use-documents.ts` |
| `PUT /documents/:id/content` | `brief_update_content` | Replace entire document content | — |
| `GET /documents/:id/yjs-state` | — | Fetch raw Yjs state (base64) | `apps/brief/src/hooks/use-collaboration.ts` |
| `PUT /documents/:id/yjs-state` | — | Persist Yjs state snapshot | `apps/brief/src/hooks/use-collaboration.ts` |

### Comments, versions, links, collaborators, embeds, templates, folders, export

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /documents/:id/comments` | `brief_comment_list` | List threaded comments | `apps/brief/src/hooks/use-comments.ts` |
| `POST /documents/:id/comments` | `brief_comment_add` | Create a comment | `apps/brief/src/hooks/use-comments.ts` |
| `PATCH /comments/:commentId` | — | Edit comment body | — |
| `DELETE /comments/:commentId` | — | Delete a comment | `apps/brief/src/hooks/use-comments.ts` |
| `POST /comments/:commentId/resolve` | `brief_comment_resolve` | Toggle comment resolved state | `apps/brief/src/hooks/use-comments.ts` |
| `POST /comments/:commentId/reactions` | — | Add a comment reaction | — |
| `DELETE /comments/:commentId/reactions/:emoji` | — | Remove a comment reaction | — |
| `GET /documents/:id/versions` | `brief_versions` | List version history | `apps/brief/src/hooks/use-versions.ts` |
| `POST /documents/:id/versions` | — | Create a named version snapshot | `apps/brief/src/hooks/use-versions.ts` |
| `GET /documents/:id/versions/:versionId` | `brief_version_get` | Get a specific version | — |
| `POST /documents/:id/versions/:versionId/restore` | `brief_version_restore` | Restore document to a version | `apps/brief/src/hooks/use-versions.ts` |
| `GET /documents/:id/versions/:v1/diff/:v2` | — | Diff two versions (LCS line diff) | — |
| `GET /documents/:id/links` | — | List task + beacon links | `apps/brief/src/hooks/use-links.ts` |
| `POST /documents/:id/links/task` | `brief_link_task` | Link document to a Bam task | — |
| `POST /documents/:id/links/beacon` | — | Link document to a Beacon | — |
| `DELETE /links/:linkId` | — | Delete a link (document_id query) | — |
| `GET /documents/:id/collaborators` | — | List collaborators | — |
| `POST /documents/:id/collaborators` | — | Add a collaborator | — |
| `PATCH /collaborators/:collabId` | — | Update collaborator permission | — |
| `DELETE /collaborators/:collabId` | — | Remove a collaborator | — |
| `POST /documents/:id/embeds` | — | Record embed/upload metadata | — |
| `GET /documents/:id/embeds` | — | List embeds for a document | — |
| `DELETE /embeds/:embedId` | — | Delete an embed | — |
| `GET /documents/:id/export/markdown` | — | Export document as Markdown | `apps/brief/src/components/document/export-menu.tsx` |
| `GET /documents/:id/export/html` | — | Export document as styled HTML | `apps/brief/src/components/document/export-menu.tsx` |
| `GET /templates` | — | List system + org templates | `apps/brief/src/hooks/use-templates.ts` |
| `POST /templates` | — | Create an org template | `apps/brief/src/hooks/use-templates.ts` |
| `PATCH /templates/:id` | — | Update a template | — |
| `DELETE /templates/:id` | — | Delete a template | — |
| `GET /folders` | — | List folder tree | `apps/brief/src/hooks/use-folders.ts` |
| `POST /folders` | — | Create a folder | `apps/brief/src/hooks/use-folders.ts` |
| `PATCH /folders/:id` | — | Update a folder | `apps/brief/src/hooks/use-folders.ts` |
| `DELETE /folders/:id` | — | Delete a folder | `apps/brief/src/hooks/use-folders.ts` |
| `POST /internal/can-read` | — | Cross-app read preflight (Bureau summon) | — *(internal service-to-service)* |


## Bond (app)

- **Service:** `apps/bond-api` · external `/bond/api/` · MCP module(s): `bond-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /activities` | — | List CRM activities (filterable) | `apps/bond/src/hooks/use-activities.ts` |
| `POST /activities` | `bond_log_activity` | Log activity against contact/deal/company | `apps/bond/src/hooks/use-activities.ts` |
| `GET /activities/:id` | — | Get activity detail | — |
| `PATCH /activities/:id` | — | Update an activity | — |
| `DELETE /activities/:id` | — | Delete an activity | `apps/bond/src/hooks/use-activities.ts` |
| `GET /analytics/conversion-rates` | — | Stage-to-stage conversion rates | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /analytics/deal-velocity` | — | Average time in each stage | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /analytics/forecast` | `bond_get_forecast` | Revenue forecast in 30/60/90 buckets | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /analytics/pipeline-summary` | `bond_get_pipeline_summary` | Pipeline value/count by stage | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /analytics/stale-deals` | `bond_get_stale_deals` | Deals exceeding rotting threshold | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /analytics/win-loss` | — | Win/loss ratio and analysis | `apps/bond/src/hooks/use-analytics.ts` |
| `GET /companies` | `bond_list_companies` | List/filter companies | `apps/bond/src/hooks/use-companies.ts` |
| `POST /companies` | `bond_create_company` | Create company | `apps/bond/src/hooks/use-companies.ts` |
| `GET /companies/search` | — | Search companies by name/domain | — |
| `GET /companies/:id` | `bond_get_company` | Get company detail | `apps/bond/src/hooks/use-companies.ts` |
| `PATCH /companies/:id` | `bond_update_company` | Update company | `apps/bond/src/hooks/use-companies.ts` |
| `DELETE /companies/:id` | — | Delete company | `apps/bond/src/hooks/use-companies.ts` |
| `GET /companies/:id/contacts` | — | Contacts at this company | `apps/bond/src/pages/company-detail.tsx` |
| `GET /companies/:id/deals` | — | Paginated deals at this company | `apps/bond/src/pages/company-detail.tsx` |
| `POST /companies/:id/restore` | — | Undelete soft-deleted company | `apps/bond/src/hooks/use-companies.ts` |
| `GET /contacts` | `bond_list_contacts` | List/filter contacts | `apps/bond/src/hooks/use-contacts.ts` |
| `POST /contacts` | `bond_create_contact` | Create contact | `apps/bond/src/hooks/use-contacts.ts` |
| `GET /contacts/export` | — | Export contacts | — |
| `POST /contacts/import` | — | Bulk import contacts | — |
| `GET /contacts/search` | `bond_search_contacts` | Full-text contact search | — |
| `POST /contacts/upsert` | `bond_upsert_contact` | Idempotent create-or-update by email | — |
| `GET /contacts/:id` | `bond_get_contact` | Get contact detail | `apps/bond/src/hooks/use-contacts.ts` |
| `PATCH /contacts/:id` | `bond_update_contact` | Update contact | `apps/bond/src/hooks/use-contacts.ts` |
| `DELETE /contacts/:id` | — | Delete contact | `apps/bond/src/hooks/use-contacts.ts` |
| `GET /contacts/:id/duplicates` | `bond_find_duplicates` | Ranked duplicate candidates for contact | — |
| `POST /contacts/:id/merge` | `bond_merge_contacts` | Merge duplicate contacts | `apps/bond/src/hooks/use-contacts.ts` |
| `POST /contacts/:id/restore` | — | Undelete soft-deleted contact | `apps/bond/src/hooks/use-contacts.ts` |
| `GET /custom-field-definitions` | — | List custom field definitions | `apps/bond/src/hooks/use-custom-fields.ts` |
| `POST /custom-field-definitions` | — | Create custom field definition | `apps/bond/src/hooks/use-custom-fields.ts` |
| `GET /custom-field-definitions/:id` | — | Get custom field definition | — |
| `PATCH /custom-field-definitions/:id` | — | Update custom field definition | `apps/bond/src/hooks/use-custom-fields.ts` |
| `DELETE /custom-field-definitions/:id` | — | Delete custom field definition | `apps/bond/src/hooks/use-custom-fields.ts` |
| `GET /deals` | `bond_list_deals` | List/filter deals | `apps/bond/src/hooks/use-deals.ts` |
| `POST /deals` | `bond_create_deal` | Create deal | `apps/bond/src/hooks/use-deals.ts` |
| `GET /deals/:id` | `bond_get_deal` | Get deal detail | `apps/bond/src/hooks/use-deals.ts` |
| `PATCH /deals/:id` | `bond_update_deal` | Update deal | `apps/bond/src/hooks/use-deals.ts` |
| `DELETE /deals/:id` | — | Soft-delete deal | `apps/bond/src/hooks/use-deals.ts` |
| `POST /deals/:id/restore` | — | Undelete soft-deleted deal | `apps/bond/src/hooks/use-deals.ts` |
| `PATCH /deals/:id/stage` | `bond_move_deal_stage` | Move deal to new stage | `apps/bond/src/hooks/use-deals.ts` |
| `POST /deals/:id/won` | `bond_close_deal_won` | Close deal as won | `apps/bond/src/hooks/use-deals.ts` |
| `POST /deals/:id/lost` | `bond_close_deal_lost` | Close deal as lost | `apps/bond/src/hooks/use-deals.ts` |
| `POST /deals/:id/duplicate` | — | Duplicate deal | — |
| `GET /deals/:id/contacts` | — | List deal contacts | — |
| `POST /deals/:id/contacts` | — | Add contact to deal | `apps/bond/src/hooks/use-deals.ts` |
| `DELETE /deals/:id/contacts/:contactId` | — | Remove contact from deal | `apps/bond/src/hooks/use-deals.ts` |
| `GET /deals/:id/stage-history` | — | Stage transition history | `apps/bond/src/hooks/use-deals.ts` |
| `GET /deals/:id/activities` | — | Activity timeline for a deal | `apps/bond/src/hooks/use-activities.ts` |
| `GET /deals/:id/related` | — | Cross-product links (Bill/Book/Bam) | `apps/bond/src/hooks/use-deals.ts` |
| `POST /imports/mappings` | — | Upsert a single import mapping | — |
| `GET /imports/mappings` | — | List import mappings | — |
| `GET /pipelines` | — | List pipelines | `apps/bond/src/hooks/use-pipelines.ts` |
| `POST /pipelines` | — | Create pipeline | `apps/bond/src/hooks/use-pipelines.ts` |
| `GET /pipelines/:id` | — | Get pipeline detail | `apps/bond/src/hooks/use-pipelines.ts` |
| `PATCH /pipelines/:id` | — | Update pipeline | `apps/bond/src/hooks/use-pipelines.ts` |
| `DELETE /pipelines/:id` | — | Delete pipeline | — |
| `GET /pipelines/:id/stages` | — | List pipeline stages | — |
| `POST /pipelines/:id/stages` | — | Create stage | `apps/bond/src/hooks/use-pipelines.ts` |
| `PATCH /pipelines/:id/stages/:stageId` | — | Update stage | `apps/bond/src/hooks/use-pipelines.ts` |
| `DELETE /pipelines/:id/stages/:stageId` | — | Delete stage | `apps/bond/src/hooks/use-pipelines.ts` |
| `POST /pipelines/:id/stages/reorder` | — | Reorder stages | `apps/bond/src/hooks/use-pipelines.ts` |
| `GET /scoring-rules` | — | List lead-scoring rules | `apps/bond/src/hooks/use-scoring.ts` |
| `POST /scoring-rules` | — | Create scoring rule | `apps/bond/src/hooks/use-scoring.ts` |
| `PATCH /scoring-rules/:id` | — | Update scoring rule | `apps/bond/src/hooks/use-scoring.ts` |
| `DELETE /scoring-rules/:id` | — | Delete scoring rule | `apps/bond/src/hooks/use-scoring.ts` |
| `POST /scoring/recalculate` | `bond_score_lead` | Recalculate a contact's lead score | `apps/bond/src/hooks/use-scoring.ts` |
| `GET /user-settings` | — | Current user's Bond settings | `apps/bond/src/hooks/use-user-settings.ts` |
| `PATCH /user-settings` | — | Set/clear reply-to address | `apps/bond/src/hooks/use-user-settings.ts` |


## Bolt (app)

- **Service:** `apps/bolt-api` · external `/bolt/api/` · MCP module(s): `bolt-tools.ts`, `bolt-observability-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /actions` | `bolt_actions` | List MCP tools usable as actions | `apps/bolt/src/hooks/use-event-catalog.ts` |
| `POST /ai/explain` | — | Explain an automation in natural language | — |
| `POST /ai/generate` | — | Generate automation from NL prompt | — |
| `GET /automations` | `bolt_list` | List automations (filterable) | `apps/bolt/src/hooks/use-automations.ts` |
| `POST /automations` | `bolt_create` | Create automation | `apps/bolt/src/hooks/use-automations.ts` |
| `GET /automations/stats` | — | Automation statistics | `apps/bolt/src/hooks/use-automations.ts` |
| `GET /automations/by-name/:name` | `bolt_get_automation_by_name` | Resolve automation by name | — |
| `GET /automations/:id` | `bolt_get` | Get automation with conditions/actions | `apps/bolt/src/hooks/use-automations.ts` |
| `PUT /automations/:id` | `bolt_update` | Full update of automation | `apps/bolt/src/hooks/use-automations.ts` |
| `PATCH /automations/:id` | — | Partial metadata update | — |
| `DELETE /automations/:id` | `bolt_delete` | Delete automation | `apps/bolt/src/hooks/use-automations.ts` |
| `POST /automations/:id/enable` | `bolt_enable` | Enable automation | `apps/bolt/src/hooks/use-automations.ts` |
| `POST /automations/:id/disable` | `bolt_disable` | Disable automation | `apps/bolt/src/hooks/use-automations.ts` |
| `POST /automations/:id/duplicate` | — | Duplicate automation | `apps/bolt/src/hooks/use-automations.ts` |
| `POST /automations/:id/test` | `bolt_test` | Test-fire with simulated event | `apps/bolt/src/hooks/use-automations.ts` |
| `GET /automations/:id/versions` | — | List automation versions | — |
| `POST /automations/:id/versions/:vid/restore` | — | Restore an automation version | — |
| `GET /automations/:id/executions` | `bolt_executions` | List executions for automation | `apps/bolt/src/hooks/use-executions.ts` |
| `GET /events` | `bolt_events` | Full trigger-event catalog | `apps/bolt/src/hooks/use-event-catalog.ts` |
| `GET /events/:source` | `bolt_events` | Events for a specific source | `apps/bolt/src/hooks/use-event-catalog.ts` |
| `GET /events/:event_id/trace` | `bolt_event_trace` | Full evaluation trail for an event | — |
| `GET /events/recent` | `bolt_recent_events` | Recent matched ingest events | — |
| `POST /events/ingest` | — | Internal event ingestion (service-secret) | — |
| `GET /executions` | — | Org-wide execution list | `apps/bolt/src/hooks/use-executions.ts` |
| `GET /executions/:id` | `bolt_execution_detail` | Execution detail with steps | `apps/bolt/src/hooks/use-executions.ts` |
| `POST /executions/:id/retry` | — | Retry a failed execution | `apps/bolt/src/hooks/use-executions.ts` |
| `GET /templates` | — | List pre-built automation templates | `apps/bolt/src/hooks/use-templates.ts` |
| `POST /templates/:id/instantiate` | — | Create automation from template | `apps/bolt/src/hooks/use-templates.ts` |


## Bearing (app)

- **Service:** `apps/bearing-api` · external `/bearing/api/` · MCP module(s): `bearing-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /goals` | `bearing_goals` | List goals (filterable) | `apps/bearing/src/hooks/useGoals.ts` |
| `POST /goals` | `bearing_goal_create` | Create goal | `apps/bearing/src/hooks/useGoals.ts` |
| `GET /goals/export` | — | Export goals as CSV | — |
| `GET /goals/:id` | `bearing_goal_get` | Get goal with key results | `apps/bearing/src/hooks/useGoals.ts` |
| `PATCH /goals/:id` | `bearing_goal_update` | Update goal | `apps/bearing/src/hooks/useGoals.ts` |
| `DELETE /goals/:id` | — | Delete goal | `apps/bearing/src/hooks/useGoals.ts` |
| `POST /goals/:id/status` | — | Override goal status | `apps/bearing/src/hooks/useGoals.ts` |
| `GET /goals/:id/updates` | — | List goal updates | `apps/bearing/src/hooks/useGoals.ts` |
| `POST /goals/:id/updates` | `bearing_update_post` | Post a status update | `apps/bearing/src/hooks/useGoals.ts` |
| `GET /goals/:id/watchers` | — | List goal watchers | `apps/bearing/src/hooks/useGoals.ts` |
| `POST /goals/:id/watchers` | — | Add watcher | `apps/bearing/src/hooks/useGoals.ts` |
| `DELETE /goals/:id/watchers/:userId` | — | Remove watcher | `apps/bearing/src/hooks/useGoals.ts` |
| `GET /goals/:id/history` | — | Goal progress history | `apps/bearing/src/hooks/useGoals.ts` |
| `GET /goals/:id/key-results` | — | List key results for goal | `apps/bearing/src/hooks/useKeyResults.ts` |
| `POST /goals/:id/key-results` | `bearing_kr_create` | Create key result | `apps/bearing/src/hooks/useKeyResults.ts` |
| `GET /key-results/:id` | — | Get key result | `apps/bearing/src/hooks/useKeyResults.ts` |
| `PATCH /key-results/:id` | `bearing_kr_update` | Update key result | `apps/bearing/src/hooks/useKeyResults.ts` |
| `DELETE /key-results/:id` | — | Delete key result | `apps/bearing/src/hooks/useKeyResults.ts` |
| `POST /key-results/:id/value` | `bearing_kr_update` | Set current value (check-in) | `apps/bearing/src/hooks/useKeyResults.ts` |
| `GET /key-results/:id/links` | — | List key-result links | `apps/bearing/src/hooks/useKeyResults.ts` |
| `POST /key-results/:id/links` | `bearing_kr_link` | Add link to Bam entity | `apps/bearing/src/hooks/useKeyResults.ts` |
| `DELETE /key-results/:id/links/:linkId` | — | Remove key-result link | `apps/bearing/src/hooks/useKeyResults.ts` |
| `GET /key-results/:id/history` | — | Key-result snapshot history | `apps/bearing/src/hooks/useKeyResults.ts` |
| `GET /key-results/export` | — | Export key results as CSV | — |
| `GET /periods` | `bearing_periods` | List OKR periods | `apps/bearing/src/hooks/usePeriods.ts` |
| `POST /periods` | — | Create period | `apps/bearing/src/hooks/usePeriods.ts` |
| `GET /periods/:id` | `bearing_period_get` | Get period with stats | `apps/bearing/src/hooks/usePeriods.ts` |
| `PATCH /periods/:id` | — | Update period | `apps/bearing/src/hooks/usePeriods.ts` |
| `DELETE /periods/:id` | — | Delete period | `apps/bearing/src/hooks/usePeriods.ts` |
| `POST /periods/:id/activate` | — | Activate period | `apps/bearing/src/hooks/usePeriods.ts` |
| `POST /periods/:id/complete` | — | Complete period | `apps/bearing/src/hooks/usePeriods.ts` |
| `GET /reports/period/:periodId` | `bearing_report` | Period summary report | `apps/bearing/src/hooks/useProgress.ts` |
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
| `DELETE /collaborators/:collabId` | — | Remove a board collaborator | — |
| `PATCH /collaborators/:collabId` | — | Update collaborator permission | — |
| `DELETE /links/:linkId` | — | Delete element-task link | — |
| `GET /boards` | `board_list` | List boards with filters/pagination | `apps/board/src/hooks/use-boards.ts` |
| `POST /boards` | `board_create` | Create a board | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/recent` | — | Recently updated boards | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/search` | `board_search` | Search board element text | — |
| `GET /boards/starred` | — | User's starred boards | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/stats` | — | Org-level board statistics | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id` | `board_get` | Get board metadata | `apps/board/src/hooks/use-boards.ts` |
| `PATCH /boards/:id` | `board_update` | Update board metadata | `apps/board/src/hooks/use-boards.ts` |
| `DELETE /boards/:id` | `board_archive` | Archive (soft-delete) board | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id/chat` | — | List recent chat messages | `apps/board/src/hooks/use-chat.ts` |
| `POST /boards/:id/chat` | — | Send a chat message | `apps/board/src/hooks/use-chat.ts` |
| `GET /boards/:id/collaborators` | — | List collaborators | — |
| `POST /boards/:id/collaborators` | — | Add a collaborator | — |
| `POST /boards/:id/duplicate` | — | Duplicate board with elements | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id/elements` | `board_read_elements` | Read all canvas elements | `apps/board/src/hooks/use-elements.ts` |
| `GET /boards/:id/elements/frames` | `board_read_frames` | Read frames + contained elements | `apps/board/src/hooks/use-elements.ts` |
| `POST /boards/:id/elements/promote` | `board_promote_to_tasks` | Promote stickies to Bam tasks | — |
| `GET /boards/:id/elements/stickies` | `board_read_stickies` | Read sticky-note elements | `apps/board/src/hooks/use-elements.ts` |
| `POST /boards/:id/elements/sticky` | `board_add_sticky` | Create a sticky note | — |
| `POST /boards/:id/elements/text` | `board_add_text` | Create a text element | — |
| `POST /boards/:id/export` | `board_export` | Export scene (json/svg/png) | `apps/blueprint`/agent only |
| `GET /boards/:id/export/:format` | — | Server-side svg/png render | — |
| `GET /boards/:id/integrity` | — | Per-board integrity check | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id/links` | — | List element-task links | — |
| `POST /boards/:id/lock` | — *(via `board_update locked`)* | Toggle board lock | `apps/board/src/hooks/use-boards.ts` |
| `DELETE /boards/:id/permanent` | — | Hard-delete board (cascade) | `apps/board/src/hooks/use-boards.ts` |
| `POST /boards/:id/remediate` | — | Apply integrity fix (detach/reassign) | `apps/board/src/hooks/use-boards.ts` |
| `POST /boards/:id/restore` | — | Restore archived board | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id/scene` | — | Load saved Excalidraw scene | `apps/board/src/hooks/use-collaboration.ts` |
| `PUT /boards/:id/scene` | — | Full scene save | `apps/board/src/hooks/use-collaboration.ts` |
| `POST /boards/:id/scene/beacon` | — | sendBeacon scene flush on unload | `apps/board/src/pages/board-canvas.tsx` |
| `POST /boards/:id/star` | — | Toggle star on board | `apps/board/src/hooks/use-boards.ts` |
| `GET /boards/:id/stats` | — | Single-board statistics | — |
| `GET /boards/:id/versions` | — | List board versions | `apps/board/src/hooks/use-versions.ts` |
| `POST /boards/:id/versions` | — | Create named snapshot | `apps/board/src/hooks/use-versions.ts` |
| `POST /boards/:id/versions/:versionId/restore` | — | Restore a version | `apps/board/src/hooks/use-versions.ts` |
| `GET /internal/can-read` (`POST`) | — *(internal)* | Bureau cross-app read preflight | — |
| `GET /templates` | — | List board templates | `apps/board/src/hooks/use-templates.ts` |
| `POST /templates` | — | Create a template | — |
| `PATCH /templates/:id` | — | Update a template | — |
| `DELETE /templates/:id` | — | Delete a template | — |
| `POST /templates/:id/instantiate` | — | Create a board from template | `apps/board/src/hooks/use-templates.ts` |
| `— *(client-side)*` | `board_summarize` | Frame-grouped summary (reuses `/frames`) | — |


## Blast (app)

- **Service:** `apps/blast-api` · external `/blast/api/` (+ `/t/` tracking, `/unsub/`) · MCP module(s): `blast-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /analytics/engagement-trend` | — | Org engagement trend over time | `apps/blast/src/hooks/use-analytics.ts` |
| `GET /analytics/overview` | `blast_get_engagement_summary` | Org-level engagement metrics | `apps/blast/src/hooks/use-analytics.ts` |
| `GET /analytics/unsubscribe-check` | `blast_check_unsubscribed` | Check email unsubscribe status | — |
| `GET /campaigns` | — | List campaigns | `apps/blast/src/hooks/use-campaigns.ts` |
| `POST /campaigns` | `blast_draft_campaign` | Create draft campaign | `apps/blast/src/hooks/use-campaigns.ts` |
| `GET /campaigns/:id` | `blast_get_campaign` | Campaign detail + stats | `apps/blast/src/hooks/use-campaigns.ts` |
| `PATCH /campaigns/:id` | — | Update campaign | `apps/blast/src/hooks/use-campaigns.ts` |
| `DELETE /campaigns/:id` | — | Delete campaign | `apps/blast/src/hooks/use-campaigns.ts` |
| `GET /campaigns/:id/analytics` | `blast_get_campaign_analytics` | Engagement metrics for campaign | `apps/blast/src/hooks/use-campaigns.ts` |
| `GET /campaigns/:id/analytics/devices` | — | Device-breakdown analytics | — |
| `POST /campaigns/:id/cancel` | — | Cancel a campaign | — |
| `POST /campaigns/:id/pause` | — | Pause a campaign | — |
| `GET /campaigns/:id/recipients` | — | List campaign recipients | `apps/blast/src/hooks/use-campaigns.ts` |
| `POST /campaigns/:id/schedule` | `blast_send_campaign` *(approval path)* | Schedule campaign send | `apps/blast/src/hooks/use-campaigns.ts` |
| `POST /campaigns/:id/send` | `blast_send_campaign` | Send campaign immediately | `apps/blast/src/hooks/use-campaigns.ts` |
| `GET /segments` | `blast_list_segments` | List contact segments | `apps/blast/src/hooks/use-segments.ts` |
| `POST /segments` | `blast_create_segment` | Create a segment | `apps/blast/src/hooks/use-segments.ts` |
| `GET /segments/:id` | — | Get a segment | `apps/blast/src/hooks/use-segments.ts` |
| `PATCH /segments/:id` | — | Update a segment | `apps/blast/src/hooks/use-segments.ts` |
| `DELETE /segments/:id` | — | Delete a segment | `apps/blast/src/hooks/use-segments.ts` |
| `POST /segments/:id/count` | — | Recalculate recipient count | `apps/blast/src/hooks/use-segments.ts` |
| `GET /segments/:id/preview` | `blast_preview_segment` | Preview matching contacts | — |
| `POST /segments/:id/evaluate` | — | Full recipient evaluation for send | — |
| `GET /sender-domains` | — | List sender domains | `apps/blast/src/pages/domain-settings.tsx` |
| `POST /sender-domains` | — | Add sender domain | `apps/blast/src/pages/domain-settings.tsx` |
| `POST /sender-domains/:id/verify` | — | Verify sender domain | `apps/blast/src/pages/domain-settings.tsx` |
| `DELETE /sender-domains/:id` | — | Remove sender domain | `apps/blast/src/pages/domain-settings.tsx` |
| `GET /templates` | `blast_list_templates` | List email templates | `apps/blast/src/hooks/use-templates.ts` |
| `POST /templates` | `blast_create_template` | Create email template | `apps/blast/src/hooks/use-templates.ts` |
| `GET /templates/:id` | `blast_get_template` | Get template content | `apps/blast/src/hooks/use-templates.ts` |
| `PATCH /templates/:id` | — | Update template | `apps/blast/src/hooks/use-templates.ts` |
| `DELETE /templates/:id` | — | Delete template | `apps/blast/src/hooks/use-templates.ts` |
| `POST /templates/:id/duplicate` | — | Duplicate template | `apps/blast/src/hooks/use-templates.ts` |
| `POST /templates/:id/preview` | — | Render template with merge data | — |
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
| `POST /dashboards` | — | Create dashboard | `apps/bench/src/hooks/use-dashboards.ts` |
| `GET /dashboards/:id` | `bench_get_dashboard` | Get dashboard with widgets | `apps/bench/src/hooks/use-dashboards.ts` |
| `PATCH /dashboards/:id` | — | Update dashboard | `apps/bench/src/hooks/use-dashboards.ts` |
| `DELETE /dashboards/:id` | — | Delete dashboard | `apps/bench/src/hooks/use-dashboards.ts` |
| `POST /dashboards/:id/duplicate` | — | Clone dashboard | `apps/bench/src/hooks/use-dashboards.ts` |
| `POST /dashboards/:id/export` | — | Export dashboard (stub/queued) | — |
| `POST /dashboards/:id/widgets` | — | Add widget to dashboard | `apps/bench/src/hooks/use-widgets.ts` |
| `GET /data-sources` | `bench_list_data_sources` | List data sources + schemas | `apps/bench/src/hooks/use-data-sources.ts` |
| `GET /data-sources/:product/:entity` | — | Data-source detail | `apps/bench/src/hooks/use-data-sources.ts` |
| `GET /materialized-views` | — | List materialized views | — |
| `POST /materialized-views/:viewName/refresh` | — | Refresh a materialized view | — |
| `POST /query/preview` | `bench_query_ad_hoc` | Ad-hoc structured query | `apps/bench/src/pages/explorer.tsx` |
| `GET /reports` | `bench_list_scheduled_reports` | List scheduled reports | `apps/bench/src/hooks/use-reports.ts` |
| `POST /reports` | — | Create scheduled report | `apps/bench/src/hooks/use-reports.ts` |
| `PATCH /reports/:id` | — | Update report | — |
| `DELETE /reports/:id` | — | Delete report | `apps/bench/src/hooks/use-reports.ts` |
| `POST /reports/:id/send-now` | `bench_generate_report` | Trigger immediate report | `apps/bench/src/hooks/use-reports.ts` |
| `GET /saved-queries` | — | List saved queries | `apps/bench/src/hooks/use-saved-queries.ts` |
| `POST /saved-queries` | — | Create saved query | `apps/bench/src/hooks/use-saved-queries.ts` |
| `GET /saved-queries/:id` | — | Get saved query | `apps/bench/src/hooks/use-saved-queries.ts` |
| `PATCH /saved-queries/:id` | — | Update saved query | `apps/bench/src/hooks/use-saved-queries.ts` |
| `DELETE /saved-queries/:id` | — | Delete saved query | `apps/bench/src/hooks/use-saved-queries.ts` |
| `GET /widgets` | `bench_list_widgets` | List widgets across org | — |
| `GET /widgets/:id` | — | Get widget | `apps/bench/src/hooks/use-widgets.ts` |
| `PATCH /widgets/:id` | — | Update widget | `apps/bench/src/hooks/use-widgets.ts` |
| `DELETE /widgets/:id` | — | Delete widget | `apps/bench/src/hooks/use-widgets.ts` |
| `POST /widgets/:id/query` | `bench_query_widget` | Execute widget query | `apps/bench/src/hooks/use-widgets.ts` |
| `POST /widgets/:id/refresh` | — | Force cache refresh + re-query | `apps/bench/src/hooks/use-widgets.ts` |
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
| `GET /diagrams/:id/collaborators` | — | List diagram collaborators | — |
| `POST /diagrams/:id/collaborators` | — | Add collaborator | — |
| `DELETE /diagrams/:id/collaborators/:userId` | — | Remove collaborator | — |
| `GET /diagrams/:id/comments` | — | List anchored comments | — |
| `POST /diagrams/:id/comments` | — | Add a comment | — |
| `PATCH /diagrams/:id/comments/:cid` | — | Edit/resolve a comment | — |
| `GET /diagrams/:id/edges` | `blueprint_read_edges` | Read all edges | (via `/graph`) |
| `POST /diagrams/:id/edges` | `blueprint_add_edge` | Create an edge | `apps/blueprint/src/hooks/use-graph.ts` |
| `PATCH /diagrams/:id/edges/:edgeId` | `blueprint_update_edge` | Update an edge | `apps/blueprint/src/hooks/use-graph.ts` |
| `DELETE /diagrams/:id/edges/:edgeId` | `blueprint_delete_edge` | Delete an edge | `apps/blueprint/src/hooks/use-graph.ts` |
| `GET /diagrams/:id/export` | `blueprint_export` | Export json/mermaid/svg/png | `apps/blueprint/src/hooks/use-graph.ts` |
| `POST /diagrams/:id/generate` | `blueprint_generate` | Build graph from node/edge spec | — |
| `GET /diagrams/:id/graph` | — *(use read_nodes + read_edges)* | Full graph payload | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `POST /diagrams/:id/import` | — | Import Mermaid source | `apps/blueprint/src/hooks/use-graph.ts` |
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
| `POST /diagrams/:id/star` | — | Star a diagram | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `DELETE /diagrams/:id/star` | — | Unstar a diagram | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `GET /diagrams/:id/versions` | — | List versions | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `POST /diagrams/:id/versions` | — | Snapshot a version | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `POST /diagrams/:id/versions/:n/restore` | — | Restore a version | `apps/blueprint/src/hooks/use-diagrams.ts` |
| `POST /internal/sync-from-task` | — *(internal)* | Propagate Bam task edit into nodes | — |
| `GET /templates` | — | List diagram templates | — |
| `GET /ws` | — *(WebSocket)* | Realtime diagram subscription | `apps/blueprint/src/hooks/use-graph.ts` |
| `— *(client-side)*` | `blueprint_search` | Client-side name/description filter | — |


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
| `GET /book/api/v1/booking-pages` | — | List public booking pages | `apps/book/src/hooks/use-booking-pages.ts` |
| `POST /book/api/v1/booking-pages` | `book_create_booking_page` | Create a scheduling link page | `apps/book/src/hooks/use-booking-pages.ts` |
| `PATCH /book/api/v1/booking-pages/:id` | — | Update a booking page | `apps/book/src/pages/booking-page-editor.tsx` |
| `DELETE /book/api/v1/booking-pages/:id` | — | Delete a booking page | `apps/book/src/hooks/use-booking-pages.ts` |
| `GET /book/api/v1/calendars` | — | List caller's calendars (resolver source) | `apps/book/src/hooks/use-calendars.ts` |
| `POST /book/api/v1/calendars` | — | Create a calendar | `apps/book/src/hooks/use-calendars.ts` |
| `PATCH /book/api/v1/calendars/:id` | — | Update a calendar | `apps/book/src/hooks/use-calendars.ts` |
| `DELETE /book/api/v1/calendars/:id` | — | Delete a calendar | `apps/book/src/hooks/use-calendars.ts` |
| `POST /book/api/v1/calendars/:id/ical` | — | Mint an iCal feed token | `apps/book/src/pages/connections.tsx` |
| `GET /book/api/v1/calendars/:id/ical` | — | Public token-auth `.ics` feed | — (external calendar client) |
| `GET /book/api/v1/connections` | — | List external calendar connections | `apps/book/src/pages/connections.tsx` |
| `POST /book/api/v1/connections/google` | — | Connect a Google calendar | `apps/book/src/pages/connections.tsx` |
| `POST /book/api/v1/connections/microsoft` | — | Connect a Microsoft calendar | `apps/book/src/pages/connections.tsx` |
| `DELETE /book/api/v1/connections/:id` | — | Remove a calendar connection | `apps/book/src/pages/connections.tsx` |
| `POST /book/api/v1/connections/:id/sync` | — | Force-sync a connection | `apps/book/src/pages/connections.tsx` |
| `GET /book/api/v1/events` | `book_list_events` | List events in a date range | `apps/book/src/hooks/use-events.ts` |
| `POST /book/api/v1/events` | `book_create_event` | Create an event with attendees | `apps/book/src/hooks/use-events.ts` |
| `GET /book/api/v1/events/:id` | — | Get one event | `apps/book/src/pages/event-detail.tsx` |
| `PATCH /book/api/v1/events/:id` | `book_update_event` | Update an event | `apps/book/src/hooks/use-events.ts` |
| `DELETE /book/api/v1/events/:id` | `book_cancel_event` | Soft-cancel an event | `apps/book/src/hooks/use-events.ts` |
| `POST /book/api/v1/events/:id/rsvp` | `book_rsvp_event` | Accept/decline/tentative RSVP | `apps/book/src/pages/event-detail.tsx` |
| `GET /book/api/v1/timeline` | `book_get_timeline` | Cross-product aggregated timeline | `apps/book/src/pages/timeline.tsx` |
| `GET /book/api/v1/working-hours` | — | Get caller's working hours | `apps/book/src/pages/connections.tsx` |
| `PUT /book/api/v1/working-hours` | — | Set caller's working hours | `apps/book/src/pages/connections.tsx` |
| `GET /book/api/meet/:slug` | — | Public booking-page info | `apps/book/src/pages/meet.tsx` |
| `GET /book/api/meet/:slug/slots` | — | Public available slots | `apps/book/src/pages/meet.tsx` |
| `POST /book/api/meet/:slug/book` | — | Public slot booking | `apps/book/src/pages/meet.tsx` |
| `GET /book/api/v1/availability/team` *(reused)* | `book_find_meeting_time` | AI: top-3 common slots (client-side intersect) | — |


## Blank (app)

- **Service:** `apps/blank-api` · external `/blank/api/` · MCP module(s): `blank-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /blank/api/v1/fields/:id` *(none)* | — | *(no field GET; see PATCH/DELETE)* | — |
| `PATCH /blank/api/v1/fields/:id` | — | Update a form field | `apps/blank/src/pages/form-builder.tsx` |
| `DELETE /blank/api/v1/fields/:id` | — | Delete a form field | `apps/blank/src/pages/form-builder.tsx` |
| `GET /blank/api/v1/forms` | `blank_list_forms` | List forms (status/project filters) | `apps/blank/src/hooks/use-forms.ts` |
| `POST /blank/api/v1/forms` | `blank_create_form` | Create a form with inline fields | `apps/blank/src/hooks/use-forms.ts` |
| `GET /blank/api/v1/forms/:id` | `blank_get_form` | Get a form with its fields | `apps/blank/src/hooks/use-forms.ts` |
| `PATCH /blank/api/v1/forms/:id` | `blank_update_form` | Update form metadata/settings | `apps/blank/src/pages/form-settings.tsx` |
| `DELETE /blank/api/v1/forms/:id` | — | Delete a form | `apps/blank/src/hooks/use-forms.ts` |
| `GET /blank/api/v1/forms/:id/analytics` | `blank_summarize_responses` · `blank_get_form_analytics` | Per-field response aggregation | `apps/blank/src/pages/form-analytics.tsx` |
| `POST /blank/api/v1/forms/:id/close` | — | Close a form to submissions | `apps/blank/src/pages/form-settings.tsx` |
| `POST /blank/api/v1/forms/:id/duplicate` | — | Clone a form | `apps/blank/src/hooks/use-forms.ts` |
| `GET /blank/api/v1/forms/:id/embed-code` | — | Get embed snippet | `apps/blank/src/pages/form-settings.tsx` |
| `POST /blank/api/v1/forms/:id/fields` | — | Add a field to a form | `apps/blank/src/pages/form-builder.tsx` |
| `POST /blank/api/v1/forms/:id/fields/reorder` | — | Bulk reorder fields | `apps/blank/src/pages/form-builder.tsx` |
| `POST /blank/api/v1/forms/:id/publish` | `blank_publish_form` | Publish a draft form | `apps/blank/src/pages/form-settings.tsx` |
| `GET /blank/api/v1/forms/:id/submissions` | `blank_list_submissions` | List a form's submissions | `apps/blank/src/pages/form-responses.tsx` |
| `GET /blank/api/v1/forms/:id/submissions/export` | `blank_export_submissions` | Export submissions as CSV | `apps/blank/src/pages/form-responses.tsx` |
| `GET /blank/api/v1/submissions/:id` | `blank_get_submission` | Get one submission's data | `apps/blank/src/pages/form-responses.tsx` |
| `DELETE /blank/api/v1/submissions/:id` | — | Delete a submission | `apps/blank/src/pages/form-responses.tsx` |
| `GET /blank/api/forms/:slug` | — | Public rendered form HTML | `apps/blank/src/pages/public-form.tsx` |
| `GET /blank/api/forms/:slug/definition` | — | Public form field definitions | `apps/blank/src/pages/public-form.tsx` |
| `POST /blank/api/forms/:slug/submit` | — | Public submit a response | `apps/blank/src/pages/public-form.tsx` |
| `— *(client-side)*` | `blank_generate_form` | AI builds a form spec from NL description | — |


## Bill (app)

- **Service:** `apps/bill-api` · external `/bill/api/` · MCP module(s): `bill-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /bill/api/v1/clients` | `bill_list_clients` | List/search billing clients | `apps/bill/src/hooks/use-clients.ts` |
| `POST /bill/api/v1/clients` | — | Create a billing client | `apps/bill/src/hooks/use-clients.ts` |
| `GET /bill/api/v1/clients/:id` | — | Get one client | `apps/bill/src/pages/client-detail.tsx` |
| `PATCH /bill/api/v1/clients/:id` | — | Update a client | `apps/bill/src/hooks/use-clients.ts` |
| `DELETE /bill/api/v1/clients/:id` | — | Delete a client | `apps/bill/src/hooks/use-clients.ts` |
| `GET /bill/api/v1/expenses` | `bill_list_expenses` | List expenses (filters) | `apps/bill/src/hooks/use-expenses.ts` |
| `POST /bill/api/v1/expenses` | `bill_create_expense` | Log an expense | `apps/bill/src/hooks/use-expenses.ts` |
| `PATCH /bill/api/v1/expenses/:id` | — | Update an expense | `apps/bill/src/hooks/use-expenses.ts` |
| `DELETE /bill/api/v1/expenses/:id` | — | Delete an expense | `apps/bill/src/hooks/use-expenses.ts` |
| `POST /bill/api/v1/expenses/:id/approve` | — | Approve an expense | `apps/bill/src/pages/expense-list.tsx` |
| `POST /bill/api/v1/expenses/:id/reject` | — | Reject an expense | `apps/bill/src/pages/expense-list.tsx` |
| `POST /bill/api/v1/expenses/:id/receipt` | — | Upload a receipt file | `apps/bill/src/pages/expense-new.tsx` |
| `GET /bill/api/v1/invoices` | `bill_list_invoices` | List invoices (filters) | `apps/bill/src/hooks/use-invoices.ts` |
| `POST /bill/api/v1/invoices` | `bill_create_invoice` | Create a draft invoice | `apps/bill/src/hooks/use-invoices.ts` |
| `GET /bill/api/v1/invoices/:id` | `bill_get_invoice` | Get invoice detail | `apps/bill/src/pages/invoice-detail.tsx` |
| `PATCH /bill/api/v1/invoices/:id` | — | Update an invoice | `apps/bill/src/pages/invoice-edit.tsx` |
| `DELETE /bill/api/v1/invoices/:id` | — | Delete an invoice | `apps/bill/src/hooks/use-invoices.ts` |
| `POST /bill/api/v1/invoices/:id/duplicate` | — | Duplicate an invoice | `apps/bill/src/pages/invoice-detail.tsx` |
| `POST /bill/api/v1/invoices/:id/finalize` | `bill_finalize_invoice` | Finalize, assign number, lock | `apps/bill/src/pages/invoice-detail.tsx` |
| `GET /bill/api/v1/invoices/:id/jobs` | — | Latest PDF/email job state | `apps/bill/src/pages/invoice-detail.tsx` |
| `POST /bill/api/v1/invoices/:id/line-items` | `bill_add_line_item` | Add a line item | `apps/bill/src/pages/invoice-edit.tsx` |
| `PATCH /bill/api/v1/invoices/:id/line-items/:itemId` | — | Update a line item | `apps/bill/src/pages/invoice-edit.tsx` |
| `DELETE /bill/api/v1/invoices/:id/line-items/:itemId` | — | Delete a line item | `apps/bill/src/pages/invoice-edit.tsx` |
| `POST /bill/api/v1/invoices/:id/payments` | `bill_record_payment` | Record a payment | `apps/bill/src/pages/invoice-detail.tsx` |
| `GET /bill/api/v1/invoices/:id/pdf` | — | Generate/return invoice PDF | `apps/bill/src/pages/invoice-detail.tsx` |
| `POST /bill/api/v1/invoices/:id/send` | `bill_send_invoice` | Mark sent, queue email | `apps/bill/src/pages/invoice-detail.tsx` |
| `POST /bill/api/v1/invoices/:id/void` | — | Void an invoice | `apps/bill/src/pages/invoice-detail.tsx` |
| `POST /bill/api/v1/invoices/from-deal` | `bill_create_invoice_from_deal` | Draft invoice from a Bond deal | — |
| `POST /bill/api/v1/invoices/from-time-entries` | `bill_create_invoice_from_time` | Invoice from Bam time entries | `apps/bill/src/pages/invoice-from-time.tsx` |
| `DELETE /bill/api/v1/payments/:id` | — | Delete a payment | `apps/bill/src/pages/invoice-detail.tsx` |
| `GET /bill/api/v1/rates` | — | List billing rates | `apps/bill/src/hooks/use-rates.ts` |
| `POST /bill/api/v1/rates` | — | Create a rate | `apps/bill/src/hooks/use-rates.ts` |
| `PATCH /bill/api/v1/rates/:id` | — | Update a rate | `apps/bill/src/hooks/use-rates.ts` |
| `DELETE /bill/api/v1/rates/:id` | — | Delete a rate | `apps/bill/src/hooks/use-rates.ts` |
| `GET /bill/api/v1/rates/resolve` | `bill_resolve_rate` | Resolve effective rate (project/user/date) | — |
| `GET /bill/api/v1/reports/outstanding` | — | Outstanding-balance report | `apps/bill/src/hooks/use-reports.ts` |
| `GET /bill/api/v1/reports/overdue` | `bill_get_overdue` | Overdue invoices report | `apps/bill/src/hooks/use-reports.ts` |
| `GET /bill/api/v1/reports/profitability` | `bill_get_profitability` | Revenue-vs-expense per project | `apps/bill/src/hooks/use-reports.ts` |
| `GET /bill/api/v1/reports/revenue` | `bill_get_revenue_summary` | Revenue summary by month | `apps/bill/src/hooks/use-reports.ts` |
| `GET /bill/api/v1/settings` | — | Get org billing settings | `apps/bill/src/pages/settings.tsx` |
| `PUT /bill/api/v1/settings` | — | Update org billing settings | `apps/bill/src/pages/settings.tsx` |
| `GET /bill/api/invoice/:token` | — | Public token-auth invoice view | — (public link) |
| `GET /bill/api/invoice/:token/pdf` | — | Public token-auth invoice PDF | — (public link) |


## Bureau (app)

- **Service:** `apps/bureau-api` · external `/bureau/api/` · MCP module(s): `bureau-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /bureau/api/v1/bookings/:id` *(none)* | — | *(no booking GET; PATCH/DELETE only)* | — |
| `PATCH /bureau/api/v1/bookings/:id` | — | Update a room booking window | — |
| `DELETE /bureau/api/v1/bookings/:id` | `bureau_cancel_booking` | Soft-cancel a booking (confirm) | — |
| `GET /bureau/api/v1/chat/rooms` | — | List caller's chat threads | `apps/bureau/src/pages/chats.tsx` |
| `GET /bureau/api/v1/chat/rooms/:roomKey/messages` | — | Chat transcript recovery | `apps/bureau/src/pages/chats.tsx` |
| `PATCH /bureau/api/v1/chat/rooms/:roomKey/retention` | — | Set chat retention (admin) | `apps/bureau/src/pages/chats.tsx` |
| `GET /bureau/api/v1/floors` | `bureau_list_floors` | List floors with occupancy | `apps/bureau/src/hooks/use-floors.ts` |
| `POST /bureau/api/v1/floors` | `bureau_create_floor` | Create a floor (admin) | `apps/bureau/src/pages/admin/floor-list.tsx` |
| `GET /bureau/api/v1/floors/:id` | `bureau_get_floor` | Floor detail + rooms + occupancy | `apps/bureau/src/hooks/use-floors.ts` |
| `PATCH /bureau/api/v1/floors/:id` | — | Update/unarchive a floor (admin) | `apps/bureau/src/pages/admin/floor-editor.tsx` |
| `DELETE /bureau/api/v1/floors/:id` | — | Soft-delete a floor (admin) | `apps/bureau/src/pages/admin/floor-list.tsx` |
| `POST /bureau/api/v1/floors/:id/background` | — | Set floor background URL (admin) | `apps/bureau/src/pages/admin/floor-editor.tsx` |
| `POST /bureau/api/v1/knocks` | `bureau_knock` | Knock on an office door | `apps/bureau/src/stores/bureau-store.ts` |
| `PATCH /bureau/api/v1/knocks/:id` | `bureau_respond_knock` | Owner admits/defers/declines | `apps/bureau/src/stores/bureau-store.ts` |
| `GET /bureau/api/v1/knocks/inbox` | — | Pending knocks for the owner | `apps/bureau/src/stores/bureau-store.ts` |
| `POST /bureau/api/v1/knocks/leave-note` | — | DND fallback: DM the owner | `apps/bureau/src/stores/bureau-store.ts` |
| `GET /bureau/api/v1/offices` | — | All offices + owners (admin) | `apps/bureau/src/pages/admin/offices.tsx` |
| `POST /bureau/api/v1/offices/assign` | — | Assign an office to a user (admin) | `apps/bureau/src/pages/admin/offices.tsx` |
| `GET /bureau/api/v1/offices/mine` | — | Caller's owned office | `apps/bureau/src/pages/floor-list.tsx` |
| `GET /bureau/api/v1/presence/here` | — | Co-presence by URL chip | `apps/bureau/src/hooks/use-bureau-ws.ts` |
| `GET /bureau/api/v1/presence/where/:userId` | — | Locate a user ("Hunt") | `apps/bureau/src/hooks/use-bureau-ws.ts` |
| `POST /bureau/api/v1/ring` | — | Ring a user on a surface | `apps/bureau/src/hooks/use-bureau-ws.ts` |
| `GET /bureau/api/v1/rooms/:id` | `bureau_who_is_in_room` | Room detail + live occupants | `apps/bureau/src/components/floor-editor/room-inspector.tsx` |
| `POST /bureau/api/v1/rooms` | `bureau_create_room` | Create a room on a floor | `apps/bureau/src/pages/admin/floor-editor.tsx` |
| `PATCH /bureau/api/v1/rooms/:id` | `bureau_update_room` | Update room fields | `apps/bureau/src/components/floor-editor/room-inspector.tsx` |
| `DELETE /bureau/api/v1/rooms/:id` | — | Soft-delete a room (admin) | `apps/bureau/src/pages/admin/floor-editor.tsx` |
| `POST /bureau/api/v1/rooms/:id/acl` | — | Upsert a room ACL entry | `apps/bureau/src/components/floor-editor/room-inspector.tsx` |
| `DELETE /bureau/api/v1/rooms/:id/acl/:userId` | — | Remove a room ACL entry | `apps/bureau/src/components/floor-editor/room-inspector.tsx` |
| `GET /bureau/api/v1/rooms/:id/bookings` | `bureau_list_bookings` | List room bookings in a window | — |
| `POST /bureau/api/v1/rooms/:id/bookings` | `bureau_book_room` | Reserve a room (confirm) | — |
| `PATCH /bureau/api/v1/rooms/:id/door` | `bureau_set_door_state` | Set room default privacy | `apps/bureau/src/components/floor-editor/room-inspector.tsx` |
| `POST /bureau/api/v1/rooms/:id/token` | `bureau_move_self` | Mint LiveKit token / enter room | `apps/bureau/src/hooks/use-bureau-ws.ts` |
| `POST /bureau/api/v1/summon` | `bureau_summon` | Summon co-occupants to a URL (confirm) | `apps/bureau/src/stores/bureau-store.ts` |
| `GET /bureau/api/v1/summons/:id` | — | Summon audit-row lookup | — |
| `POST /bureau/api/v1/summons/:id/grant-access` | — | Grant-and-summon follow-up | `apps/bureau/src/stores/bureau-store.ts` |
| `POST /bureau/api/v1/surface-huddle/token` | — | Mint surface-huddle LiveKit token | `apps/bureau/src/hooks/use-bureau-ws.ts` |
| `GET /bureau/api/v1/settings` | — | Get org Bureau settings | `apps/bureau/src/pages/floor-list.tsx` |
| `PATCH /bureau/api/v1/settings` | — | Update Bureau settings (admin) | `apps/bureau/src/pages/admin/floor-list.tsx` |
| `— *(stub; no endpoint)*` | `bureau_locate_user` | Locate user — stub (`/presence/locate` unimplemented) | — |
| `— *(stub; no endpoint)*` | `bureau_get_presence` | Org presence map — stub (`/presence` unimplemented) | — |
| `— *(stub; no endpoint)*` | `bureau_set_status` | Set DND/away — stub (`PATCH /me/status` unimplemented) | — |


## Helpdesk (app)

- **Service:** `apps/helpdesk-api` · external `/helpdesk/api/` · MCP module(s): `helpdesk-tools.ts`, `dedupe-tools.ts`, `phrase-count-tools.ts`

(nginx rewrites `/helpdesk/api/*` → `/helpdesk/*`; the in-code `/helpdesk` segment below is what
the upstream registers, so external path = `/helpdesk/api/` + the part after `/helpdesk/`.)

| REST endpoint | MCP tool | Description | UI call site |
| --- | --- | --- | --- |
| `GET /helpdesk/api/agents/agents/queue` | — | Agent SLA-aware ticket queue | — (agent console) |
| `GET /helpdesk/api/agents/tickets` | `list_tickets` *(via customer route)* | Agent: org-scoped ticket list | — |
| `GET /helpdesk/api/agents/tickets/:id` | — | Agent: ticket detail + internal msgs | — |
| `GET /helpdesk/api/agents/tickets/:id/similar` | `helpdesk_find_similar_tickets` | Ranked similar/duplicate tickets | — |
| `POST /helpdesk/api/agents/tickets/:id/close` | — | Agent: close a ticket | — |
| `POST /helpdesk/api/agents/tickets/:id/merge` | — | Agent: true-merge into a primary | — |
| `POST /helpdesk/api/agents/tickets/:id/messages` | — | Agent: post reply/internal note | — |
| `PATCH /helpdesk/api/agents/tickets/:id` | — | Agent: update status/priority/category | — |
| `GET /helpdesk/api/agents/tickets/by-number/:number` | `helpdesk_get_ticket_by_number` | Resolve ticket by human number | — |
| `GET /helpdesk/api/agents/tickets/search` | `helpdesk_search_tickets` | Fuzzy ticket search (agent, org-scoped) | — |
| `GET /helpdesk/api/admin/projects` | — | List org projects for default picker | `apps/helpdesk/src/pages/org-picker.tsx` |
| `GET /helpdesk/api/events` | — | Replay event log across own tickets | `apps/helpdesk/src/hooks/use-tickets.ts` |
| `GET /helpdesk/api/public-settings` | `helpdesk_get_public_settings` | Public helpdesk settings (no auth) | `apps/helpdesk/src/pages/register.tsx` |
| `GET /helpdesk/api/public/orgs` | — | Public org-picker list | `apps/helpdesk/src/pages/org-picker.tsx` |
| `GET /helpdesk/api/public/orgs/:slug` | — | Public org/portal discovery | `apps/helpdesk/src/stores/tenant.store.ts` |
| `GET /helpdesk/api/settings` | `helpdesk_get_settings` · `helpdesk_set_default_project` | Full settings (admin) | `apps/helpdesk/src/app.tsx` |
| `PATCH /helpdesk/api/settings` | `helpdesk_update_settings` · `helpdesk_set_default_project` | Update settings (admin) | `apps/helpdesk/src/app.tsx` |
| `GET /helpdesk/api/tickets` | `list_tickets` | List caller's own tickets | `apps/helpdesk/src/hooks/use-tickets.ts` |
| `POST /helpdesk/api/tickets` | — | Create a ticket (customer) | `apps/helpdesk/src/pages/new-ticket.tsx` |
| `GET /helpdesk/api/tickets/search` | `helpdesk_search_tickets` *(agent route)* | Customer FTS over own tickets | `apps/helpdesk/src/pages/tickets-list.tsx` |
| `GET /helpdesk/api/tickets/:id` | `get_ticket` | Ticket detail + messages | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `GET /helpdesk/api/tickets/by-number/:number` *(agent)* | `helpdesk_get_ticket_by_number` | Resolve by number — tool uses agent route | — |
| `GET /helpdesk/api/tickets/:id/activity` | — | Ticket audit trail | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `GET /helpdesk/api/tickets/:id/attachments` | — | List ticket attachments | `apps/helpdesk/src/hooks/use-attachments.ts` |
| `POST /helpdesk/api/tickets/:id/attachments` | — | Upload a ticket attachment | `apps/helpdesk/src/hooks/use-attachments.ts` |
| `DELETE /helpdesk/api/tickets/:id/attachments/:attachmentId` | — | Delete a ticket attachment | `apps/helpdesk/src/hooks/use-attachments.ts` |
| `GET /helpdesk/api/tickets/:id/events` | — | Per-ticket event-log replay | `apps/helpdesk/src/hooks/use-tickets.ts` |
| `GET /helpdesk/api/tickets/:id/messages` | — | Paginated message history | `apps/helpdesk/src/hooks/use-ticket-messages.ts` |
| `POST /helpdesk/api/tickets/:id/messages` | `reply_to_ticket` | Post a message (customer/agent) | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `PATCH /helpdesk/api/tickets/:id` *(agent route)* | `update_ticket_status` | Update ticket status (tool → agent route) | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `POST /helpdesk/api/tickets/:id/close` | — | Customer closes own ticket | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `POST /helpdesk/api/tickets/:id/reopen` | — | Customer reopens a ticket | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `POST /helpdesk/api/tickets/:id/update-priority` | — | Customer changes priority | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `POST /helpdesk/api/tickets/:id/mark-duplicate` | — | Customer flags duplicate | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `DELETE /helpdesk/api/tickets/:id/mark-duplicate` | — | Customer clears duplicate flag | `apps/helpdesk/src/pages/ticket-detail.tsx` |
| `POST /helpdesk/api/upload` | — | Generic multipart file upload | `apps/helpdesk/src/pages/new-ticket.tsx` |
| `GET /helpdesk/api/v1/tickets/analytics/count-by-phrase` | `helpdesk_ticket_count_by_phrase` | Ticket counts bucketed by phrase | — |
| `POST /helpdesk/api/v1/helpdesk-users/upsert` | `helpdesk_upsert_user` | Idempotent helpdesk-user upsert | — |


## Cross-app / agentic platform surface

External prefix for the Bam api is `/b3/api/`, so a route shown as `POST /v1/proposals` is reachable externally at `/b3/api/v1/proposals`. Routes whose path begins with `/internal/` are service-to-service only (NOT exposed through nginx) and are labeled accordingly. A handful of MCP tools fan out across several apps with no single backing endpoint; those are marked `— *(composite)*` with the services they hit named in the description.

## Cross-app — Agent identity, audit & heartbeat

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/agent-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /v1/agents` | — | List agent runners in caller's active org | — |
| `GET /v1/agents/:agent_user_id/audit` | `agent_audit` | Paginated `activity_log` stream for one agent | — |
| `POST /v1/agents/heartbeat` | `agent_heartbeat` | Service-account only; upsert `agent_runners` row | — |
| `POST /v1/agents/self-report` | `agent_self_report` | Service-account only; append `agent.self_report` log | — |


## Cross-app — Approval queues (proposals)

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/proposal-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /v1/approvals` | — | Deprecated fire-and-forget `approval.requested` emitter | — |
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
| `GET /v1/attachments/_meta` | — | Supported parent types and scan-status values | — |


## Cross-app — Agent policies & outbound webhooks

- **Surface:** cross-app · API `apps/api` · MCP module(s): `apps/mcp-server/src/tools/agent-policy-tools.ts`, `apps/mcp-server/src/tools/agent-webhook-tools.ts`

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `GET /v1/agent-policies` | `agent_policy_list` | List agent policy rows in caller's org | `apps/frontend/src/pages/superuser/agents-list.tsx` |
| `GET /v1/agent-policies/:agent_user_id` | `agent_policy_get` | Get one agent's kill-switch + allowlist policy | — |
| `POST /v1/agent-policies/:agent_user_id` | `agent_policy_set` | Upsert an agent policy (enabled, allowed_tools, etc.) | `apps/frontend/src/pages/superuser/agents-list.tsx` |
| `POST /v1/agent-policies/:agent_user_id/check` | — | Internal tool-name allow/deny check (register-tool wrapper) | — |
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

- **Surface:** cross-app · API `apps/api` · MCP module(s): none

| REST endpoint | MCP tool | Description | UI call site |
|---|---|---|---|
| `POST /internal/helpdesk/comments` | — | Internal: post a Bam comment from a helpdesk ticket | — |
| `GET /internal/helpdesk/queue` | — | Session-auth proxy to helpdesk ticket queue | `apps/frontend/src/pages/helpdesk-agent-queue.tsx` |
| `POST /internal/helpdesk/tasks` | — | Internal: create a Bam task from a helpdesk ticket | — |
| `POST /internal/helpdesk/tasks/:id/move-to-terminal-phase` | — | Internal: close ticket's task into terminal phase | — |
| `POST /internal/helpdesk/tasks/:id/reopen` | — | Internal: reopen ticket's task to first non-terminal phase | — |
| `POST /internal/llm/chat` | — | Internal: proxy chat completion through stored provider keys | — |
| `POST /internal/permissions/dual-read` | — | Internal: MCP permission dual-read + divergence telemetry | — |
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

- **Bearing client/server path mismatches (likely live bugs):** the Bearing SPA calls `POST /goals/:id/override-status` (server route is `POST /goals/:id/status`), `POST /key-results/:id/set-value` (server is `POST /key-results/:id/value`), and `GET /periods/:id/report` (no such route — the report is at `/reports/period/:periodId`). These UI calls likely 404.
- **Bureau presence tools unwired:** `bureau_locate_user`, `bureau_get_presence`, `bureau_set_status` target endpoints (`/presence/locate`, `/presence`, `PATCH /me/status`) that don't exist on bureau-api (presence lives at `/presence/where/:userId`); they fail soft with stub envelopes.
- **Banter calling endpoints return HTTP 410 Gone:** `banter_start_call` / `join` / `leave` / `end` / `invite_agent` tools still exist, but calling moved to the Bureau docked-box and the endpoints are tombstoned.
- **Board / Blueprint granular write endpoints are MCP/agent-only:** the SPAs persist via `PUT /boards/:id/scene` (Board) and read via the composite `/graph` endpoint (Blueprint); many element/node write endpoints are reachable only through MCP tools, not the UI.
- **LLM-placeholder tools (stubbed, no model wired):** `blast_draft_email_content`, `blast_suggest_subject_lines`, `blank_generate_form`, `blank_summarize_responses`.
- **Coverage hotspots worth a deliberate decision:** entire areas have zero MCP tools — Bam attachments/uploads/versions, custom-fields/labels/phases mutations, comment edit/delete, OAuth/guests, iCal, LLM providers, and most SuperUser admin. Decide per-area whether agent access is wanted before filling them in.

