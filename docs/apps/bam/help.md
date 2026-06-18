# Bam - Sprint-based Kanban project and task management

> Bam is the BigBlueBam flagship: a multi-user Kanban planner where teams run
> projects on configurable boards, plan and close sprints, track tasks with rich
> detail, and report on delivery. Reach for it when a team needs to organize work
> into phases and time-boxed iterations.

## Overview

Bam is where work gets planned and tracked. Each project is a board with its own
phases (columns), task states, labels, epics, sprints, custom fields, and
templates. You move tasks across the board by dragging cards, group them into
time-boxed sprints, and carry unfinished work forward when a sprint closes. Cards
carry a full task record: assignee, priority, story points, start and due dates,
subtasks, comments, attachments, time entries, and custom fields.

Bam is built for small-to-medium teams. It supports many concurrent projects, and
every project can be shaped differently because phases, states, and custom fields
are all configurable per project (and priorities per org). The same data is
reachable through MCP tools, so an AI agent can create tasks, run reports, or plan
a sprint with nearly the same authority a human has in the UI.

Bam connects to the rest of the suite. Helpdesk tickets can spawn Bam tasks (a
Helpdesk tab then appears on the task), GitHub commits and pull requests can link
back to a task, Slack receives sprint and task notifications, and Banter messages
can reference a task by its human id so a deep link opens the right board with the
task drawer open.

The core objects you work with are projects, phases, task states, tasks, sprints,
epics, labels, custom fields, and saved views.

### Key concepts

- **Organization (org)** - The top-level tenant. Org roles are owner, admin, and
  member, plus a guest role. Priorities are configured at the org level.
- **Project** - A board with its own phases, states, labels, epics, sprints,
  custom fields, and templates. Every project has a task id prefix (2 to 6
  uppercase letters, for example MAGE or FRND) that prefixes every task id.
  Project roles are admin, member, and viewer.
- **Phase** - A board column. A phase can carry a WIP limit, a color, start and
  terminal flags, and an auto-state that is applied when a task enters the phase.
- **Task state** - The status of a task, orthogonal to its phase. Each state
  belongs to a category (todo, active, blocked, review, done, or cancelled) and
  may be a closed state. Tasks in a closed state count toward velocity.
- **Task** - The unit of work. Each task has a human id in the form PREFIX-N (for
  example MAGE-38). A task holds a title, rich-text description, phase, state,
  sprint, epic, assignee, reporter, priority, story points, time estimate and
  logged time, start and due dates, labels, custom fields, links, parents and
  subtasks, comments, and attachments.
- **Priority** - A per-org configurable value. The default set is Critical, High,
  Medium, Low, and None. New tasks default to Medium.
- **Sprint** - A time-boxed iteration with a status of planned, active, completed,
  or cancelled. Only one sprint can be active per project at a time. The default
  sprint length is 14 days. A sprint carries a goal, start and end dates, velocity,
  and retrospective notes.
- **Carry-forward** - When you complete an active sprint, each incomplete task can
  be carried forward to a target sprint, moved to the backlog, or cancelled.
  Carried tasks show a carry-forward badge and remember their original sprint for
  reporting.
- **Epic** - A grouping of tasks across sprints, with a status of open, in
  progress, or closed. Epics roll up task counts and story points.
- **Label** - A project-scoped tag with a name and color.
- **Custom field** - A project-scoped field stored on each task. The seven field
  types are text, number, date, select, multi-select, checkbox, and url. A field
  can be required and can be shown on the card.
- **Saved view** - A saved filter, sort, swimlane, and view-type preset. It can be
  private to you or shared with the project. Saved views persist the Board, List,
  Timeline, and Calendar view types.
- **Swimlane** - A horizontal grouping of the board. The options are No Swimlanes,
  By Assignee, By Priority, and By Epic.
- **Start and due dates** - Each task can carry a start date and a due date. These
  drive the Timeline (Gantt) and Calendar views and feed the overdue and My Work
  groupings.
- **Watcher** - A user subscribed to a task's notifications. Watchers are populated
  by the system as people get involved with a task. There is no manual
  add-watcher or remove-watcher control in the Bam UI.
- **Done-gate** - A task cannot move into a closed state while it still has open
  subtasks. The board surfaces this as an alert and the API returns an
  INCOMPLETE_SUBTASKS error.

### Where to find it

Bam is served at `/b3/`. From the left sidebar you reach **Dashboard** (the
project list), **My Work** (your personal task queue), and the **Projects** list
with a plus button to create a project. Opening a project lands you on its board
at `/projects/:id/board`.

