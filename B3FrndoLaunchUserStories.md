# B3 Frndo Launch — Task Relationship User Stories

Ten user stories covering BAM task parent/child relationships, dependencies, and the new bidirectional many-to-many model from the Frndo Launch. Each story is audited across **API**, **Frontend**, and **MCP** layers, then marked confirmed or fixed.

Status legend:
- ✅ **Confirmed** — capability exists end-to-end, no fix needed.
- 🔧 **Fixed** — gap found, fix implemented and recorded in the notes.

---

## Story 1 — Break a parent task into subtasks

> As a project manager, I want to break a big task into smaller subtasks so my team can divide the work.

**Acceptance:** From the parent task's detail drawer I can add a subtask with a title in one keystroke; it shows up immediately in the parent's Subtasks list and gets created in the same project, phase, and sprint as the parent.

- **API:** `POST /projects/:id/tasks` accepts `parent_task_id`. The service writes the legacy self-FK and bumps the parent's `subtask_count`. Migration 0171's backfill ensures it's also visible via `task_parent_links` going forward.
- **Frontend:** Inline "Add a subtask…" input in `task-detail-drawer.tsx`, wired to `createSubtask`. The Subtasks list now refreshes via `useTaskSubtasks` query-invalidation in the mutation's `onSuccess`.
- **MCP:** `create_task` already supports `parent_task_id` (`apps/mcp-server/src/tools/task-tools.ts:311`).
- **Status:** ✅ **Confirmed.** Verified end-to-end during prior smoke test: created child via inline input, child appeared in parent's Subtasks list immediately.

## Story 2 — Share a subtask across multiple parents

> As a developer, I want a single foundational task (e.g. "set up CI") to appear as a subtask of multiple feature epics that all depend on it, so each epic's "ready to ship" view is correct.

**Acceptance:** I can attach an existing task as a subtask of more than one parent without duplicating it. Each parent's Subtasks list shows it, and finishing it once flips the gate on every parent simultaneously.

- **API:** `POST /tasks/:id/parents { parent_task_id }` writes to `task_parent_links` (many-to-many). `GET /tasks/:id/subtasks` unions legacy + join table.
- **Frontend:** Parent Tasks section on the drawer (`ParentTasksSection`) lets the user pick a task to attach. Adding X as a parent of Y makes Y appear under X's Subtasks too because the drawer's Subtasks block now reads through `useTaskSubtasks`.
- **MCP:** 🔧 **Fixed.** Added `bam_add_task_parent` in `apps/mcp-server/src/tools/task-tools.ts`. Idempotent; returns `{ already_linked: bool }`.
- **Status:** ✅ **Confirmed.** End-to-end via MCP: created task X and Y, called `bam_add_task_parent { task_id: Y, parent_task_id: X }`, then `bam_list_task_subtasks { task_id: X }` returned Y. Idempotent re-call returned `already_linked: true`.

## Story 3 — Mark parent Done only after all subtasks Done

> As a team lead, I want the system to block me from marking a parent as Done while any of its subtasks is still open, so the board never lies about progress.

**Acceptance:** Moving a parent task to a terminal phase while a subtask is still in a non-terminal phase returns a clear, structured error and the parent stays put.

- **API:** `assertSubtasksDoneBeforeTerminal` runs in both `moveTask` and `updateTask` paths and throws `IncompleteSubtasksError` → `409 INCOMPLETE_SUBTASKS` with `details[]` naming each open child by `human_id` and title.
- **Frontend:** Drag-to-Done from `board-view.tsx` / `swimlane-board.tsx` and explicit moves from the drawer surface the error via an `alert(err.message)`; the optimistic update reverts on settle so the card snaps back to its origin column.
- **MCP:** `move_task` and `update_task` go through the same routes, so the rejection bubbles up with the same code.
- **Status:** ✅ **Confirmed.** End-to-end smoke earlier: created parent + open child, tried `/tasks/:id/move` to Done → `409 INCOMPLETE_SUBTASKS` with the child named in details. Moved child first → parent move succeeded.

## Story 4 — See a task's parents

> As a developer, I want to see what depends on the task I'm working on so I know who's blocked while I'm in flight.

**Acceptance:** Opening any task's detail drawer shows a "Parent tasks" chip list with the task's human-id and title; chips are color-coded by whether each parent is Done.

