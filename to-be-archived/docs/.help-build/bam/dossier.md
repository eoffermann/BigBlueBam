# Bam Dossier

Research dossier for the **Bam** app (the BigBlueBam flagship). Sourced from
`apps/api/src` (backend), `apps/frontend/src` (frontend), the nine Bam MCP tool
files under `apps/mcp-server/src/tools/`, and existing docs at `docs/apps/bam/`.
All file paths are relative to the repo root.

---

## 1. App identity

- **app_key:** `bam`
- **Display name:** Bam (rendered literally as "Bam" in the sidebar header, apps/frontend/src/components/layout/sidebar.tsx line 24)
- **Category:** Project & task management
- **SPA path:** `/b3/` (BASE_PATH = '/b3' in apps/frontend/src/App.tsx line 65)
- **API path:** `/b3/api/` (Fastify api on internal :4000)
- **Backend dir:** apps/api/src (the ONE app whose backend is apps/api, not a *-api sibling)
- **Frontend dir:** apps/frontend/src
- **Prerequisites:** Authenticated session (cookie or `bbam_` API key). Most actions require project membership; some require project `admin` role or org `owner/admin`. Fresh installs are gated behind `/b3/bootstrap` until a SuperUser exists (App.tsx lines 206-221).
- **Default landing:** unknown routes fall through to the Dashboard (project list). Root `/` redirects to `/helpdesk/` at nginx; `/b3/` is the Bam SPA entry.

---

## 2. Key concepts and vocabulary

- **Organization (org):** top-level tenant. Roles: owner, admin, member (packages/shared/src/constants/index.ts line 7). A `guest` role also exists (label.routes.ts).
- **Project:** a board with its own phases, states, labels, epics, sprints, custom fields, templates. Has a `task_id_prefix` (2-6 uppercase letters, e.g. MAGE, FRND) and a `task_id_sequence`. Project roles: admin, member, viewer (constants line 9). Project templates: kanban_standard, scrum, bug_tracking, minimal, none (line 11).
- **Phase:** a board column. Has position, optional wip_limit, color, is_start, is_terminal, auto_state_on_enter (entering the phase can auto-set state). Source: phase.routes.ts, packages/shared/src/schemas/phase.ts.
- **Task state:** orthogonal to phase. Each state has a category in { todo, active, blocked, review, done, cancelled } (TASK_STATE_CATEGORIES, constants line 5) and an is_closed flag. Velocity sums story points of tasks whose state is_closed=true (sprint.routes.ts ~line 324).
- **Task:** the unit of work. Human id PREFIX-N (e.g. MAGE-38). Fields: title, description (rich text), phase_id, state_id, sprint_id, epic_id, assignee_id, reporter_id, priority, story_points, time_estimate_minutes / time_logged_minutes, start_date, due_date, position (float), labels[], watchers[], custom_fields (JSONB), links[], parent_task_id, subtask_count, comment_count, attachment_count, carry_forward_count, original_sprint_id, completed_at, is_blocked, blocking_task_ids[], blocked_by_task_ids[], external_id.
- **Priority:** wire value is a per-org configurable slug (migration 0183 + /priorities CRUD). Legacy/default set is critical, high, medium, low, none (PRIORITIES, constants line 1; UI labels in task-context-menu.tsx lines 57-62). The Zod schema accepts any [a-z0-9][a-z0-9_-]{0,49} slug, not a fixed enum (packages/shared/src/schemas/task.ts lines 11-15).
- **Sprint:** time-boxed iteration. Status in planned, active, completed, cancelled (SPRINT_STATUSES, constants line 3). Only one active sprint per project (SELECT ... FOR UPDATE in sprint.routes.ts). Has goal, start_date, end_date, velocity, closed_at, notes (retrospective). Default duration 14 days.
- **Carry-forward:** on active-sprint completion, incomplete tasks can be carried forward (move to target sprint, carry_forward_count++, original_sprint_id stamped), moved to backlog (sprint_id=null, "descoped"), or cancelled (left in the completed sprint). Tracked in sprint_tasks with removal_reason in { carried_forward, descoped }. Cards show a carry-forward badge.
- **Epic:** grouping of tasks across sprints. Status in open, in_progress, closed. Has name, description, color, start_date, target_date. Rollups: task_count, done_count, total/done story points (epic.routes.ts).
- **Label:** project-scoped tag (name, color, description, position).
- **Custom field:** project-scoped definition, JSONB value on tasks. Types: text, number, date, select, multi_select, checkbox, url (custom-field.routes.ts line 31). Flags: is_required, is_visible_on_card.
- **Saved view:** persisted filter/sort/swimlane/view_type preset, per-user or is_shared. view_type in board, list, timeline, calendar (view.routes.ts line 47).
- **Swimlane:** board grouping axis: None, By Assignee, By Priority, By Epic (board.tsx lines 51-56).
- **Task template:** reusable blueprint (name, title_pattern, description, priority, label_ids, phase_id, subtask_titles[], story_points) (template.routes.ts).
- **Time entry:** a row (not a counter) with minutes, date, description, user. Aggregated into time_logged_minutes on the task.
- **Comment:** rich-text body on a task. Supports edit (with revision history) and emoji reactions (toggle, unique on comment+user+emoji).
- **Attachment:** file on a task (MinIO storage_key + optional thumbnail).
- **Task link:** http(s) URL with title attached to a task (taskLinkSchema; cap 50/task).
- **Watcher:** user subscribed to a task notifications.
- **Done-gate / IncompleteSubtasksError:** a task cannot be moved/updated into a closed state while it has open subtasks; returns HTTP 409 INCOMPLETE_SUBTASKS (task.service.ts lines 71-164; surfaced via alert() in board.tsx lines 354-356).