To use Bam you need an authenticated session (a login cookie or a `bbam_` API key)
and membership in at least one project. Some actions require a project admin role
or an org owner or admin role. On a brand-new install, Bam routes you to
`/b3/bootstrap` to create the first account until a SuperUser exists.

![Kanban board](screenshots/light/01-board.png)

## Feature reference

### Project dashboard and project list

The dashboard is your home page in Bam. It lists every project you can see.

To create a project:

1. From the sidebar, click **Dashboard**, or click the plus button next to
   **Projects**.
2. Click **New Project** (the empty state reads **No projects yet** with a
   **Create Project** button).
3. Enter a project **name** and a **task id prefix** of 2 to 6 uppercase letters.
4. Optionally set a description, icon, color, project template, and default sprint
   duration.
5. Submit. You land on the new project's board with its phases and states seeded
   from the template you chose.

To open a project, click its card on the dashboard or its entry in the sidebar.
Project changes require an admin role; deleting (archiving) a project requires
admin plus the relevant org permission.

### Kanban board

The board is the primary view. Phases are columns and tasks are cards you drag
between them.

The board header carries the sprint selector, a filter bar, the swimlane selector
(**No Swimlanes**, **By Assignee**, **By Priority**, **By Epic**), a lane-sort
control (used with the epic swimlane), the view switcher (Board, List, Timeline,
Calendar, Workload), and action icons for the dashboard, **Import tasks**, **Task
templates**, **Saved views**, **Manage epics**, and a **Project options**
three-dot menu.

To add a task to a column, use the column's add control to open the create dialog,
or type into the inline add input under a column.

To move a task, drag its card to another column or to a new position. The board
persists the new position immediately. If you drag a task with open subtasks into a
closed state, the move is blocked and you see an alert.

To act on a single card, right-click it. The context menu offers **Open detail**,
**Add subtask...**, **Duplicate**, **Priority** (Critical, High, Medium, Low,
None), **Move to phase**, **Set state**, **Assign to...** (Unassigned plus org
members), **Change parent task** (searchable), and **Delete task** (which warns
that deletion is irreversible).

The **Project options** menu holds **Manage Phases**, **Custom Fields**,
**Export**, and **Delete Project**.

### Task detail drawer

Opening a task slides in a detail drawer with everything about that task.

To open a task, click its card or choose **Open detail** from the card's context
menu. The drawer header shows the task's human id (click it to copy), a state
selector, and a priority selector, plus controls to **Share to Banter**,
**Duplicate task**, and close.

The drawer body has tabs: **Details**, **Comments**, **Activity**, and a
**Helpdesk** tab that appears only when the task was created from a Helpdesk
ticket. On the **Details** tab you can edit the title and rich-text description,
manage parent tasks and subtasks, add labels, upload attachments, and add task
links. The right sidebar holds **Assignee**, **Reporter**, **Sprint**, **Phase**,
**Epic**, **Story Points**, **Time Logged**, **Start Date**, **Due Date**,
**Labels**, and **Custom Fields**, and a **Delete Task** action at the bottom.

The **Assignee** picker lists all members of the org, not just members of the
current project, so you can assign work to anyone in the org. To edit any field,
change its control in the sidebar; the drawer saves the change as you go. The
description auto-saves shortly after you stop typing.

A task's watchers are maintained automatically as people get involved (for
example, being assigned or commenting). There is no watcher list or
add-watcher control in the drawer.

![Task detail](screenshots/light/02-task-detail.png)

### Creating and editing tasks

To create a task from the create dialog:

1. Trigger the dialog from a column's add control or press the **N** shortcut.
2. Fill in **Title** (placeholder "What needs to be done?"), and optionally
   **Phase**, **Priority**, **Story Points**, **Assignee**, **Due Date**,
   **Labels**, and a description. The **Assignee** picker lists every org member.
3. Click **Create Task**.

To edit a task, open its drawer and change fields inline, or use the card context
menu for quick priority, phase, state, and assignee changes.

To duplicate a task, use **Duplicate task** in the drawer header or **Duplicate**
in the card context menu. You can include subtasks when duplicating.

Bam blocks moving or updating a task into a closed state while it has open
subtasks. Parent-child links are guarded against self-parenting and cycles.

### Subtasks and parent tasks

A task can have multiple parents and multiple subtasks.