- **API:** `GET /tasks/:id/parents` (B3 Frndo Launch). Unions legacy + join table.
- **Frontend:** `ParentTasksSection` in the drawer (`task-detail-drawer.tsx`). Chips are amber when parent is open, zinc when Done.
- **MCP:** 🔧 **Fixed.** Added `bam_list_task_parents`.
- **Status:** ✅ **Confirmed.** MCP smoke returned the expected parent chip data with human_id `BBB-5`, title, completion state, etc.

## Story 5 — See a task's subtasks

> As a project manager, I want to open a parent task and see every child, regardless of whether the child was attached via the inline "+ Add subtask" button or via the many-to-many parent picker on the child.

**Acceptance:** The Subtasks section reflects both the legacy `parent_task_id` self-FK AND the new `task_parent_links` join table.

- **API:** `GET /tasks/:id/subtasks` (B3 Frndo Launch) — unions legacy + join table.
- **Frontend:** 🔧 **Fixed earlier this session.** Drawer's Subtasks block now reads via `useTaskSubtasks` (apps/frontend/src/hooks/use-tasks.ts) instead of the never-populated embedded `task.subtasks` field. Cross-mutation invalidation makes the list refresh when add/remove parent, create subtask, or update task happens.
- **MCP:** 🔧 **Fixed.** Added `bam_list_task_subtasks`.
- **Status:** ✅ **Confirmed.** MCP smoke returned Y as a subtask of X after the many-to-many link was added — even though Y was never X's legacy `parent_task_id`. The UI fix is the one that unblocked the user-reported bug in this thread.

## Story 6 — Detach a subtask from a parent

> As an admin, I want to remove a subtask relationship if the work turns out to be irrelevant to that parent, without deleting the subtask itself or the parent.

**Acceptance:** I can remove a parent/child link in one click from either side. The counters (`subtask_count` / `subtask_done_count`) on the affected parent stay accurate.

- **API:** `DELETE /tasks/:id/parents/:parentId`. Decrements `subtask_count` (and `subtask_done_count` if the subtask was already Done). Drops the legacy `parent_task_id` if it matched the link being removed.
- **Frontend:** "×" button on each parent chip in `ParentTasksSection`.
- **MCP:** 🔧 **Fixed.** Added `bam_remove_task_parent`.
- **Status:** ✅ **Confirmed.** Earlier API smoke removed PARENT2 from CHILD: `{ "removed": true }`, then the parent list showed only the surviving parent.

## Story 7 — Prevent circular dependencies

> As a user, I want the system to refuse to create a cycle (A → B → A) so the Done-gate never deadlocks.

**Acceptance:** Attempts to add a parent that would close a cycle return a structured error; the link is not written.