---

## 3. Feature inventory

UI locations cite frontend files; routes cite apps/api/src/routes/. The api is mounted at /b3/api/.

### 3.1 Project dashboard / project list
- UI: apps/frontend/src/pages/dashboard.tsx. Title "Projects". Buttons "New Project" / "Create Project" (empty state "No projects yet"). Cards go to /projects/:id/board.
- Sidebar (sidebar.tsx): "Dashboard", "My Work", "Projects" list with a plus (Create project) button.
- Create dialog: createProjectSchema (name, task_id_prefix A-Z 2-6, description, slug, icon, color, template, default_sprint_duration_days).
- Routes (project.routes.ts): GET /projects (cached 30s), POST /projects (perm members_can_create_projects), GET /projects/:id, PATCH /projects/:id (admin only), DELETE /projects/:id (archive; admin + perm members_can_delete_own_projects).

### 3.2 Kanban board (primary view)
- UI: board.tsx, board-view.tsx, phase-column.tsx, task-card.tsx, inline-task-input.tsx. Route /projects/:id/board.
- Header: Sprint selector, FilterBar, Swimlanes (No Swimlanes / By Assignee / By Priority / By Epic), Lane-sort (epic only), ViewSwitcher (Board/List/Timeline/Calendar/Workload), icons: Dashboard, "Import tasks", "Task templates", "Saved views", "Manage epics", "Project options" three-dot menu.
- Project options menu (board.tsx 624-675): "Manage Phases", "Custom Fields", "Export", "Delete Project".
- Add task: per-column add opens CreateTaskDialog; inline add via inline-task-input.tsx.
- DnD: dnd-kit calls POST /tasks/:id/move (float positions).
- Context menu (task-context-menu.tsx): "Open detail", "Add subtask...", "Duplicate", "Priority" (Critical/High/Medium/Low/None), "Move to phase", "Set state", "Assign to..." (Unassigned + members), "Change parent task" (searchable), "Delete task" (confirm warns irreversible).
- Routes (task.routes.ts): GET /projects/:id/board, GET /projects/:id/tasks (filterable, cursor-paginated; filters sprint_id, phase_id, state_id, assignee_id, priority, labels; plus search).

### 3.3 Task CRUD + detail
- Create dialog (create-task-dialog.tsx): "Create Task"; fields "Title", "Phase", "Priority", "Story Points", "Assignee", "Due Date", "Labels", description, submit "Create Task".
- Detail drawer (task-detail-drawer.tsx): tabs "Details", "Comments", "Activity", conditional "Helpdesk" (when custom_fields.helpdesk_ticket_id present). Sections: subtasks/parents, time logging ("Time Logged"), attachments, task links, watchers, delete/duplicate. Reactions: thumbs-up, heart, rocket, eyes, party.
- Routes (task.routes.ts): POST /projects/:id/tasks, GET /tasks/:id, PATCH /tasks/:id, POST /tasks/:id/move, DELETE /tasks/:id, POST /tasks/:id/duplicate (include_subtasks), POST /tasks/bulk (update, move, or delete; up to 100 ids). Parents m2m: GET/POST /tasks/:id/parents, DELETE /tasks/:id/parents/:parentId, GET /tasks/:id/subtasks. Idempotent: POST /v1/tasks/upsert-by-external-id (key project_id + external_id; 201 create / 200 update). Ref resolver: GET /tasks/by-ref/:ref (PREFIX-123 to ids), used by /b3/tasks/ref/MAGE-38 (task-ref-resolver.tsx).
- Rules: done-gate (INCOMPLETE_SUBTASKS 409), parent cycle guards (TASK_SELF_PARENT 400, TASK_RELATION_CYCLE 409), auto_state_on_enter, completed_at set/cleared by state closed flag (task.service.ts).