To add a subtask, open the task, and on the **Details** tab type a title into the
**Add a subtask...** input and confirm. The subtask progress bar tracks how many
subtasks are done.

To mark a subtask done, click its checkbox. Click the row body to open the subtask
in the drawer.

To add a parent, in the **Parent tasks** section click **+ Add a parent task** (or
**+ Add another parent**), search by title or id, and pick a task. Remove a parent
with the X on its chip.

### Sprints

Sprints are time-boxed iterations you run from the board's sprint selector.

To create a sprint, open the sprint selector and choose **Create sprint**, then set
a name (placeholder "Sprint 1"), start and end dates, and an optional goal.

To start a sprint, select it and choose **Start this sprint**. Only one sprint can
be active per project, so starting a sprint while another is active is rejected.
Starting a sprint sends a Slack notification and fires a sprint-started event.

To complete a sprint, choose **Complete Sprint**. The complete dialog is titled
**Complete Sprint: NAME** and lists every incomplete task with a per-task dropdown:
**Carry forward**, **Move to backlog**, or **Cancel task**. Add optional
**Retrospective Notes (optional)** and click **Complete Sprint**. Velocity is
computed from closed tasks.

To delete a planned sprint, choose **Delete this sprint** from the selector. To
cancel an active or planned sprint, the Cancel action moves its tasks back to the
backlog and sets the sprint status to cancelled.

To review a finished sprint, choose **View sprint report**.

![Sprint planning](screenshots/light/03-sprint-create.png)

### Carry-forward

When you complete a sprint, carry-forward decides what happens to unfinished work.

In the **Complete Sprint** dialog, set each incomplete task's dropdown:

- **Carry forward** moves the task to the target sprint, increments its
  carry-forward count, and stamps its original sprint.
- **Move to backlog** removes the task from the sprint (descoped).
- **Cancel task** leaves the task in the completed sprint.

Carried-forward cards show a carry-forward badge on the board, and the original
sprint is preserved so reports stay accurate.

### Epics

Epics group tasks across sprints.

To manage epics, click **Manage epics** in the board header to open the epic
manager, then create an epic with a name, description, color, and optional start
and target dates.

To assign a task to an epic, open the task and set its **Epic** in the drawer
sidebar.

To view epic progress, open an epic's detail page (click its chip) for a
group-by-sprint task list and a burnup chart, with rollups of task and story-point
counts.

### Phases (columns)

Phases are the board's columns and define your workflow.

To manage phases, open the **Project options** menu and choose **Manage Phases**.
From the phase manager you can add, edit, reorder, and delete phases, and set a
WIP limit, color, start and terminal flags, and an auto-state applied on entry.
When you delete a phase you can re-home its tasks to another phase.

### Task states

Task states are the per-project status values, seeded from the project template.
Each state has a category (todo, active, blocked, review, done, or cancelled) and a
closed flag. You set a task's state from the drawer header, the card context menu's
**Set state**, or by dragging into a phase with an auto-state.

### Labels

Labels are project-scoped tags.

To add a label to a task, open the create dialog or the task drawer and pick from
the project's labels. Labels are managed per project and are also visible
org-wide to the cross-app resolver.

### Custom fields

Custom fields add project-specific data to every task.

To manage custom fields, open the **Project options** menu and choose **Custom
Fields**. Create a field of one of the seven types: text, number, date, select,
multi-select, checkbox, or url. A field can be marked required and can be shown on
the card. Custom-field values appear in the **Custom Fields** section of the task
drawer sidebar.

### Saved views

Saved views remember a filter, sort, swimlane, and view-type combination.

To save a view, set your filters, swimlane, and view, then click **Saved views**
in the board header and save the current configuration. A saved view can be
private to you or shared with the project; only the owner can edit or delete it.
Saved views persist the Board, List, Timeline, and Calendar view types. Workload is
a view mode you can switch to, but it is not a persistable saved-view type.

### Alternate views (List, Timeline, Calendar, Workload)

The view switcher in the board header toggles between five views: **Board**,
**List**, **Timeline**, **Calendar**, and **Workload**.

To change view, click the matching icon in the view switcher.

- **List** is a flat, sortable table of the project's tasks.
- **Timeline** lays tasks out by date as a Gantt chart, using each task's start and
  due dates.
- **Calendar** places tasks on their due dates.
- **Workload** shows load per user; clicking a user there filters the board to that
  user.

![List view](screenshots/light/04-list-view.png)

### Task templates

