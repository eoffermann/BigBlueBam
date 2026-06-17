# Bearing - Goals and OKRs

> Bearing is the goals and OKR tracker for BigBlueBam. Teams use it to set objectives for a time period, attach measurable key results, check in on progress, and surface the goals that are falling behind before the period ends.

## Overview

Bearing organizes work around objectives. You create a **Period** (a named time box such as a quarter), add **Goals** inside it, and break each goal into **Key Results** that carry a start value, a target value, and a current value. As you record progress on the key results, Bearing rolls those numbers up into a single goal progress percentage and compares it against where you should be by now, so a goal that is drifting becomes visible while there is still time to act.

The product is built for small to medium teams running a regular OKR cadence: set goals at the start of a period, check in weekly with status updates, triage the goals that are at risk, and close the period out at the end. Goals can be scoped to the whole organization, a team, a project, or an individual, so the same period can hold company objectives next to team objectives.

Bearing can read progress from your real work when an agent or API caller links a key result to a Bam epic, project, or sprint. As linked Bam tasks reach a done state, a background job recomputes the key result and its goal automatically. That linking is available through the MCP tools and REST, not through a human screen in this build.

Bearing is in **beta**. It signs you in with your existing BigBlueBam (Bam) session, so you reach it the same way you reach the other apps in the suite.

### Key concepts

- **Period** - A named time box that goals live inside, for example "Q2 2026". A period has a type, a start date, an end date, and a status. The whole Bearing UI is scoped to one selected period at a time.
- **Period status** - The lifecycle of a period. The Bearing UI shows these as **draft**, **active**, **completed**, and **archived**. You activate a period to make it the working scope and complete it when the period is over.
- **Goal** - An objective owned by one user inside a period. A goal has a title, an optional description, a scope, a status, and a cached progress percentage that is the average of its key results.
- **Scope** - Who a goal is for: **Organization**, **Team**, **Project**, or **Individual**. The dashboard can filter and group goals by scope.
- **Goal status** - Where a goal stands: **draft**, **on_track**, **at_risk**, **behind**, **achieved**, **missed**, or **cancelled**. Bearing derives status automatically from how actual progress compares to expected progress, unless someone overrides it.
- **Key Result (KR)** - A measurable outcome under a goal. Each KR has a metric type (**Number**, **Percentage**, **Currency**, or **Yes/No**), a start value, a target value, a current value, and an optional unit. KR progress is clamped between 0 and 100 percent.
- **Check-in** - Recording a new current value for a key result. Each check-in updates the KR's progress, rolls up to the goal's progress, and writes a point-in-time snapshot for the sparkline and history chart.
- **Status update** - A status post against a goal. It records a status tag, an optional body, and a snapshot of the goal's status and progress at the time it was posted.
- **Watcher** - A user subscribed to a goal who is emailed when the goal's status changes.
- **Expected progress** - Where a goal should be based on how much of the period has elapsed. Bearing compares actual against expected to decide whether a goal is on track, at risk, or behind.
- **At Risk** - The view that lists goals whose status is at_risk or behind, sorted by how far they have fallen behind expected progress.

### Where to find it

Bearing is served at `/bearing/`. Reach it from the BigBlueBam app switcher the same way you reach the other apps.

Before Bearing is usable:

- You must be logged in to BigBlueBam. If you are not, Bearing shows a "Please log in to BigBlueBam first" screen with a link to `/b3/`.
- You work inside your active organization. Bearing scopes everything to that org.
- **At least one Period must exist and be selected.** The dashboard and the at-risk view are gated on a selected period. A fresh org has no periods, so the first thing to do is create one on the **Periods** page and select it in the sidebar.

Press **?** anywhere outside a text field to open the in-app help viewer.

## Feature reference