### 3.4 Sprints
- UI: sprint-selector.tsx (board header), pages/sprint-report.tsx. Dropdown labels append "(Active)" / "(Done)". Controls: "Create sprint" (name placeholder Sprint 1, start/end dates, Optional goal), "Start this sprint", "Delete this sprint", "View sprint report".
- Complete flow (carry-forward-dialog.tsx): title "Complete Sprint: NAME"; per-task dropdown "Carry forward" / "Move to backlog" / "Cancel"; "Retrospective Notes (optional)"; submit "Complete Sprint".
- Routes (sprint.routes.ts): GET /projects/:id/sprints, POST /projects/:id/sprints (status planned), GET /sprints/:id, PATCH /sprints/:id, POST /sprints/:id/start (planned to active; rejects ACTIVE_SPRINT_EXISTS; fires Slack + sprint.started), POST /sprints/:id/complete (active to completed; carry-forward; velocity; fires sprint.completed), POST /sprints/:id/cancel (active/planned to cancelled; tasks to backlog), GET /sprints/:id/report.

### 3.5 Epics
- UI: EpicManager dialog (epic-manager.tsx, "Manage epics"); Epic detail page (pages/epic-detail.tsx, /projects/:id/epics/:epicId, group-by-sprint list + burnup). Epic chips (epic-chip.tsx) navigate to detail.
- Routes (epic.routes.ts): GET /projects/:id/epics (task_count), GET /epics/:id (rollup), GET /epics/:id/tasks, POST /projects/:id/epics, PATCH /epics/:id (logs epic.updated + epic.status_changed), DELETE /epics/:id. Emits epic.created/updated/status_changed.

### 3.6 Phases (columns)
- UI: PhaseManager dialog (phase-manager.tsx, "Manage Phases").
- Routes (phase.routes.ts): GET /projects/:id/phases, POST /projects/:id/phases, PATCH /phases/:id, DELETE /phases/:id with optional migrate_to query (re-homes tasks), POST /projects/:id/phases/reorder.

### 3.7 Task states
- Routes: GET /projects/:id/states (task-state.routes.ts). Seeded per project template (section 6).

### 3.8 Labels
- Routes (label.routes.ts): GET /projects/:id/labels, GET /labels (org-wide, MCP resolver), POST /projects/:id/labels, PATCH /labels/:id, DELETE /labels/:id.

### 3.9 Custom fields
- UI: CustomFieldManager (custom-field-manager.tsx, "Custom Fields").
- Routes (custom-field.routes.ts): GET/POST /projects/:id/custom-fields, PATCH/DELETE /custom-fields/:id. Types text, number, date, select, multi_select, checkbox, url.

### 3.10 Saved views
- UI: SavedViewsPanel (saved-views-panel.tsx, "Saved views").
- Routes (view.routes.ts): GET /projects/:id/views (own + shared), POST /projects/:id/views, PATCH /views/:id (owner only), DELETE /views/:id (owner only).

### 3.11 Alternate views (list/timeline/calendar/workload)
- UI: ViewSwitcher (view-switcher.tsx): Board, List, Timeline, Calendar, Workload. Components: list-view.tsx, timeline-view.tsx, calendar-view.tsx, workload-view.tsx (+ export menus). Workload click filters board by user.
- Backing: board task list + reports (workload uses /reports/workload).

### 3.12 Task templates
- UI: TemplateManager (template-manager.tsx, "Task templates"), template-picker.tsx.
- Routes (template.routes.ts): GET/POST /projects/:id/task-templates, POST /projects/:id/task-templates/:templateId/apply (task + subtasks; overrides), DELETE /task-templates/:id.