- **API:** Bounded-DFS walk (depth 16) before insert. Throws `TaskRelationCycleError` → `409 CYCLE`. Separate `TaskRelationSelfLoopError` → `400 SELF_LOOP` for A → A. DB also has a `CHECK (task_id <> parent_task_id)` constraint as belt-and-suspenders.
- **Frontend:** `ParentTasksSection` catches the error and renders the message inline in the picker (`pickerError`).
- **MCP:** Cycle/self-loop errors flow through `bam_add_task_parent` with the same codes.
- **Status:** ✅ **Confirmed.** MCP smoke: `bam_add_task_parent { task_id: X, parent_task_id: Y }` (after Y was already X's child) → `isError: true`, body `{"code":"CYCLE","message":"This would create a cycle between tasks"}`.

## Story 8 — Add an existing task as a subtask via search

> As a team lead, I want to attach an existing task as a subtask of another by searching by title or human-id (e.g. "BBB-42"), not just create new subtasks via the inline input.

**Acceptance:** The parent picker exposes a search field that filters the project's tasks, and clicking one attaches the relationship.

- **API:** `GET /projects/:id/tasks?search=…` (existing list endpoint with ILIKE).
- **Frontend:** Inline picker in `ParentTasksSection`. The picker fetches via `GET /projects/:id/tasks?search=…&limit=20` and excludes self + already-attached parents.
- **MCP:** Covered by existing `search_tasks` tool plus the new `bam_add_task_parent`.
- **Status:** ✅ **Confirmed.** API picker is the same `/projects/:id/tasks?search=…` already used by the board; verified during drawer testing.

## Story 9 — See subtask progress at a glance on the board

> As a team lead, I want the kanban card to show how many of a task's subtasks are done so I can spot stalled work without opening the drawer.

**Acceptance:** Each card shows a progress bar / X-of-Y badge driven by `subtask_count` and `subtask_done_count`. Both counters stay accurate across legacy and many-to-many relationship changes.

- **API:** Counters maintained in `createTask` (bumps parent on creation, `apps/api/src/services/task.service.ts`), `deleteTask` (decrements), `addTaskParent` (bumps when the link is genuinely new and not already accounted for by the legacy primary parent), and `removeTaskParent` (decrements with `greatest(... - 1, 0)` to clamp).
- **Frontend:** Existing progress bar block in `task-card.tsx` lines 126–134.
- **MCP:** Counters surface unchanged on `get_task` / `search_tasks` responses.
- **Status:** ✅ **Confirmed.** Counter logic was verified during the B3 Frndo Launch subtask commit and exercised by 488/488 api tests including `task.test.ts`.

## Story 10 — Agent-driven subtask orchestration via MCP

> As an automation agent (e.g. a Bolt rule or a slash-bot in Banter), I want to attach and detach parent/child relationships and read them back through MCP, so my workflow can decompose work without going through the web UI.

**Acceptance:** MCP exposes first-class tools for `add_parent`, `remove_parent`, `list_parents`, `list_subtasks`. They go through the same authorization gates as the HTTP routes and surface the same structured errors (`CYCLE`, `SELF_LOOP`, `INCOMPLETE_SUBTASKS`).

- **API:** Endpoints already in place (Stories 2 and 6).
- **Frontend:** n/a (agent surface).
- **MCP:** 🔧 **Fixed.** Added `bam_add_task_parent`, `bam_remove_task_parent`, `bam_list_task_parents`, `bam_list_task_subtasks`. Each is a thin pass-through over the HTTP route; the API layer owns auth, cycle detection, idempotency, and counter maintenance.
- **Status:** ✅ **Confirmed.** Full MCP handshake → `tools/list` shows all four tools; `tools/call` end-to-end works (verified add, list-parents, list-subtasks, idempotent re-add, cycle rejection).

---

## Adjacent coverage: MCP for the rest of B3 Frndo Launch

The user stories above focus on task relationships, but the launch also added admin flows that should be reachable from MCP for parity with the web UI:

### MCP tools added in this audit pass

| Tool | Wraps | Status |
|---|---|---|
| `bam_invite_member` | `POST /org/members/invite` | 🔧 **Fixed / ✅ Confirmed** — accepts `project_ids`, returns `email_sent` + `projects_added` / `projects_skipped`. |
| `bam_admin_reset_password` | `POST /org/members/:userId/reset-password` | 🔧 **Fixed / ✅ Confirmed** — returns the freshly minted password once. |
| `bam_send_password_reset_link` | `POST /org/members/:userId/send-password-reset` | 🔧 **Fixed / ✅ Confirmed** — mints the token + emails the link; returns `email_sent` + `smtp_configured`. Smoke return: `{"user_id":"…","email":"frndo-test@example.com","email_sent":false,"smtp_configured":false,"expires_in_minutes":60,…}` (correct behavior — SMTP is unconfigured on this stack so `email_sent: false`). |
| `set_helpdesk_signup_disabled` | `PATCH /superuser/platform-settings` with new field | 🔧 **Fixed / ✅ Confirmed** — independently toggles the helpdesk signup gate. Smoke: flipped to true then back to false; both calls returned `{"public_signup_disabled":false,"helpdesk_signup_disabled":<expected>}`. |

### MCP tools extended in this audit pass

| Tool | Change | Status |
|---|---|---|
| `get_platform_settings` | Return shape now declares both `public_signup_disabled` and `helpdesk_signup_disabled`. | ✅ **Confirmed** — passes through whatever `/superuser/platform-settings` returns. |
| `set_public_signup_disabled` | Returns both flags after the patch, and the description now notes the deliberate decoupling from helpdesk signup. | ✅ **Confirmed.** |

### Tool-count assertion

`apps/mcp-server/test/integration.test.ts` enumerates every expected tool name. Updated to add the 8 new entries (4 task-relationship + 3 admin + 1 platform). All 286 mcp-server unit tests pass after the update.

---

## Final verification

- **Typecheck:** mcp-server typechecks clean.
- **Tests:** 286/286 mcp-server tests pass; 488/488 api; 94/94 shared; 119/119 frontend.
- **Live smoke:** every new MCP tool exercised via Streamable HTTP transport against the running stack, with the expected success and error responses (idempotent add, cycle, list parents, list subtasks, helpdesk toggle, send-reset-link).