The Bearing sidebar carries a brand mark with a **beta** pill, a **period scope selector** dropdown, and four navigation items with these exact labels: **Dashboard**, **My Goals**, **At Risk**, and **Periods**. The period scope selector sets the one period that the whole UI is scoped to; your choice is remembered between visits, and Bearing auto-selects the first active period if you have not chosen one.

### Goals Dashboard

The Dashboard is the home view at `/`. It shows the goals in the selected period, with filters and a search box.

![Goal dashboard](screenshots/light/01-dashboard.png)

What you see, top to bottom:

- The header **"Goals Dashboard"** with the subtitle "Track objectives and key results across your organization." and a **New Goal** button.
- A period selector card showing the selected period's name, date range, and time remaining.
- A stats row with four cards: **Total Goals**, **Avg Progress**, **At Risk**, and **Achieved**. These read from the selected period's report and populate with the period's real totals.
- Scope tabs: **All**, **Organization**, **Team**, **Project**, **Individual**.
- A search box with placeholder "Search goals...".
- A grid of goal cards. With the **All** tab selected, cards are grouped by scope. Each card shows the goal's title, scope badge, project or team, a progress bar (actual against expected), the owner avatar, and the key result count.

To open a goal, click its card. To browse a different period, change the selection in the sidebar period selector.

If no period is selected you see a "Select a period" prompt. If the period has no goals you see "No goals found" with a **Create First Goal** button.

### My Goals

My Goals at `/my-goals` lists every goal you own across all periods, not just the selected one.

![My goals](screenshots/light/03-my-goals.png)

- The header reads **"My Goals"** with the subtitle "All goals owned by you across all periods." and a **New Goal** button that takes you to the Dashboard to create one.
- Goals are split into **Active** and **Completed** sections, where completed means a goal that is achieved or missed.
- Each row shows the goal icon, title, status badge, progress bar, period and scope badges, and the key result count. Click a row to open the goal.

If you own no goals you see "No goals assigned to you" with a **Go to Dashboard** button.

### At Risk

At Risk at `/at-risk` is the triage view. It lists the goals in the selected period whose status is at_risk or behind, sorted so the goals that have fallen furthest behind appear first.

![At-risk goals](screenshots/light/04-at-risk.png)

- The header reads **"At Risk Goals"** with the subtitle "Goals that are behind expected progress and need attention.".
- Each row shows a red alert badge, the goal title, its status badge, a progress bar, an "actual vs expected" readout, a color-coded **Gap**, and the owner avatar. Click a row to open the goal.

If nothing is behind you see "All goals are on track".

### Periods

The Periods page at `/periods` is where you create and manage the time boxes that hold goals.

![Periods](screenshots/light/05-periods.png)