Templates are reusable task blueprints.

To manage templates, click **Task templates** in the board header. A template can
carry a name, title pattern, description, priority, labels, phase, story points,
and a list of subtask titles.

To create a task from a template, apply the template; Bam creates the task and its
subtasks, and you can override fields at apply time.

### Import

Import brings an existing backlog into a project.

To import, click **Import tasks** in the board header to open the import dialog.
You can import from CSV, Trello, Jira, or GitHub Issues. For CSV you map columns,
preview a dry run before committing, and configure value maps, link mappings,
custom-field mapping, a duplicate strategy (create, skip, or update), and a date
locale (us or iso). Unmatched phases and labels are created automatically.

### Export

Export downloads a project's tasks.

To export, open the **Project options** menu and choose **Export**. Pick a
**Format** of JSON or CSV, optionally scope to a specific sprint (or All sprints),
and click **Export**. Export is rate-limited.

### iCal feed

Bam can publish tasks with due dates as a calendar feed.

To subscribe, generate a calendar token for the project (or use your personal
feed), then add the feed URL to an external calendar app. Project feeds are served
at `/projects/:id/calendar.ics` and your personal feed at `/me/calendar.ics`, each
authenticated by a token in the query string. You can create and revoke calendar
tokens per project.

### Comments, reactions, and revisions

Discuss work directly on the task.

To comment, open a task, go to the **Comments** tab, write in the editor, and
click **Comment**. To react, click a reaction on a comment; the five reactions are
thumbs-up, heart, rocket, eyes, and party. You can edit and delete your own
comments. Editing snapshots the previous version, and an "(edited)" badge opens the
full revision history.

### Time tracking

Log time against a task as separate entries.

To log time, open a task and in the **Time Logged** section of the sidebar click
**Log Time**, enter minutes, a date, and an optional description, then save. Each
entry is its own row and the total rolls up into the task's logged time. Your
personal time entries are also available across a date range.

### Attachments

Attach files to a task.

To add an attachment, open a task and in the **Attachments** section click
**Upload File** and choose a file. Each attachment shows its size and date with
download and delete controls.

### Task links

Attach external URLs to a task.

To add a link, open a task and use the **Links** section on the **Details** tab to
add an http(s) URL with a title. A task can hold up to 50 links.

### Reports and project dashboard

Bam reports on delivery at the project level.

To view reports, open a project's dashboard at `/projects/:id/dashboard` or its
reports at `/projects/:id/reports`. Available reports include velocity, burndown,
cumulative flow, cycle time (average and median lead time), overdue tasks,
workload, time tracking over a date range, and status distribution. Burndown can
target a specific sprint or the active sprint.

### Audit log

Every project keeps an append-only activity record.

To view it, open the project audit log at `/projects/:id/audit-log`. Entries are
written to the append-only, monthly-partitioned activity log.

### People and members

Manage the people in your org and projects.

To manage people, open **/people** (org admins and owners) for the people list and
each person's detail page at **/people/:userId**. The detail page has tabs
**Overview**, **Projects**, **Access**, and **Activity**. From **Overview** you
edit identity (display name, timezone) and membership (role, default org). From
**Projects** you add the user to projects with a role. From **Access** you manage
API keys, sessions, and password resets. Platform SuperUsers use
**/superuser/people**.

To add a member to a project, use the project's member controls (project admin
only) or add the user to projects from their **Projects** tab. Note that
assignment is not gated on project membership: the task **Assignee** picker lists
every org member, so you can assign a task to someone who is not yet a project
member.

### My Work