### 3.13 Import
- UI: ImportDialog (import-dialog.tsx) with CSV mapping panels; Slack import card in Settings.
- Routes (import.routes.ts): POST /projects/:id/import/csv, /import/csv/preview (dry run), /import/trello, /import/jira, /import/github. CSV supports value_maps, link_mappings, custom_field_mapping, duplicate_strategy (create/skip/update), date_locale (us/iso).

### 3.14 Export
- UI: Export dialog from project menu (board.tsx 774-821): Format JSON/CSV, Sprint optional (All sprints or specific), submit "Export".
- Route: POST /projects/:id/export (rate-limited 3/min) (export.routes.ts).

### 3.15 iCal feed
- Routes (ical.routes.ts): GET /projects/:id/calendar.ics, GET /me/calendar.ics with token query, POST/GET /projects/:id/calendar-tokens, DELETE /projects/:id/calendar-tokens/:tokenId, GET /public/projects/:id/calendar.ics with token. UI: calendar-export-menu.tsx.

### 3.16 Comments + reactions + revisions
- Routes (comment.routes.ts, reaction.routes.ts): GET /tasks/:id/comments (cursor-paginated, embeds reactions), POST /tasks/:id/comments (fires comment.created), PATCH /comments/:id (owner only; snapshots revision), GET /comments/:id/revisions, DELETE /comments/:id (owner only). Reactions: POST /comments/:id/reactions (toggle), GET /comments/:id/reactions.

### 3.17 Time tracking
- Routes (time-entry.routes.ts): POST/GET /tasks/:id/time-entries, GET /me/time-entries with start_date/end_date. Increments task time_logged_minutes.

### 3.18 Attachments
- Routes (attachment.routes.ts): POST/GET /tasks/:id/attachments, DELETE /attachments/:id. Upload presign in upload.routes.ts.

### 3.19 Reports + project dashboard
- UI: project-dashboard.tsx (/projects/:id/dashboard), project-reports.tsx (/projects/:id/reports), charts (burndown-chart.tsx, cfd-chart.tsx, velocity-chart.tsx).
- Routes (report.routes.ts): GET /projects/:id/reports/velocity (last N), /reports/burndown with sprint_id (supports ACTIVE sentinel), /reports/cfd, /reports/cycle-time (avg/median lead time), /reports/overdue, /reports/workload, /reports/time-tracking with from/to, /reports/status-distribution.

### 3.20 Audit log
- UI: pages/audit-log.tsx (/projects/:id/audit-log).
- Backing: activity.routes.ts + activity-unified.routes.ts; append-only activity_log (monthly partitioned).

### 3.21 People / members
- UI: pages/people.tsx + pages/people/detail.tsx (/people, /people/:userId). Tabbed user detail (profile, projects, access, activity). SuperUser at /superuser/people.
- Routes: GET /projects/:id/members, POST /projects/:id/members (admin only). Org/user mgmt in org.routes.ts, user.routes.ts, guest.routes.ts.

### 3.22 My Work
- UI: pages/my-work.tsx (/my-work). Title "My Work"; cards "Overdue", "Due This Week", "In Progress", "All My Tasks". Mirrors MCP get_my_tasks.

### 3.23 Settings
- UI: pages/settings.tsx (/settings). Tabs: Profile, Appearance (system/light/dark), Notifications, Members, Tasks (incl. "Manage Priorities"), Permissions, Launchpad, Integrations (API keys, Agents/service accounts, webhooks, Slack, SMTP), AI Providers, Helpdesk.
- Routes: priority.routes.ts, api-key.routes.ts, service-account.routes.ts, webhook.routes.ts, slack-integration.routes.ts, github-integration.routes.ts, llm-provider.routes.ts, system-settings.routes.ts, notification.routes.ts.

### 3.24 Command palette + keyboard shortcuts
- UI: command-palette.tsx (Cmd/Ctrl+K), keyboard-shortcuts-overlay.tsx. Shortcuts: N create task, S or slash focus search, F toggle filter, Esc close, question-mark toggle overlay/open Help (/help, HelpViewer appSlug bam), Ctrl/Cmd+K palette.

### 3.25 Notifications
- Routes (notification.routes.ts): GET /me/notifications, POST /me/notifications/mark-read, /mark-all-read, /me/notifications/:id/read. MCP mirrors: list_my_notifications, mark_notification(s)_read, mark_all_notifications_read.