- The header reads **"Periods"** with the subtitle "Manage time periods for organizing goals and OKRs." and a **New Period** button.
- A table with columns **Name**, **Type**, **Date Range**, **Status**, and **Goals**, plus a row menu.
- Each row has a "..." menu with **Edit**, an **Activate** item (shown only while the period's status is planning), a **Complete** item (shown only when the period is active), and **Delete**.

To create a period:

1. Click **New Period**. The Period Form dialog opens.
2. Type a **Name**, for example "Q2 2026".
3. Choose a **Type**: **Quarter**, **Half Year**, **Year**, or **Custom**.
4. Set the **Start Date** and **End Date**. The start date must be before the end date.
5. Click **Create Period**.

To edit a period, choose **Edit** from the row menu. The same dialog opens with a **Save Changes** button.

To activate a newly created period so it becomes the working scope, choose **Activate** from the row menu (shown while the period is in planning). To complete a period when it is over, choose **Complete** from the row menu (available only while the period is active). To delete a period, choose **Delete** and confirm. Deleting is blocked with a conflict error if the period still has goals.

### Goal Detail

Open a goal from any list to reach its detail page at `/goals/:id`. This is where most day-to-day work happens.

![Goal detail](screenshots/light/02-goal-detail.png)

The page has a **Back to Dashboard** link, the goal title and description, a status badge, and a "..." menu with **Edit** and **Delete Goal**.

To edit a goal's title or description:

1. Open the "..." menu and choose **Edit**.
2. Change the **Title** input and the description box.
3. Click **Save**, or **Cancel** to discard.

Below the header is a meta row with the owner avatar and name, the scope badge, the period-name badge, and the project-name badge, followed by a progress bar reading "{n}% (expected: {m}%)".

The right sidebar holds a **Progress Over Time** chart that plots the goal's actual progress against expected over the period, a **Period Timeline** card showing the goal's creation date, and the **Watchers** card.

Note: the **Period Timeline** card's time-remaining badge is inert in this build (it is fed an empty end date), so it does not count down. The progress chart, the progress-bar values, and the **Watchers** card all work as described.

### Create a Goal

Goals are created from the Dashboard.

1. On the **Dashboard**, click **New Goal**. The dialog opens with the title "Create Goal" and the description "Set a new objective for this period.".
2. Type a **Title**, for example "Increase customer retention by 15%".
3. Optionally fill in **Description (optional)** with why the goal matters.
4. Choose a **Scope**: **Organization**, **Team**, or **Project** (the dialog defaults to **Team**).
5. Click **Create Goal**.

Bearing creates the goal in the selected period, assigns you as the owner, and opens the new goal's detail page.

Note that the Create Goal dialog does not offer an **Individual** scope or an owner field; new goals are owned by you. Reassigning a goal to another owner is done through the AI agent tool `bearing_goal_update` or REST, not the human UI.

### Add and edit Key Results

Key Results live in the **Key Results (n)** section of the goal detail page.

To add a key result:

1. On the goal detail page, click **Add Key Result** (or **Add First Key Result** if there are none yet). The dialog opens with the title "Add Key Result" and the description "Define a measurable outcome for this goal.".
2. Type a **Title**, for example "Increase monthly active users".
3. Choose a **Metric Type**: **Number**, **Percentage**, **Currency**, or **Yes/No**.
4. Set the **Start Value** and the **Target Value**.
5. For **Number** or **Currency** metrics, optionally set a **Unit (optional)**, for example "users", "$", or "EUR".
6. Click **Add Key Result**.

To edit a key result, hover its row, open the "..." menu, and choose **Edit**. The same dialog opens with a **Save Changes** button. To delete one, open the "..." menu and choose **Delete**, then confirm.

Each key result row shows a metric icon, the title, a progress bar, a sparkline of recent values, and a "current / target" readout. The goal's overall progress is the average of its key results' progress, and that progress renders correctly throughout Bearing (see the note under Record progress below).

### Record progress on a Key Result

You record progress (a check-in) by setting a key result's current value.

1. On the goal detail page, hover the key result's row.
2. Click **Update**.
3. Type the new current value in the inline number field.
4. Click **Save**, or **Cancel** to back out. Pressing Enter saves and Escape cancels.

A check-in records the new value, updates the key result's progress, recomputes the goal's overall progress as the average of its key results, re-derives the goal's status, and writes a snapshot row that feeds the KR sparkline and the goal history chart.

Goal and key-result progress display the real percentage. Earlier builds capped the stored progress value at a precision that overflowed for any figure of 10 percent or more, which left progress bars stuck at 0 percent; that storage limit has been widened, so bars and percentages reflect the actual numbers.

### Post a status update

Status updates are the weekly check-in narrative on a goal.

1. On the goal detail page, in the **Status Updates** section, click **Post Update**. The dialog opens with the title "Post Status Update" and the description "Share progress with your team.".
2. Choose a status chip: **On Track**, **At Risk**, **Behind**, or **Achieved**.
3. Type your note in the **Update** box, for example what changed and any blockers.
4. Click **Post Update**.

Your update appears in the feed with your name, a relative timestamp, the body, a status badge for the status you chose, and the goal's progress at the time you posted. Posting an update snapshots the goal's status and progress.

### Watch a goal

The **Watchers** card on the goal detail page subscribes people to status-change emails.

1. On the goal detail page, find the **Watchers (n)** card in the right sidebar.
2. Click the add (person-plus) icon to reveal the input.
3. Type a user ID or email into the **User ID or email** field.
4. Click the **+** button, or press Enter, to subscribe that person.
5. To stop watching, hover a watcher chip and click the **X**.

The form subscribes whoever you enter, resolving the value to an active member of your org by user ID first, then by email. To remove a watcher who is not you, you must be the goal's owner or an org admin or owner.

When a watched goal's status changes, a background job emails the watchers (using real email when SMTP is configured for the deployment), with an unsubscribe link per recipient.

### Reports and CSV export

Bearing can produce period, at-risk, and owner reports, plus CSV exports of goals and key results. These are available through the API and the MCP tools, not through a screen in the Bearing SPA.

- A **period report** is a markdown summary table with per-goal and per-key-result detail for one period.
- An **at-risk report** is a markdown list of every at_risk and behind goal across the org.
- An **owner report** is a markdown rollup of one user's goals grouped by period.
- **CSV exports** dump all goals (`goals-export.csv`) or all key results (`key-results-export.csv`).

To produce any of these, use the AI agent tools `bearing_report` and `bearing_at_risk` described next, or call the REST routes directly.

### Working with AI agents

Bearing exposes a set of MCP tools so AI agents can drive the same goals and key results you manage in the UI, and reach a few capabilities the human UI does not surface (linking, reports, status override, and CSV-style detail). Agents forward your bearer token and org context, and many tools accept human labels (a period name, a goal or key result title, an owner's email) in place of UUIDs. When a key result title is shared across multiple goals, the resolver fails closed and asks the agent to disambiguate with a UUID.

Period tools:

- `bearing_periods` - list periods, optionally filtered by status or year.
- `bearing_period_get` - one period plus its stats (goal count, average progress, at-risk count).
- `bearing_period_create` - create a period (cadence quarter, half, year, month, or custom) with start and end dates.
- `bearing_period_update` - change a period's name, type, dates, or status (set status to archived to archive it).
- `bearing_period_delete` - delete a period.
- `bearing_period_activate` - make a period the live planning window.
- `bearing_period_complete` - close a period out at the end of the cadence.

Goal tools:

- `bearing_goals` - list goals filtered by period, scope, owner, or status.
- `bearing_goal_get` - one goal with its key results and progress detail.
- `bearing_goal_create` - create a goal, naming the period by label and the owner by email.
- `bearing_goal_update` - update a goal, including reassigning the owner. This is the only way to change a goal's owner, since the UI has no owner picker.
- `bearing_goal_delete` - delete a goal and its key results.
- `bearing_goal_status_override` - force a goal's status (for example to at_risk or achieved), bypassing the automatic progress-derived status. There is no human screen for this; it is agent and REST only.
- `bearing_goal_updates` - list the status updates posted on a goal.
- `bearing_goal_history` - get a goal's point-in-time progress snapshots.
- `bearing_goal_watchers` - list a goal's watchers.
- `bearing_goal_watch` - add a watcher to a goal.
- `bearing_goal_unwatch` - remove a watcher (yourself, or anyone if you are the owner or an org admin or owner).

Key result tools:

- `bearing_kr_list` - list the key results under a goal.
- `bearing_kr_get` - get one key result.
- `bearing_kr_create` - add a key result to a goal.
- `bearing_kr_update` - update a key result's definition and, when a current value is supplied, record a value check-in.
- `bearing_kr_delete` - delete a key result.
- `bearing_kr_link` - link a key result to a Bam epic, project, sprint, or task so its progress tracks real delivery. There is no human screen for this in the current build; it is agent and REST only.
- `bearing_kr_links` - list the Bam-entity links on a key result.
- `bearing_kr_unlink` - remove a link from a key result.
- `bearing_kr_history` - get a key result's value and progress snapshot history.

Update and report tools:

- `bearing_update_post` - post a goal status update, the same as the **Post Update** dialog.
- `bearing_report` - generate a period, at-risk, or owner report as markdown or JSON. There is no human reports screen; this is how reports are produced.
- `bearing_at_risk` - return the org-wide list of at-risk and behind goals.

When an agent links a key result to Bam work with `bearing_kr_link`, a background recompute job keeps that key result and its goal current as the linked Bam tasks reach a done state. Bearing also emits events (goal created, updated, status changed, achieved, deleted, watcher added or removed; key result created, updated, value updated, linked, deleted; period activated, completed, archived) that Bolt automations can react to.

Beyond the Bearing-specific tools, agents working here also use the cross-cutting platform surface that every BigBlueBam app shares:

- **Identity and heartbeat.** Agent and service callers are first-class identities (`users.kind` is human, agent, or service), and runners report liveness and capabilities through `agent_heartbeat`, `agent_self_report`, and `agent_audit`. Goals, key results, and updates created by an agent are attributed to that agent in the same feeds humans read.
- **Approval queues.** A risky or far-reaching change (for example bulk-creating a quarter of goals, or overriding statuses) can be staged for a human through `proposal_create` / `proposal_list` / `proposal_decide` instead of applied directly.
- **Unified activity and cross-app search.** `search_everything` fans out across apps so a Bearing goal turns up alongside related Bam tasks, Bond deals, and Beacon docs, and the unified activity view threads Bearing changes into one timeline.
- **Visibility preflight.** Before an agent cites a Bearing goal in a shared surface such as a Banter post or a Brief doc, it calls `can_access` for each entity and drops anything the asker is not allowed to see.
- **Policies and webhooks.** Every service-account tool call passes the platform `agent_policies` allowlist and kill switch before it runs, so an agent only reaches the Bearing tools its policy permits, and outbound webhooks can push subscribed Bearing events to an agent runner.

For reviewers: agent-created goals and updates show up in the same lists and feeds as human ones, attributed to the agent. See the Bearing MCP-tools reference under `docs/apps/bearing/` for the full catalog and parameters.

## User Stories

### Story: Set up your first quarter

**Who:** A team lead standing up OKRs in a fresh org.
**Goal:** Have an active period selected so goals can be created.
**Before you start:** You are logged in to BigBlueBam and Bearing is open. No period exists yet.

**Steps**

1. In the sidebar, click **Periods**.
2. Click **New Period**.
3. In the **Name** field type your period name, for example "Q2 2026".
4. Choose a **Type** of **Quarter**.
5. Set the **Start Date** and **End Date** to cover the quarter.
6. Click **Create Period**.
7. In the period's "..." menu, choose **Activate**.
8. In the sidebar period scope selector at the top, select the period you just created.

**Result:** The period is active and selected, and scopes the whole UI. The Dashboard now shows this period and is ready for goals.

**Related:** You can also start working in a period just by selecting it in the sidebar selector. See "Provision a quarter with an agent" below for the agent counterpart.

### Story: Create your first objective

**Who:** A goal owner setting an objective for the quarter.
**Goal:** Create a goal in the current period and open it.
**Before you start:** A period exists and is selected in the sidebar.

**Steps**

1. In the sidebar, click **Dashboard**.
2. Click **New Goal**.
3. Type a **Title**, for example "Increase customer retention by 15%".
4. Optionally fill in **Description (optional)**.
5. Choose a **Scope** of **Organization**, **Team**, or **Project**.
6. Click **Create Goal**.

**Result:** The goal is created in the selected period with you as the owner, and Bearing opens its detail page.

**Related:** Add Key Results next. To set a different owner, use the agent tool `bearing_goal_create` with an owner email, or `bearing_goal_update` afterward.

### Story: Break a goal into key results

**Who:** A goal owner who wants measurable outcomes.
**Goal:** Add the key results that define what success means for the goal.
**Before you start:** You are on the goal's detail page.

**Steps**

1. In the **Key Results** section, click **Add Key Result** (or **Add First Key Result**).
2. Type a **Title**, for example "Increase monthly active users".
3. Choose a **Metric Type**: **Number**, **Percentage**, **Currency**, or **Yes/No**.
4. Set the **Start Value** and **Target Value**.
5. For a **Number** or **Currency** metric, optionally set a **Unit (optional)**.
6. Click **Add Key Result**.
7. Repeat for each measurable outcome.

**Result:** Each key result appears as a row with a progress bar and a "current / target" readout. The goal's progress is the average of its key results and renders the real percentage.

**Related:** Record progress on a key result next. To wire a key result to real Bam delivery, an agent can use `bearing_kr_link`.

### Story: Record weekly progress

**Who:** A goal owner doing a weekly check-in.
**Goal:** Update a key result's current value so the goal's progress and status recompute.
**Before you start:** The goal has at least one key result.

**Steps**

1. Open the goal's detail page.
2. Hover the key result row and click **Update**.
3. Type the new current value in the inline field.
4. Click **Save**.

**Result:** The key result's value and progress update, the goal's overall progress and status recompute from the average, and a snapshot is written for the sparkline. Progress shows the true percentage.

**Related:** Post a status update to add narrative for the team. An agent can record the same check-in with `bearing_kr_update`.

### Story: Post a status update for the team

**Who:** A goal owner sharing progress.
**Goal:** Leave a check-in note and a status on the goal.
**Before you start:** You are on the goal's detail page.

**Steps**

1. In the **Status Updates** section, click **Post Update**.
2. Choose a status chip: **On Track**, **At Risk**, **Behind**, or **Achieved**.
3. Type your note in the **Update** box.
4. Click **Post Update**.

**Result:** The update appears in the feed with your name, the time, the status badge, and the goal's progress at the time you posted. Watchers are notified when the status changes.

**Related:** Watch a goal to receive its status-change emails. An agent can post the same update with `bearing_update_post`.

### Story: Triage the goals that are behind

**Who:** A team lead reviewing where the quarter is slipping.
**Goal:** Find the goals that are at risk or behind and act on the worst ones.
**Before you start:** A period is selected and has goals with recorded progress.

**Steps**

1. In the sidebar, click **At Risk**.
2. Review the list, which is sorted by how far each goal has fallen behind expected progress, with the worst at the top.
3. Read each row's "actual vs expected" readout and **Gap**.
4. Click the goal that needs the most attention to open it.
5. On the goal, record updated key result values and post a status update explaining the plan.

**Result:** You have identified the goals that need attention and refreshed their progress and narrative.

**Related:** An agent can pull the same list anytime with `bearing_at_risk`, or generate a markdown at-risk report with `bearing_report`.

### Story: Review your own goals across periods

**Who:** Any individual contributor or lead who owns goals.
**Goal:** See every goal you own, current and finished, in one place.
**Before you start:** You own at least one goal in any period.

**Steps**

1. In the sidebar, click **My Goals**.
2. Read the **Active** section for goals still in flight.
3. Read the **Completed** section for goals that are achieved or missed.
4. Click any row to open that goal.

**Result:** You see all of your goals across every period, grouped by whether they are still active.

### Story: Watch a goal you care about

**Who:** A stakeholder who wants to be told when a goal's status changes.
**Goal:** Subscribe someone to a goal's status-change emails.
**Before you start:** You are on the goal's detail page.

**Steps**

1. In the right sidebar, find the **Watchers** card.
2. Click the add (person-plus) icon.
3. Type a user ID or email into the **User ID or email** field.
4. Click the **+** button, or press Enter, to subscribe that person.

**Result:** The watcher's avatar appears on the card. When the goal's status changes, a background job emails them.

**Related:** The form subscribes whoever you enter, resolving the value by user ID first, then by email. An agent can do the same with `bearing_goal_watch`.

### Story: Close out the quarter

**Who:** A team lead wrapping up a period.
**Goal:** Mark the period complete and produce a retrospective report.
**Before you start:** The period is active and its goals are up to date.

**Steps**

1. In the sidebar, click **Periods**.
2. Find the period's row and open its "..." menu.
3. Choose **Complete**.

**Result:** The period is marked completed and a period.completed event fires for any Bolt automations watching it.

**Related:** For a retrospective, an agent can run `bearing_report` with the period type to produce a markdown summary table with per-goal and per-key-result detail.

### Story: Provision a quarter with an agent

**Who:** An AI agent provisioning OKRs from a brief.
**Goal:** Create a period, goals, and key results in one pass without manual UI work.
**Before you start:** The agent has a Bearing-scoped policy and the org context.

**Steps**

1. The agent creates or activates the period with `bearing_period_create` and `bearing_period_activate` (or fetches an existing one with `bearing_periods` or `bearing_period_get`).
2. For each objective, the agent calls `bearing_goal_create`, naming the period by label and the owner by email.
3. For each measurable outcome, the agent calls `bearing_kr_create` against the goal title.
4. The agent records starting values with `bearing_kr_update`.

**Result:** A fully populated period with owned goals and key results, ready for the team. The same goals appear in the human Dashboard and My Goals views, with progress rendering correctly.

**Related:** This is the agent counterpart to the first four human stories above. For a far-reaching batch, the agent can stage the plan with `proposal_create` for a human to approve first.

### Story: Wire key results to real delivery (agent)

**Who:** An AI agent connecting OKRs to Bam work.
**Goal:** Make a key result's progress track actual task completion automatically.
**Before you start:** The goal and key result exist, and the Bam epic, project, or sprint to track is known.

**Steps**

1. The agent calls `bearing_kr_link` to bind the key result to a Bam epic, project, sprint, or task.
2. As linked Bam tasks reach a done state, the recompute background job updates the key result's progress and rolls it up to the goal.

**Result:** The key result and its goal move on their own as delivery progresses, with no manual check-ins. This linking is available only through agents or REST in the current build.

**Related:** There is no human linking screen, so this story has no UI equivalent. The agent can review the current links with `bearing_kr_links` and remove one with `bearing_kr_unlink`.

### Story: Run a weekly status sweep (agent)

**Who:** An AI agent producing a weekly OKR digest.
**Goal:** Summarize at-risk goals and period progress for the team.
**Before you start:** Periods and goals exist with recorded progress.

**Steps**

1. The agent calls `bearing_at_risk` for the org-wide list of at-risk and behind goals.
2. The agent calls `bearing_report` with the period or owner type for a markdown summary.
3. Before quoting any goal in a shared channel, the agent calls `can_access` for each cited goal and drops anything the audience cannot see.
4. The agent relays the summary into the channel the team reads, for example a Banter post or a Brief document.

**Result:** The team gets a current OKR status summary without anyone opening the Bearing UI.

**Related:** Humans can read the same at-risk list on the **At Risk** page.

## Related

- **Bam** (`/b3/`) - the project planning tool whose epics, projects, sprints, and tasks a key result can be linked to so its progress tracks real delivery. Bearing requires a Bam session to sign in.
- **Bolt** (`/bolt/`) - the automation engine. Bearing emits goal, key result, and period events (goal created, status changed, achieved, key result value updated, period activated and completed, and more) that Bolt rules can react to.
- **Banter** (`/banter/`) and **Brief** (`/brief/`) - common destinations for agent-generated OKR digests produced by `bearing_report` and `bearing_at_risk`.
- **Bench** (`/bench/`) - analytics dashboards that can surface goal progress alongside other org metrics.
- See the Bearing MCP-tools reference and guide under `docs/apps/bearing/` for the full tool catalog and parameter details.