My Work is your personal queue across every project. It lists only the tasks
assigned to you (it queries each project's task list filtered to your user id), so
it never shows another person's work.

To open it, click **My Work** in the sidebar. The page groups your open tasks into
**Overdue**, **Due This Week**, **In Progress**, and **All My Tasks**. Tasks land
in **Overdue** or **Due This Week** based on their due date, in **In Progress** if
they have a start date, and in **All My Tasks** otherwise. Completed tasks are
hidden, and when nothing is assigned you see "All caught up!".

![My Work](screenshots/light/05-my-work.png)

### Settings

Settings control your profile and the org's configuration.

To open settings, go to **/settings**. The ten tabs are **Profile**, **Appearance**
(System, Light, Dark), **Notifications**, **Members**, **Tasks** (which includes
**Manage Priorities**), **Permissions**, **Launchpad**, **Integrations** (API
keys, agents and service accounts, webhooks, Slack, and the per-org SMTP
override), **AI Providers**, and **Helpdesk**. Use the **Tasks** tab's **Manage
Priorities** to configure the org's priority set. The per-org email relay lives
on the **Integrations** tab; the platform-wide relay it falls back to is set in
the SuperUser Console (see **Email delivery (SMTP)** below).

![Integrations and API keys](screenshots/light/06-settings-integrations.png)

### Email delivery (SMTP)

BigBlueBam sends outbound mail (org invitations, password resets, system and
reporting alerts, and Blast campaigns) through an SMTP relay. There are two
levels of configuration, and the system always picks the most specific one that
is set.

The resolution order is: the **org override** first, then the **platform
relay**, then the server's **environment default**. In plain terms: if your
organization has set its own relay, your org's mail goes through it; if it has
not, your org's mail falls back to the platform relay a SuperUser configured;
and if neither is set, the system uses the SMTP values baked into the server's
environment variables. This used to live under **Account Settings >
Integrations**; the platform relay has since moved to the SuperUser Console, and
the per-org override now sits in its own card on the **Integrations** tab.

**Platform email (SMTP).** The platform relay is the system-wide, fallback
sender. It is what the platform uses for new-org-setup invitations, the
password-reset fallback, and system and reporting alerts, and it is the relay
any organization falls back to when it has not configured its own. Only a
platform SuperUser can set it.

To configure the platform relay, open the **SuperUser Console** at
**/superuser**, click the **Platform** tab, and scroll to the **Platform SMTP
relay** card. Fill in **SMTP Host**, **SMTP Port** (587 for STARTTLS, 465 for
TLS-only), **SMTP Username**, **SMTP Password**, and **From Address**, set **Use
TLS (secure)** for port 465, and save. Any field you leave blank falls back to
the matching server environment variable (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, `EMAIL_FROM`). Use **Test connection** to verify login and TLS, or
enter an address and click **Send test email** to confirm end-to-end delivery.
Changes take effect within 30 seconds.

_(The Platform SMTP relay card is in the SuperUser Console and only renders for a platform SuperUser, so its screenshot is captured in a separate SuperUser pass.)_

**Organization email (SMTP).** An org admin or owner can give their organization
its own relay, which overrides the platform relay for that org's outbound mail
(Blast campaigns and member or guest invitations). Leaving it blank keeps the
org on the platform relay.

To configure the org override, open **/settings**, select the **Integrations**
tab, and scroll to the **Organization Email (SMTP)** card. Fill in the same
fields and save; the card confirms whether the org is using its own relay or
falling back to the platform relay. The relay password is masked on read, so
leaving the dots in place keeps the stored password unchanged. **Test relay**
checks whichever relay will actually send (your org override if set, otherwise
the platform fallback). To stop using the org relay, click **Use platform
relay**, which clears the override. Changes take effect within 30 seconds.

![Organization email (SMTP)](screenshots/light/08-org-smtp.png)

### Command palette and keyboard shortcuts

Bam has power-user navigation built in.

Press **Ctrl/Cmd+K** to open the command palette. Other shortcuts: **N** creates a
task, **S** or **/** focuses search, **F** toggles the filter, **Esc** closes the
current overlay, and **?** opens the **Keyboard Shortcuts** overlay and Help.

### Notifications

Bam delivers in-app notifications.

To review notifications, open your notifications list; you can mark a single
notification read, or mark all read.

### Cross-app integrations

Bam connects to other apps in the suite:

- **Helpdesk** - Tasks created from a Helpdesk ticket show a **Helpdesk** tab in
  the drawer linked to the source ticket.
- **GitHub** - Commits and pull requests can link to a task and appear in the
  drawer's linked section.
- **Slack** - Starting and completing a sprint, and task events, can post to
  Slack.
- **Banter** - Use **Share to Banter** from the task drawer to post a task into a
  channel. Banter messages that reference a task's human id deep-link back into
  Bam.
- **Bolt** - Task, sprint, epic, and comment changes emit events to Bolt.
- **Launchpad** - Cross-app navigation links Bam to the rest of the suite.

### Working with AI agents

Agents drive Bam through its MCP tools, which accept natural identifiers (project,
phase, sprint, and label names, a user's email, or a human id like FRND-42) as
well as UUIDs. The catalog spans nine Bam tool files and lets an agent do nearly
everything a human can on the board:

- **Tasks** - `search_tasks`, `get_task`, `bam_get_task_by_human_id`,
  `create_task`, `update_task`, `move_task`, `delete_task`, `bulk_update_tasks`,
  `log_time`, `duplicate_task`, `import_csv`, `task_upsert_by_external_id`,
  `bam_add_task_parent`, `bam_remove_task_parent`, `bam_list_task_parents`,
  `bam_list_task_subtasks`.
- **Sprints** - `list_sprints`, `create_sprint`, `start_sprint`,
  `complete_sprint`, `get_sprint_report`.
- **Projects** - `list_projects`, `get_project`, `create_project`,
  `test_slack_webhook`, `disconnect_github_integration`.
- **Epics** - `bam_create_epic`, `bam_update_epic`, `bam_get_epic`,
  `bam_list_epics`.
- **Members and users** - `list_members`, `get_my_tasks`,
  `bam_find_user_by_email`, `bam_find_user`, `bam_invite_member`,
  `bam_admin_reset_password`, `bam_send_password_reset_link`.
- **Reports** - `get_velocity_report`, `get_burndown`, `get_cumulative_flow`,
  `get_overdue_tasks`, `get_workload`, `get_status_distribution`,
  `get_cycle_time_report`, `get_time_tracking_report`.
- **Templates** - `list_templates`, `create_from_template`.
- **Comments** - `list_comments`, `add_comment`.
- **Import** - `import_github_issues`, `suggest_branch_name`, `bam_import_csv`.

Resolver helpers (`bam_list_labels`, `bam_list_phases`, `bam_list_states`) and
identity tools (`get_me`, `update_me`, `list_my_orgs`, `switch_active_org`) round
out the Bam-specific catalog.

On top of the Bam tools, agents reach Bam through the cross-cutting agentic
platform that every app shares:

- **Identity, audit, heartbeat** - An agent identifies itself and reports liveness
  with `agent_heartbeat`, reviews its own recent actions with `agent_audit`, and
  describes its capabilities with `agent_self_report`. Every write an agent makes
  is recorded with an `agent` actor type in the activity log.
- **Approval queues** - For work that needs a human sign-off, an agent files a
  proposal with `proposal_create`, a human or another agent lists pending items
  with `proposal_list`, and a decision is recorded with `proposal_decide`.
- **Cross-app read plane** - `search_everything` fans a query out across apps
  (Bam tasks included) with normalized scoring, `resolve_references` turns mentions
  like FRND-42 into resolved entities, and `activity_query` reads the unified
  cross-app activity view. Composite views `project_view` and `account_view`
  assemble a rounded picture of a project or account spanning multiple apps.
- **Idempotent upserts** - `task_upsert_by_external_id` keys on the project plus an
  external id and emits a `task.upserted` event with a `created` flag, so an agent
  can sync tasks from an external system without creating duplicates.
- **Visibility preflight** - Before an agent posts a Bam task into a shared
  surface, it calls `can_access(asker_user_id, entity_type, entity_id)` and drops
  anything the asker is not allowed to see.
- **Agent policies and webhooks** - A per-agent kill switch and tool allowlist
  (`bam.*`, `task.*`, and so on) gate every service-account call, and subscribed
  Bolt events are pushed to agent runners via signed outbound webhooks.

Destructive tools require human review. `delete_task` and
`disconnect_github_integration` use the two-step `confirm_action` token flow: the
tool stages the action and returns a time-limited token, and a second call confirms
it. When reviewing agent work, watch the project audit log and the task **Activity**
tab; both record the agent actor. See `docs/apps/bam/mcp-tools.md` for the full
tool catalog.

## User Stories

### Story: Spin up a project from a template

**Who:** A team lead or org admin starting a new effort.
**Goal:** Create a project that arrives with phases and states already set up.
**Before you start:** A session with permission to create projects.

**Steps**

1. In the sidebar, click **Dashboard**, or click the plus next to **Projects**.
2. Click **New Project** (or **Create Project** in the empty state).
3. Enter a project **name** and a **task id prefix** of 2 to 6 uppercase letters.
4. Choose a project template (for example kanban_standard, scrum, bug_tracking, or
   minimal) and submit.

**Result:** You land on the new project's board. Its phases and task states are
seeded from the template (for example kanban_standard gives Backlog, To Do, In
Progress, Review, Done).

**Related:** Manage Phases and Custom Fields to shape the board further. Agents use
`create_project`.

### Story: Create and work a task end to end

**Who:** A team member doing the day-to-day work.
**Goal:** Take a task from creation to done with full detail along the way.
**Before you start:** Membership in a project.

**Steps**

1. Press **N** or use a column's add control to open the create dialog.
2. Fill in **Title**, then optionally **Phase**, **Priority**, **Story Points**,
   **Assignee** (any org member), **Due Date**, and **Labels**, and click **Create
   Task**.
3. Drag the card across phases as work progresses.
4. Open the task, log time in **Time Logged** with **Log Time**, write a note on
   the **Comments** tab, react to a teammate's comment, and upload a file under
   **Attachments**.
5. When finished, set a closed state. If the task still has open subtasks, the
   move is blocked until you finish them.

**Result:** The task moves to a closed state and counts toward sprint velocity, with
its time, discussion, and files attached.

**Related:** Subtasks, the done-gate, and `create_task` / `update_task` /
`log_time` for agents.

### Story: Track your personal load

**Who:** Anyone with assigned tasks.
**Goal:** See what you owe and what is overdue across all projects.
**Before you start:** Tasks assigned to you.

**Steps**

1. Click **My Work** in the sidebar.
2. Scan the **Overdue**, **Due This Week**, **In Progress**, and **All My Tasks**
   groups. Only tasks assigned to you appear here.
3. Click any task to jump to its project board and act on it.

**Result:** You have a single, cross-project view of your own work, with completed
tasks hidden.

**Related:** Agents use `get_my_tasks`.

### Story: Plan and run a sprint

**Who:** A team lead running iterations.
**Goal:** Plan a sprint, work it, and close it cleanly.
**Before you start:** A project with tasks; no other active sprint.

**Steps**

1. In the board's sprint selector, choose **Create sprint** and set a name, start
   and end dates, and an optional goal.
2. Add tasks to the sprint (set each task's **Sprint** in its drawer, or filter to
   the sprint).
3. Choose **Start this sprint** to make it active.
4. Work the board through the sprint.
5. Choose **Complete Sprint**, decide each leftover task's fate, add
   **Retrospective Notes (optional)**, and click **Complete Sprint**.
6. Review velocity with **View sprint report**.

**Result:** The sprint is completed, leftover tasks are routed, and velocity is
recorded.

**Related:** Carry-forward; `create_sprint`, `start_sprint`, `complete_sprint`,
`get_sprint_report`.

### Story: Carry forward unfinished work

**Who:** A team lead closing a sprint with leftover tasks.
**Goal:** Move unfinished tasks to the next sprint without losing history.
**Before you start:** An active sprint with incomplete tasks.

**Steps**

1. Choose **Complete Sprint** on the active sprint.
2. For each incomplete task, set the dropdown to **Carry forward**.
3. Pick the target sprint and click **Complete Sprint**.

**Result:** The carried tasks move to the target sprint with a carry-forward badge,
and each task's original sprint is preserved for reporting.

**Related:** The Plan and run a sprint story; `complete_sprint`.

### Story: Group work under an epic

**Who:** A planner organizing a larger initiative.
**Goal:** Track related tasks across sprints under one epic.
**Before you start:** A project with tasks.

**Steps**

1. Click **Manage epics** in the board header and create an epic with a name and
   color.
2. Open each task and set its **Epic** in the drawer sidebar.
3. Open the epic's detail page to see its tasks grouped by sprint and a burnup
   chart.

**Result:** Tasks are grouped under the epic, and the epic page shows progress
rollups.

**Related:** Agents use `bam_create_epic`, `bam_update_epic`, `bam_get_epic`.

### Story: Customize the board

**Who:** A project admin tailoring the workflow.
**Goal:** Shape phases, fields, and labels to fit how the team works.
**Before you start:** Project admin role.

**Steps**

1. Open **Project options** and choose **Manage Phases** to add, reorder, and
   configure phases (WIP limits, colors, auto-state on entry).
2. Open **Project options** and choose **Custom Fields** to add a field (for
   example a select or url field) and mark it shown on the card.
3. Add and color the labels the team needs.

**Result:** The board reflects the team's workflow, with the right columns, fields,
and labels.

**Related:** Phases, Custom fields, Labels.

### Story: Slice the board with views

**Who:** Anyone who wants a focused cut of the board.
**Goal:** Filter and group the board, then save the cut for reuse.
**Before you start:** A project with tasks.

**Steps**

1. In the view switcher, pick **Board**, **List**, **Timeline**, **Calendar**, or
   **Workload**.
2. Apply swimlanes (**By Assignee**, **By Priority**, or **By Epic**) and set
   filters.
3. Click **Saved views** and save the configuration, optionally sharing it with
   the project.

**Result:** Your filtered, grouped view is saved and reusable. (Workload is a view
mode you can switch to but cannot save as a view type.)

**Related:** Saved views, Alternate views. Tasks need start and due dates for the
Timeline and Calendar views to place them.

### Story: Import an existing backlog

**Who:** Someone migrating work into Bam.
**Goal:** Bring tasks from a CSV or another tool into a project.
**Before you start:** Project membership and a source file or connected tool.

**Steps**

1. Click **Import tasks** in the board header.
2. Choose CSV, Trello, Jira, or GitHub Issues.
3. For CSV, map columns, set value, link, and custom-field maps, choose a duplicate
   strategy (create, skip, or update), and run the preview.
4. Confirm the import.

**Result:** Tasks land in the project, with unmatched phases and labels created
automatically.

**Related:** Agents use `import_csv` / `bam_import_csv` / `import_github_issues`.

### Story: Report on delivery

**Who:** A lead or stakeholder checking progress.
**Goal:** Read the delivery metrics for a project.
**Before you start:** A project with sprint and task history.

**Steps**

1. Open the project dashboard at `/projects/:id/dashboard`, or its reports at
   `/projects/:id/reports`.
2. Review velocity, burndown, cumulative flow, cycle time, overdue tasks,
   workload, time tracking, and status distribution.
3. Scope burndown to a specific sprint or the active sprint as needed.

**Result:** You have the metrics to judge pace and risk.

**Related:** Agents use `get_velocity_report`, `get_burndown`,
`get_cumulative_flow`, `get_overdue_tasks`, `get_workload`,
`get_status_distribution`, `get_cycle_time_report`, `get_time_tracking_report`.

### Story: Subscribe to a project calendar

**Who:** Anyone who wants due dates in their calendar app.
**Goal:** See task due dates in an external calendar.
**Before you start:** Access to the project and a calendar token.

**Steps**

1. Generate a calendar token for the project (or use your personal feed).
2. Copy the feed URL (`/projects/:id/calendar.ics` or `/me/calendar.ics`) with the
   token in the query string.
3. Add the feed to your external calendar app as a subscribed calendar.

**Result:** Tasks with due dates appear in your calendar and refresh on the app's
schedule. Revoke the token any time to cut access.

**Related:** iCal feed.

### Story: Deep-link a task across apps

**Who:** Anyone who shares a task reference in another app.
**Goal:** Open a task directly from a reference like MAGE-38.
**Before you start:** Access to the project that owns the task.

**Steps**

1. From a Banter message or email that references a task (for example MAGE-38),
   open `/b3/tasks/ref/MAGE-38`.
2. Bam resolves the reference to the task.

**Result:** The project board opens with that task's drawer open.

**Related:** Share to Banter; the `bam_get_task_by_human_id` and `resolve_references`
tools.

### Story: Sync tasks from an external system with an agent

**Who:** An AI agent keeping a Bam project in step with an external tracker.
**Goal:** Create or update tasks idempotently without making duplicates.
**Before you start:** A service-account API key whose agent policy allows the Bam
task tools, and an external id per source record.

**Steps**

1. The agent resolves the project by name or id and confirms write access.
2. For each external record, the agent calls `task_upsert_by_external_id` with the
   project, the external id, and the task fields.
3. Bam creates the task on first sight and updates it on subsequent calls, emitting
   a `task.upserted` event with a `created` flag each time.
4. For any task the agent intends to surface in a shared channel, it first calls
   `can_access` and drops entities the asker may not see.

**Result:** The project stays mirrored to the external system with no duplicate
tasks, and every change is recorded under the agent actor in the audit log.

**Related:** The Working with AI agents section; `task_upsert_by_external_id`,
`can_access`, `agent_audit`.

## Related

- **Helpdesk** (`/helpdesk/`) - Tickets can create Bam tasks; a created task shows
  a Helpdesk tab linking to its source ticket.
- **Banter** (`/banter/`) - Share tasks to channels and deep-link back via human
  ids.
- **Bolt** (`/bolt/`) - Receives task, sprint, epic, and comment events from Bam.
- **Bench** (`/bench/`) and the project reports - Delivery metrics and dashboards.
- Bam MCP-tools reference and guide in `docs/apps/bam/` (`mcp-tools.md`,
  `guide.md`). Treat the code as the source of truth where the reference lags.