### 3.26 Cross-app integrations into Bam
- Helpdesk panel in drawer (helpdesk-panel.tsx) for ticket-created tasks.
- GitHub commit/PR links (github-integration.routes.ts, github-webhook.routes.ts; suggest_branch_name tool).
- Slack outbound on sprint start/complete + task events (slack-notify.service.ts).
- Bolt events from task/sprint/epic/comment mutations (publishBoltEvent source bam).
- Launchpad cross-app nav (launchpad.routes.ts).

---

## 4. Candidate user stories

1. Spin up a project from a template. Dashboard then New Project then name + 2-6 letter prefix + pick template (kanban_standard/scrum/bug_tracking/minimal) then land on the board with phases + states seeded.
2. Plan and run a sprint. Create sprint (name/dates/goal) then add tasks then Start this sprint then work the board then Complete Sprint then choose carry-forward / backlog / cancel per leftover task then add retrospective notes then review velocity.
3. Create and work a task end-to-end. Press N or per-column add then fill Create Task then drag across phases then set a closed state (done-gate blocks if open subtasks) then log time then comment then react then attach files.
4. Carry forward unfinished work. At sprint completion mark incomplete tasks Carry forward to next sprint; cards show a carry-forward badge; original_sprint_id preserved for reporting.
5. Group work under an epic. Manage epics then create epic then assign tasks then open epic detail for by-sprint progress and burnup.
6. Customize the board. Manage Phases (reorder, WIP limits, auto-state) + Custom Fields (add a select/url field, show on card) + Labels.
7. Slice the board with views. Switch Board/List/Timeline/Calendar/Workload, apply swimlanes (assignee/priority/epic), filter, then save a shared Saved View.
8. Import an existing backlog. Import dialog then CSV (map columns, preview, value/link/custom-field maps, duplicate_strategy) or Trello/Jira/GitHub.
9. Report on delivery. Project dashboard / reports: velocity, burndown, CFD, cycle time, overdue, workload, time-tracking, status distribution.
10. Track personal load. My Work: Overdue / Due This Week / In Progress / All My Tasks.
11. Subscribe a calendar. Generate a calendar token then subscribe to /me/calendar.ics or the project feed in an external calendar app.
12. Deep-link a task across apps. A Banter/email MAGE-38 reference then /b3/tasks/ref/MAGE-38 resolves to the project board with the task drawer open.

---

## 5. Agent flows (MCP)

Bam tools span nine files: apps/mcp-server/src/tools/{task,sprint,project,epic,member,report,template,comment,import}-tools.ts. The catalog accepts natural identifiers (project/phase/sprint/label names, user email, human_id like FRND-42) plus UUIDs.

- Tasks (task-tools.ts): search_tasks, get_task, bam_get_task_by_human_id, create_task, update_task, move_task, delete_task (destructive: confirm), bulk_update_tasks, log_time, duplicate_task, import_csv, task_upsert_by_external_id, bam_add_task_parent, bam_remove_task_parent, bam_list_task_parents, bam_list_task_subtasks.
- Sprints (sprint-tools.ts): list_sprints, create_sprint, start_sprint, complete_sprint, get_sprint_report.
- Projects (project-tools.ts): list_projects, get_project, create_project, test_slack_webhook, disconnect_github_integration (destructive: confirm).
- Epics (epic-tools.ts): bam_create_epic, bam_update_epic, bam_get_epic.
- Members/users (member-tools.ts): list_members, get_my_tasks, bam_find_user_by_email, bam_find_user, bam_invite_member, bam_admin_reset_password, bam_send_password_reset_link.
- Reports (report-tools.ts): get_velocity_report, get_burndown, get_cumulative_flow, get_overdue_tasks, get_workload, get_status_distribution, get_cycle_time_report, get_time_tracking_report.
- Templates (template-tools.ts): list_templates, create_from_template.
- Comments (comment-tools.ts): list_comments, add_comment.
- Import (import-tools.ts): import_github_issues, suggest_branch_name, bam_import_csv.

Resolver/utility + shared/platform tools also in scope: bam_list_epics, bam_list_labels, bam_list_phases, bam_list_states, find_user_by_email, find_user_by_name, confirm_action (two-step destructive, Redis-backed tokens), identity/session (get_me, update_me, change_my_password, logout, list_my_orgs, switch_active_org), notification tools, and SuperUser-gated platform tools (get_platform_settings, set_public_signup_disabled, list_beta_signups, submit_beta_signup, get_public_config).

Destructive flow: delete_task and disconnect_github_integration use the confirm_action token dance (stage, token, execute). Idempotent write plane: task_upsert_by_external_id emits task.upserted with a created flag.

---

## 6. Project templates (phase/state seeds)

From apps/api/src/services/project.service.ts (lines ~36-93):

- kanban_standard: phases Backlog(start) / To Do / In Progress / Review / Done(terminal); states Not Started(todo) / In Progress(active) / Blocked(blocked) / In Review(review) / Done(done).
- scrum: phases Product Backlog(start) / Sprint Backlog / In Progress / In Review / Done(terminal); same five state categories.
- bug_tracking: phases Reported(start) / Triaged / In Progress / Fixed / Verified(terminal); states Open / Investigating / Blocked / Fix Applied / Closed.
- minimal: phases To Do(start) / In Progress / Done(terminal); states Not Started / In Progress / Done.
- none: no seed.

---

## 7. Screenshots available

In docs/apps/bam/screenshots/{light,dark}/ (1440x900), catalogued in docs/apps/bam/meta.json.

| File | Depicts | Illustrates |
|------|---------|-------------|
| light/01-board.png, dark/01-board.png | Kanban board | 3.2 board; stories 1, 3, 7 |
| light/02-sprint-board.png (and dark/02-sprint-board.png on disk) | Sprint board | 3.4 sprints; story 2 |
| light/03-task-detail.png, dark/03-task-detail.png | Task detail drawer | 3.3 task detail; story 3 |
| light/04-people.png, dark/04-people.png | People management | 3.21 people |
| light/05-settings.png, dark/05-settings.png | Project/app settings | 3.23 settings |

Note: meta.json declares a dark 02-sprint-board entry, but its dark array enumerates only IDs 01/03/04/05. A dark/02-sprint-board.png file IS present on disk (41 KB). guide.md references only the light sprint-board screenshot.

---

## 8. Discrepancies (docs/marketing vs. code)

1. MCP tool reference incomplete. docs/apps/bam/mcp-tools.md omits real registered tools: bam_create_epic, bam_update_epic, bam_get_epic, bam_invite_member, bam_admin_reset_password, bam_send_password_reset_link, bam_add_task_parent, bam_remove_task_parent, bam_list_task_parents, bam_list_task_subtasks, bam_import_csv, task_upsert_by_external_id. Treat code as source of truth.
2. Custom field types under-stated. Narrative/guide say text, number, select, date, multi-select. Code (custom-field.routes.ts line 31) also supports checkbox and url (7 types).
3. Priorities are per-org configurable, not a fixed enum (migration 0183 + /priorities). Canonical legacy set includes none (5 values). Create-task UI defaults to medium.
4. Multiple-views list. Marketing lists board/list/timeline/calendar. UI also ships Workload (view-switcher.tsx); saved-view view_type enum only persists board/list/timeline/calendar (Workload is not a persistable saved view).
5. Swimlanes. guide says assignee/priority/label. Code offers assignee/priority/epic (no label swimlane) - board.tsx 51-56.
6. Sprint cancel (POST /sprints/:id/cancel) is a real first-class action but is absent from guide.md (which narrates only create/start/complete).
7. Per-project calling settings UI was intentionally removed (board.tsx 648-654 comment) though project-calling-settings.routes.ts exists; calling is org/platform level. Do not document a per-project calling toggle in Bam.

---

## 9. Open questions

1. Done-gate scope: INCOMPLETE_SUBTASKS 409 fires on update/move into a closed state. Does it also gate complete_sprint, or only per-task transitions? Velocity sums is_closed tasks regardless.
2. WIP limits: wip_limit is stored on phases, but is it enforced (blocking moves) or display-only? No enforcement found in the routes read; check board-view.tsx / phase-column.tsx.
3. Watchers: field exists and notifications reference watchers, but no dedicated add/remove-watcher route surfaced. Confirm whether watcher mutation rides PATCH /tasks/:id or a separate endpoint.
4. Saved-view Workload: UI exposes it but the saved-view schema cannot persist it. Intended or gap?
5. Task links UI: TaskLinksSection + links schema exist; confirm the drawer round-trips title_source/fetch via PATCH /tasks/:id.
6. Priority none vs default medium: create dialog defaults to medium; verify seeded per-org priority rows include both none and medium for fresh orgs.
