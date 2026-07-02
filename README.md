<p align="center">
  <img src="docs/images/logo.svg" alt="BigBlueBam Logo" width="100" height="100" />
</p>

<h1 align="center">BigBlueBam</h1>

<p align="center">
  <strong>The work suite built for human-AI teams.</strong><br/>
  Your team sets the strategy. AI agents handle the routine. Everyone works in the same place.
</p>

<p align="center">
  <a href="#the-vision">Vision</a> &bull;
  <a href="#the-suite-at-a-glance">At a Glance</a> &bull;
  <a href="#product-tour">Tour</a> &bull;
  <a href="#for-teams">For Teams</a> &bull;
  <a href="#for-ai-agents">For AI Agents</a> &bull;
  <a href="#banter">Banter</a> &bull;
  <a href="#helpdesk">Helpdesk</a> &bull;
  <a href="#beacon">Beacon</a> &bull;
  <a href="#brief">Brief</a> &bull;
  <a href="#bolt">Bolt</a> &bull;
  <a href="#bearing">Bearing</a> &bull;
  <a href="#board">Board</a> &bull;
  <a href="#bond">Bond</a> &bull;
  <a href="#blast">Blast</a> &bull;
  <a href="#bench">Bench</a> &bull;
  <a href="#book">Book</a> &bull;
  <a href="#blank">Blank</a> &bull;
  <a href="#bill">Bill</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#documentation">Docs</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-900%2B%20passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/MCP%20tools-804-blue" alt="MCP Tools" />
  <img src="https://img.shields.io/badge/apps-19-blueviolet" alt="Apps" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
</p>

---

## The Vision

Most work platforms are built for humans talking to humans. Bolt an AI agent onto one and you get a bot poking at a UI it was never meant to touch. BigBlueBam starts from the other end: it is built for **human-AI collaboration** from the ground up — a world where your team and AI agents plan projects, message each other, close deals, write docs, track goals, automate workflows, and support customers in the same suite, at the same time, with the same permissions.

**Humans** own the strategy: setting priorities, defining epics, closing deals, reviewing deliverables, talking to customers.

**AI agents** own the routine: triaging helpdesk tickets, writing knowledge base articles, drafting documents, updating CRM pipelines, generating sprint reports, firing workflow automations, and keeping the board organized.

The **suite** is the shared workspace. When an AI agent creates a task, replies to a customer, updates a deal, or posts to a Banter channel, it shows up in real time, right alongside everything your team is doing. No separate dashboards. No hidden automation. Full transparency.

This is made possible by **804 MCP tools** that give AI assistants (Claude, Claude Code, custom agents) full read-write access to project boards, sprints, team messaging (with scheduled posts and pattern subscriptions), helpdesk tickets, knowledge base, collaborative docs, workflow automations with runtime observability, goals and OKRs, whiteboards, CRM pipelines with dedupe, email campaigns, analytics dashboards, scheduling with mixed human-and-agent rosters, forms, invoicing, plus cross-cutting platform capabilities (cross-app search, composite subject views, entity linking, durable proposal queues, per-agent kill switches, HMAC-signed outbound webhooks). Service-account agents run behind a fail-closed policy gate with confirm-action tokens backed by Redis so destructive flows survive rolling deploys.

---

## The Suite at a Glance

Nineteen apps, one workspace. If you've used the tools on the right you already know most of how each app works — the twist is that all nineteen live under the same auth, the same org and project permissions, and the same 804-tool MCP surface. No integration glue, no per-tool API keys, no glue-code tax: an agent that can move a card can also close a deal, publish an article, and send an invoice.

| App | What it is | Comparable to |
|-----|------------|---------------|
| **Bam** | Project management — Kanban board, sprints, five views (board/list/timeline/calendar/workload) | Trello, Linear, Jira, Asana |
| **Banter** | Team chat with LiveKit voice/video, transcripts, and AI agents as spoken call participants | Slack or Microsoft Teams, with Zoom-style voice/video built in |
| **Bay** | Media review and approval — frame/timecode/region annotations, per-reviewer decisions, token-gated guest links, and 3D/FBX model review | Frame.io, Ziflow |
| **Beacon** | AI knowledge base with semantic search (Qdrant) and a graph explorer | Notion or Confluence, with an Obsidian-style graph view |
| **Bearing** | Goals and OKRs with key results linked to Bam tasks for automatic progress | Lattice, 15Five, Quantive |
| **Bench** | Analytics dashboards, widgets, ad-hoc queries, scheduled reports, anomaly detection | Metabase, Tableau, Looker |
| **Bill** | Invoicing, expenses, recurring billing, PDF generation, profitability reports | FreshBooks, QuickBooks, Wave |
| **Bin** | Digital asset management — object-storage backbone plus a structured-data (CSV/JSON/YAML) grid/tree editor with live co-editing | Dropbox/Box, plus an Airtable-style data grid |
| **Blank** | Forms with conditional logic routing, submissions export, AI-generated form definitions | Typeform, Google Forms, Tally |
| **Blast** | Email campaigns with templates, segments, tracking pixel, click redirect, engagement analytics | Mailchimp, ConvertKit, ActiveCampaign |
| **Blip** | App telemetry — log ingest, live viewer, saved views, watches/alerts, transforms, retention, and scheduled reports | Datadog Logs, Grafana Loki, Papertrail |
| **Blueprint** | Structured diagrams — typed graph nodes and edges (flowcharts, org charts, ERDs, mindmaps) with ELK auto-layout and Mermaid import/export | Lucidchart, draw.io |
| **Board** | Infinite-canvas whiteboard with shapes, stickies, and audio conferencing | Miro, Mural, FigJam |
| **Bolt** | Workflow automation — both a form-based trigger/condition/action builder and a visual node-graph editor | Zapier or Make (form side); n8n or Node-RED (graph side) |
| **Bond** | CRM — contacts, companies, deals, pipeline stages, activity log, dedupe | HubSpot, Pipedrive, Attio |
| **Book** | Scheduling with public booking pages and mixed human-plus-agent availability | Calendly, Cal.com |
| **Brief** | Real-time collaborative documents with versioning and inline comments | Google Docs, Notion, Dropbox Paper |
| **Bureau** | Virtual office — a spatial floor map with rooms, live presence, knock-to-enter, teleport/summons, and LiveKit conferencing | Gather, Teamflow |
| **Helpdesk** | Customer support portal with ticket tracking, similar-ticket dedupe, and auto task creation | Zendesk, Intercom, Help Scout |

**What the comparison table doesn't show:** every one of these apps is wired into the same MCP surface, so an AI agent triaging a Helpdesk ticket can upsert the requester in Bond, create a Bam task, post a Banter update to the engineering channel, and schedule a Book meeting with the customer — in one cross-app flow, with visibility preflight and a durable approval queue gating anything destructive.

---

## Product Tour

<p align="center">
  <img src="site/public/screenshots/bam/light/01-board.png" alt="Kanban Board" width="100%" />
</p>
<p align="center"><em>The Kanban board — the central hub where human and AI work converges.</em></p>

<br/>

<table>
  <tr>
    <td width="50%"><img src="site/public/screenshots/bam/light/09-timeline.png" alt="Timeline View" width="100%" /></td>
    <td width="50%"><img src="site/public/screenshots/bam/light/10-calendar.png" alt="Calendar View" width="100%" /></td>
  </tr>
  <tr>
    <td align="center"><em>Timeline / Gantt view</em></td>
    <td align="center"><em>Calendar view</em></td>
  </tr>
  <tr>
    <td width="50%"><img src="site/public/screenshots/bam/light/04-list-view.png" alt="List View" width="100%" /></td>
    <td width="50%"><img src="images/09-project-dashboard.png" alt="Project Analytics" width="100%" /></td>
  </tr>
  <tr>
    <td align="center"><em>List / table view</em></td>
    <td align="center"><em>Project analytics dashboard</em></td>
  </tr>
  <tr>
    <td width="50%"><img src="site/public/screenshots/helpdesk/light/02-ticket-list.png" alt="Helpdesk Tickets" width="100%" /></td>
    <td width="50%"><img src="images/14-command-palette.png" alt="Command Palette" width="100%" /></td>
  </tr>
  <tr>
    <td align="center"><em>Helpdesk ticket list</em></td>
    <td align="center"><em>Command palette (Ctrl+K)</em></td>
  </tr>
</table>

---

## For Teams

### Kanban Board

Drag-and-drop cards across 5 configurable phases with WIP limits. Each card shows priority, assignee, story points, due date, and comment count at a glance. Motion spring physics make the interactions feel natural.

<p align="center">
  <img src="site/public/screenshots/bam/light/01-board.png" alt="Kanban Board" width="100%" />
</p>
<p align="center"><em>Every screen is theme-aware — light for daytime, dark for late-night deploys (see the Theme-aware UI section below).</em></p>

### Swimlanes

Group tasks by assignee, priority, or epic. Collapsible rows show task count and total story points per group, making it easy to spot bottlenecks and unbalanced workloads.

<p align="center">
  <img src="images/05-swimlanes.png" alt="Swimlanes by Assignee" width="100%" />
</p>

### Five Views, One Board

Every project supports five views — switch between them without losing your filters or context:

| View | What it shows |
|------|--------------|
| **Board** | Kanban columns with drag-and-drop cards |
| **List** | Sortable, filterable table with inline editing |
| **Timeline** | Gantt-style horizontal bars from start to due date |
| **Calendar** | Monthly calendar with tasks on their due dates |
| **Workload** | Team member capacity and allocation |

<table>
  <tr>
    <td width="50%"><img src="site/public/screenshots/bam/light/04-list-view.png" alt="List View" width="100%" /></td>
    <td width="50%"><img src="site/public/screenshots/bam/light/09-timeline.png" alt="Timeline View" width="100%" /></td>
  </tr>
  <tr>
    <td align="center"><em>List view with sortable columns</em></td>
    <td align="center"><em>Timeline / Gantt view with today marker</em></td>
  </tr>
</table>

<p align="center">
  <img src="site/public/screenshots/bam/light/10-calendar.png" alt="Calendar View" width="100%" />
</p>
<p align="center"><em>Calendar view — monthly navigation with task due dates</em></p>

### Task Detail

Click any card to open the detail drawer. Full rich-text description with image support, assignee, priority, phase, sprint, story points, start and due dates, subtasks, file attachments, comments with emoji reactions, and a complete activity feed.

<p align="center">
  <img src="site/public/screenshots/bam/light/02-task-detail.png" alt="Task Detail Drawer" width="100%" />
</p>

### Sprint Management

Create sprints, assign tasks, track velocity. When a sprint ends, the carry-forward ceremony moves incomplete work to the next sprint automatically. Sprint reports show burndown, velocity trends, and completion rates.

### Project Dashboard

Charts and widgets for sprint progress, priority breakdown, overdue tasks, task distribution by phase, and team workload — all in one place.

<p align="center">
  <img src="images/09-project-dashboard.png" alt="Project Analytics Dashboard" width="100%" />
</p>

### My Work

A cross-project view of everything assigned to you, grouped by project. One place to see your full plate.

<p align="center">
  <img src="site/public/screenshots/bam/light/05-my-work.png" alt="My Work View" width="100%" />
</p>

### Command Palette

Press **Ctrl+K** to open the command palette. Search tasks, switch projects, navigate views, and trigger actions without touching the mouse.

<p align="center">
  <img src="images/14-command-palette.png" alt="Command Palette" width="100%" />
</p>

### Organization Management

BigBlueBam ships a dedicated **People** surface (not buried under Settings) that covers the full identity lifecycle — invite, edit, assign, disable — with strict role-based gating.

<p align="center">
  <img src="site/public/screenshots/bam/light/04-people.png" alt="People list — searchable, filterable, bulk-selectable" width="100%" />
</p>

Filter by role or status, search by name or email, and act on individual members or in bulk.

#### Per-user detail, four tabs

<table>
  <tr>
    <td width="50%"><img src="images/people-detail-overview.png" alt="Overview tab" width="100%" /></td>
    <td width="50%"><img src="images/people-detail-projects.png" alt="Projects tab" width="100%" /></td>
  </tr>
  <tr>
    <td align="center"><em>Overview — identity, membership, disable toggle</em></td>
    <td align="center"><em>Projects — per-project roles, bulk assign</em></td>
  </tr>
  <tr>
    <td width="50%"><img src="images/people-detail-access.png" alt="Access tab" width="100%" /></td>
    <td width="50%"><img src="images/people-detail-activity.png" alt="Activity tab" width="100%" /></td>
  </tr>
  <tr>
    <td align="center"><em>Access — API keys, password reset, force change</em></td>
    <td align="center"><em>Activity — per-user audit trail</em></td>
  </tr>
</table>

Admins can reset passwords (manual or auto-generated), mint API keys on behalf of users with scoped permissions, force a password change on next login, or sign the user out of every device.

<table>
  <tr>
    <td width="50%"><img src="images/people-reset-password-dialog.png" alt="Reset password dialog" width="100%" /></td>
    <td width="50%"><img src="images/people-create-api-key-dialog.png" alt="Create API key dialog" width="100%" /></td>
  </tr>
  <tr>
    <td align="center"><em>Reset password — auto-generate or set manually</em></td>
    <td align="center"><em>Create API key on behalf of a user (one-time token reveal)</em></td>
  </tr>
</table>

#### Bulk operations

Select multiple members to disable, enable, change role, remove from org, or export as CSV — all with rank-gating that mirrors the server:

<p align="center">
  <img src="images/people-bulk-toolbar.png" alt="Bulk actions toolbar" width="100%" />
</p>

#### Multi-org membership

Users can belong to multiple organizations. The header shows the current org + role, and the org switcher lets multi-org users hop between them in one click — the session rotates and every query is invalidated, so the rest of the app instantly reflects the new org's data.

<p align="center">
  <img src="images/org-switcher.png" alt="Org switcher dropdown" width="75%" />
</p>

A persistent banner warns when an org has no active owner, so operators can promote a replacement before the situation becomes invisible:

<p align="center">
  <img src="images/no-owner-banner.png" alt="No active owner banner" width="100%" />
</p>

#### SuperUser console

A separate SuperUser namespace at `/b3/superuser` gives platform operators cross-org visibility without impersonation. See every org on the server, context-switch into any of them, and manage users globally.

<p align="center">
  <img src="images/superuser-overview.png" alt="SuperUser console overview" width="100%" />
</p>

**Cross-org user management** — one view of every user regardless of org:

<p align="center">
  <img src="images/superuser-people-list.png" alt="SuperUser cross-org people list" width="100%" />
</p>

<table>
  <tr>
    <td width="50%"><img src="images/superuser-people-memberships.png" alt="All memberships" width="100%" /></td>
    <td width="50%"><img src="images/superuser-people-sessions.png" alt="Active sessions" width="100%" /></td>
  </tr>
  <tr>
    <td align="center"><em>Every org the user belongs to — add, remove, change role, set default</em></td>
    <td align="center"><em>Every active session with IP, device, and revoke controls</em></td>
  </tr>
</table>

<p align="center">
  <img src="images/superuser-people-activity.png" alt="SuperUser audit log for a user" width="100%" />
</p>
<p align="center"><em>Audit log — every SuperUser action against this user with expandable details</em></p>

When a SuperUser is context-switched into a non-native org, a red banner and chip in the header make the privileged state impossible to miss:

<p align="center">
  <img src="images/superuser-context-banner.png" alt="SuperUser context banner" width="100%" />
</p>

#### Forced password change

Admins can flag a user to require a password change on their next login. On sign-in, the user is bounced to a dedicated form that blocks every other page until a new password is set:

<p align="center">
  <img src="images/password-change.png" alt="Forced password change page" width="100%" />
</p>

#### Theme-aware UI

Every screen adapts to light and dark mode. Most of the shots in this README are dark; here's the same People list in light mode:

<p align="center">
  <img src="images/people-list-light.png" alt="People list — light mode" width="100%" />
</p>

#### Integrations

Configure calendar feeds, API keys, and webhooks under Settings:

<p align="center">
  <img src="site/public/screenshots/bam/light/06-settings-integrations.png" alt="Integrations Settings" width="100%" />
</p>

---

## For AI Agents

This is the part most work suites bolt on as an afterthought. BigBlueBam exposes **804 MCP (Model Context Protocol) tools** that give AI assistants first-class, read-write access to every app in the suite plus cross-cutting platform capabilities — the same operations a human gets through the UI, gated by the same permissions. Connect Claude, Claude Code, or any MCP-compatible agent and let it work alongside your team.

### What AI Agents Can Do

- **Create and manage tasks** — create tasks, set priority and assignee, move cards across phases, add subtasks, and upsert by external id for idempotent webhook/import flows
- **Run sprints** — create sprints, assign tasks, start/complete sprints, generate sprint reports
- **Triage helpdesk tickets** — when a customer submits a ticket, a task is auto-created; AI agents can then triage by adjusting priority, upserting the requester by email, checking for similar open tickets via the dedupe primitives, setting timelines, assigning to the right engineer, and posting responses to customers
- **Generate reports** — velocity reports, burndown charts, cumulative flow, workload distribution, overdue task alerts, plus phrase-count trend queries across helpdesk tickets and Bam tasks
- **Collaborate** — post comments, log time, bulk update tasks, suggest branch names
- **Message the team via Banter** — post messages immediately or schedule for later while respecting per-channel quiet hours, manage channels, react, search conversations and call transcripts, subscribe to message patterns, and participate in voice calls as spoken participants
- **Manage the knowledge base via Beacon** — create, publish, upsert-by-slug, search with semantic plus graph retrieval, verify content freshness, link related knowledge, manage governance policies, and save reusable queries
- **Author collaborative documents via Brief** — create, edit, upsert-by-slug, search documents, manage version history, leave inline comments, apply templates, and graduate finished documents into Beacons
- **Automate workflows with Bolt** — create trigger-condition-action rules, inspect executions, trace why each rule fired or skipped, browse templates, and orchestrate cross-product automations against the full 804-tool catalog
- **Track goals and OKRs with Bearing** — create time-boxed periods, define goals with key results, link KRs to Bam tasks for automatic progress, post status updates, and generate at-risk reports
- **Collaborate visually on Board** — create and manage whiteboard rooms, add and arrange shapes, read canvas content for AI analysis, manage participants, embed cross-product content, and run sticky-to-task pipelines
- **Manage CRM pipeline with Bond** — create, update, upsert-by-email, merge contacts, advance deals through pipeline stages, detect likely duplicates with confidence scores, log activities, and generate pipeline reports
- **Run email campaigns with Blast** — draft campaigns, build segments, generate templates and subject lines, schedule sends, and pull engagement analytics
- **Bill clients with Bill** — create invoices from deals or time entries, add line items, record payments, send reminders, and surface profitability and revenue summaries
- **Collect with Blank forms** — generate form definitions from a prompt, publish forms, export submissions, and summarize free-text responses
- **Schedule with Book** — create, update, cancel, and RSVP to events, and find meeting times across mixed human-plus-agent rosters
- **Analyze with Bench** — create dashboards, run ad-hoc queries, schedule reports, detect anomalies, and compare metrics across time periods
- **Find anything with cross-app platform tools** — `search_everything` fans out across seven searchable apps with normalized scoring; `resolve_references` turns free text into ranked entity candidates; `account_view` / `project_view` / `user_view` compose full subject-centric pictures; `entity_links_list` exposes durable cross-app relationships; `activity_query` and `activity_by_actor` read a unified activity log
- **Run responsibly** — `can_access` preflights visibility before surfacing entities to askers; `proposal_create` / `proposal_list` / `proposal_decide` drive a durable approval queue; `agent_heartbeat` tracks runner liveness; `agent_policy_set` gives operators kill switches and per-agent tool allowlists that fail closed; `agent_webhook_configure` pushes events to external runners with HMAC-signed retries, SSRF guards, and a dead-letter queue

### Example: AI-Powered Helpdesk Triage

> A customer submits a bug report through the helpdesk portal. BigBlueBam automatically creates a `FRND-` prefixed task on the board. An AI agent picks up the new task, analyzes the description, sets priority to High, assigns it to the right engineer based on the related epic, adjusts the timeline, and posts a response to the customer: *"Thanks for reporting this — we've assigned task FRND-247 to the team and it's been prioritized. We'll update you when there's a fix."*
>
> The engineer sees the triaged card on their board. The customer sees the response in their portal. The task was created automatically; the AI handled the triage.

### Example: AI Gathering Details from Vague Reports

> A customer submits a ticket: *"The app isn't working."* BigBlueBam auto-creates a task, and an AI agent picks it up. Recognizing the report lacks actionable detail, the agent responds to the customer through the helpdesk portal:
>
> *"Sorry to hear that! To help us investigate, could you provide a few details?*
> - *What were you trying to do when the issue occurred?*
> - *What device and browser are you using? (e.g., iPhone 14 / Safari, Windows / Chrome)*
> - *Does the issue happen every time or intermittently?*
> - *If possible, a screenshot of any error message would be very helpful."*
>
> The agent sets the task to `waiting_on_customer` and adds an internal note for the engineering team: *"Vague report — asked customer for repro steps, device info, and screenshots. Will re-triage once details come in."* When the customer replies with specifics, the agent updates the task description, sets the appropriate priority, and assigns it to the right engineer — all before a human touches it.

### MCP Tools Reference

**804 tools** across the nineteen apps plus cross-cutting agentic platform surfaces:

| Category | Count | What they cover |
|----------|------:|-----------------|
| **Task Management** | 12 | CRUD, move, bulk update, duplicate, time logging, task-by-human-id, upsert-by-external-id |
| **Sprints** | 5 | CRUD, start, complete, report |
| **Projects** | 5 | List, get, create, test Slack webhook, disconnect GitHub |
| **Reports** | 8 | Velocity, burndown, CFD, cycle time, time tracking, overdue, workload, status distribution |
| **Comments** | 2 | List, add |
| **Members** | 4 | List, get my tasks, find user by name/email |
| **Bam Resolvers** | 4 | Phases, labels, states, epics |
| **Templates** | 2 | List, create from template |
| **Import** | 2 | CSV import, GitHub Issues import |
| **User Profile & Notifications** | 10 | Profile CRUD, org switching, password, logout, notification feed management |
| **User Resolver** | 3 | find_user_by_email, find_user_by_name, list_users |
| **Platform Admin** | 5 | Platform settings toggle, beta signups, public config (SuperUser-gated) |
| **Banter Messaging** | 53 | Channels, DMs, messages, threads, reactions, calls, search, scheduled posts, quiet-hours deferrals, admin, presence, preferences |
| **Banter Subscriptions** | 3 | Agent pattern-match subscribe / unsubscribe / list |
| **Beacon Knowledge Base** | 30 | CRUD, upsert-by-slug, search, verification, graph, policies, saved queries |
| **Brief Documents** | 18 | CRUD, upsert-by-slug, collaboration, versions, search, graduation, templates |
| **Bolt Automation** | 13 | Rule CRUD, execution management, templates, triggers, conditions, actions, get-by-name |
| **Bolt Observability** | 2 | bolt_event_trace, bolt_recent_events |
| **Bearing Goals** | 12 | Periods, goals, key results, progress, links, reports, at-risk detection |
| **Board Whiteboard** | 14 | Room CRUD, shapes, assets, canvas reading, participants, embeds, sticky-to-task |
| **Bond CRM** | 23 | Contacts (with upsert-by-email), companies, deals, pipeline stages, activities, notes, search, reports |
| **Blast Email Campaigns** | 14 | Campaigns, templates, segments, analytics, subject-line generation |
| **Bill Invoicing** | 16 | Invoices, line items, payments, expenses, clients, profitability, revenue summary |
| **Bench Analytics** | 11 | Dashboards, widgets, ad-hoc queries, scheduled reports, anomaly detection, period compare |
| **Book Scheduling** | 11 | Events, RSVPs, booking pages, availability (including mixed human-and-agent rosters) |
| **Blank Forms** | 11 | Forms, submissions, analytics, AI generation, response summarization |
| **Helpdesk** | 11 | Ticket operations, public/admin settings, user upsert-by-email |
| **Agent Identity** | 3 | agent_heartbeat, agent_audit, agent_self_report |
| **Agent Proposals** | 3 | proposal_create, proposal_list, proposal_decide |
| **Agent Policies** | 3 | agent_policy_get / set / list (per-agent kill switches and allowlists) |
| **Agent Webhooks** | 4 | Configure, rotate-secret, deliveries list, redeliver |
| **Visibility Preflight** | 1 | can_access |
| **Unified Activity** | 2 | activity_query, activity_by_actor |
| **Cross-App Search** | 1 | search_everything |
| **Fuzzy Entity Resolver** | 1 | resolve_references |
| **Composite Views** | 3 | account_view, project_view, user_view |
| **Entity Links** | 3 | entity_links_list / create / remove |
| **Attachments** | 2 | attachment_get, attachment_list (federated across apps) |
| **Dedupe** | 4 | bond_find_duplicates, helpdesk_find_similar_tickets, dedupe_record_decision, dedupe_list_pending |
| **Trend Queries** | 2 | helpdesk_ticket_count_by_phrase, bam_task_count_by_phrase |
| **Expertise** | 1 | expertise_for_topic (ranked across Beacon, Bam, Brief, Bond) |
| **Ingest Fingerprint** | 1 | ingest_fingerprint_check (Redis-backed intake dedup) |
| **Utility** | 2 | Server info, action confirmation (Redis-backed tokens with dynamic TTL) |

### MCP Setup

The canonical MCP endpoint is `/mcp/` on the public ingress (Streamable HTTP transport). Add this to your Claude Desktop or Claude Code configuration:

```json
{
  "mcpServers": {
    "bigbluebam": {
      "url": "http://localhost/mcp/",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

Or from the Claude Code CLI:

```sh
claude mcp add --transport http bigbluebam https://YOUR_DOMAIN/mcp/ \
  --header "Authorization: Bearer YOUR_API_KEY"
```

Generate an API key from **Settings > Integrations** in the BigBlueBam UI. For server-to-server integrations, mint a `bbam_svc_`-prefixed service-account key instead (see the Provision the internal MCP service account section below). `/mcp/health` returns a liveness JSON with no auth; see [docs/reference/mcp-server.md](docs/reference/mcp-server.md#endpoint-paths) for the full endpoint map.

---

<!-- AUTODOCS:APP_SECTIONS:START -->
### Bam (Project Management)

66 routes, 54 schemas, 123 MCP tools

<img src="docs/apps/bam/screenshots/light/01-board.png" width="400" alt="Bam (Project Management)">

[Guide](docs/apps/bam/guide.md) | [Overview](docs/apps/bam/marketing.md) | [MCP Tools](docs/apps/bam/mcp-tools.md)

### Banter (Team Messaging)

22 routes, 23 schemas, 77 MCP tools

<img src="docs/apps/banter/screenshots/light/01-channel-view.png" width="400" alt="Banter (Team Messaging)">

[Guide](docs/apps/banter/guide.md) | [Overview](docs/apps/banter/marketing.md) | [MCP Tools](docs/apps/banter/mcp-tools.md)

### Bay (Media Review)

6 routes, 6 schemas, 14 MCP tools

Media review and approval — frame/timecode/region annotations, per-reviewer decisions, token-gated public guest review links, and FBX/3D model review in a three.js viewer.

<img src="site/public/screenshots/bay/light/model-viewer.png" width="400" alt="Bay (Media Review)">

[Guide](docs/apps/bay/guide.md) | [Overview](docs/apps/bay/marketing.md) | [MCP Tools](docs/apps/bay/mcp-tools.md)

### Beacon (Knowledge Base)

9 routes, 12 schemas, 38 MCP tools

<img src="docs/apps/beacon/screenshots/light/01-knowledge-home.png" width="400" alt="Beacon (Knowledge Base)">

[Guide](docs/apps/beacon/guide.md) | [Overview](docs/apps/beacon/marketing.md) | [MCP Tools](docs/apps/beacon/mcp-tools.md)

### Bearing (Goals & OKRs)

4 routes, 9 schemas, 30 MCP tools

<img src="docs/apps/bearing/screenshots/light/01-dashboard.png" width="400" alt="Bearing (Goals & OKRs)">

[Guide](docs/apps/bearing/guide.md) | [Overview](docs/apps/bearing/marketing.md) | [MCP Tools](docs/apps/bearing/mcp-tools.md)

### Bench (Analytics)

6 routes, 7 schemas, 32 MCP tools

<img src="docs/apps/bench/screenshots/light/01-dashboard-list.png" width="400" alt="Bench (Analytics)">

[Guide](docs/apps/bench/guide.md) | [Overview](docs/apps/bench/marketing.md) | [MCP Tools](docs/apps/bench/mcp-tools.md)

### Bill (Invoicing)

9 routes, 12 schemas, 47 MCP tools

<img src="docs/apps/bill/screenshots/light/01-dashboard.png" width="400" alt="Bill (Invoicing)">

[Guide](docs/apps/bill/guide.md) | [Overview](docs/apps/bill/marketing.md) | [MCP Tools](docs/apps/bill/mcp-tools.md)

### Bin (Digital Asset Management)

4 routes, 4 schemas, 19 MCP tools

DAM / object-storage backbone plus a structured-data (CSV/JSON/YAML) grid/tree editor with live co-editing and virus scanning — the storage layer behind Bay and Blip.

<img src="site/public/screenshots/bin/light/asset-library.png" width="400" alt="Bin (Digital Asset Management)">

_(Guide coming soon.)_

### Blank (Forms)

4 routes, 5 schemas, 20 MCP tools

<img src="docs/apps/blank/screenshots/light/01-form-list.png" width="400" alt="Blank (Forms)">

[Guide](docs/apps/blank/guide.md) | [Overview](docs/apps/blank/marketing.md) | [MCP Tools](docs/apps/blank/mcp-tools.md)

### Blast (Email Campaigns)

7 routes, 9 schemas, 28 MCP tools

<img src="docs/apps/blast/screenshots/light/01-campaigns.png" width="400" alt="Blast (Email Campaigns)">

[Guide](docs/apps/blast/guide.md) | [Overview](docs/apps/blast/marketing.md) | [MCP Tools](docs/apps/blast/mcp-tools.md)

### Blip (App Telemetry)

12 routes, 12 schemas, 38 MCP tools

App telemetry and observability — bearer-token log ingest, a live log viewer, saved views with field indexing, watches/alerts, transforms, retention, timelapse, and scheduled reports.

<img src="site/public/screenshots/blip/light/live-viewer.png" width="400" alt="Blip (App Telemetry)">

[Guide](docs/apps/blip/guide.md) | [Overview](docs/apps/blip/marketing.md) | [MCP Tools](docs/apps/blip/mcp-tools.md)

### Blueprint

6 routes, 11 schemas, 37 MCP tools

<img src="docs/apps/blueprint/screenshots/light/01-diagram-list.png" width="400" alt="Blueprint">

[Guide](docs/apps/blueprint/guide.md) | [Overview](docs/apps/blueprint/marketing.md) | [MCP Tools](docs/apps/blueprint/mcp-tools.md)

### Board (Visual Collaboration)

9 routes, 11 schemas, 40 MCP tools

<img src="docs/apps/board/screenshots/light/01-all-boards.png" width="400" alt="Board (Visual Collaboration)">

[Guide](docs/apps/board/guide.md) | [Overview](docs/apps/board/marketing.md) | [MCP Tools](docs/apps/board/mcp-tools.md)

### Bolt (Workflow Automation)

7 routes, 10 schemas, 24 MCP tools

<img src="docs/apps/bolt/screenshots/light/01-automations.png" width="400" alt="Bolt (Workflow Automation)">

[Guide](docs/apps/bolt/guide.md) | [Overview](docs/apps/bolt/marketing.md) | [MCP Tools](docs/apps/bolt/mcp-tools.md)

### Bond (CRM)

13 routes, 16 schemas, 69 MCP tools

<img src="docs/apps/bond/screenshots/light/01-pipeline-board.png" width="400" alt="Bond (CRM)">

[Guide](docs/apps/bond/guide.md) | [Overview](docs/apps/bond/marketing.md) | [MCP Tools](docs/apps/bond/mcp-tools.md)

### Book (Scheduling)

9 routes, 10 schemas, 25 MCP tools

<img src="docs/apps/book/screenshots/light/01-week-view.png" width="400" alt="Book (Scheduling)">

[Guide](docs/apps/book/guide.md) | [Overview](docs/apps/book/marketing.md) | [MCP Tools](docs/apps/book/mcp-tools.md)

### Brief (Documents)

10 routes, 10 schemas, 48 MCP tools

<img src="docs/apps/brief/screenshots/light/01-home.png" width="400" alt="Brief (Documents)">

[Guide](docs/apps/brief/guide.md) | [Overview](docs/apps/brief/marketing.md) | [MCP Tools](docs/apps/brief/mcp-tools.md)

### Bureau

15 routes, 4 schemas, 38 MCP tools

<img src="docs/apps/bureau/screenshots/light/01-floor-directory.png" width="400" alt="Bureau">

[Guide](docs/apps/bureau/guide.md) | [Overview](docs/apps/bureau/marketing.md) | [MCP Tools](docs/apps/bureau/mcp-tools.md)

### Helpdesk (Support Portal)

10 routes, 13 schemas, 11 MCP tools

<img src="docs/apps/helpdesk/screenshots/light/01-portal-entry.png" width="400" alt="Helpdesk (Support Portal)">

[Guide](docs/apps/helpdesk/guide.md) | [Overview](docs/apps/helpdesk/marketing.md) | [MCP Tools](docs/apps/helpdesk/mcp-tools.md)

### Introduction to BigBlueBam

An overview of the whole suite: the nineteen apps, how they connect, and how AI agents work alongside your team.

[Guide](docs/apps/introduction/guide.md) | [Overview](docs/apps/introduction/marketing.md)
<!-- AUTODOCS:APP_SECTIONS:END -->
---

## AI Provider Configuration

BigBlueBam features a hierarchical LLM provider configuration system that powers AI features across the suite — including Bolt's AI-assisted automation authoring, future summarization, and content generation features.

### How It Works

Providers are configured at three levels, with the most specific taking precedence:

| Scope | Who Configures | Applies To |
|-------|---------------|-----------|
| **System** | SuperUser | All organizations (fallback default) |
| **Organization** | Org Admin/Owner | All projects in the org |
| **Project** | Project Admin | Only that project |

### Supported Providers

| Provider | Type | Notes |
|----------|------|-------|
| **Anthropic** | `anthropic` | Claude models. Uses default API endpoint. |
| **OpenAI** | `openai` | GPT models. Uses default API endpoint. |
| **OpenAI-Compatible** | `openai_compatible` | Any endpoint implementing the OpenAI Chat Completions API — Azure OpenAI, Together AI, Ollama, vLLM, local LLMs, etc. Requires custom `api_endpoint`. |

### Security

- API keys are **encrypted at rest** using AES-256-GCM with the server's `SESSION_SECRET`
- Keys are **never returned in full** — always redacted to `sk-•••XXXX` (last 4 characters only)
- Scope-based authorization ensures only the right roles can configure each level
- Test Connection verifies credentials work before saving

### Setup

Configure providers in **Settings → AI Providers** in the Bam frontend. If no provider is configured, AI-dependent features (like Bolt's "Describe your automation" dialog) show a helpful message directing admins to the setup page.

---

## Quick Start

> **📖 Full deployment guide:** [docs/guides/deployment.md](docs/guides/deployment.md) — step-by-step walkthrough with interactive setup wizard, password generation, platform selection (Docker Compose for self-hosted; Railway for managed cloud — both fully automated), and tier progression from single-machine to Kubernetes.

### Guided Setup (Recommended)

The interactive deploy script handles everything — installs dependencies, generates secrets, provisions infrastructure, and creates your admin account:

```bash
git clone https://github.com/eoffermann/BigBlueBam.git
cd BigBlueBam

# Linux / macOS
./scripts/deploy.sh

# Windows (PowerShell)
.\scripts\deploy.ps1
```

### Manual Setup with Docker Compose

If you prefer to set things up manually:

```bash
# Clone the repo
git clone https://github.com/eoffermann/BigBlueBam.git
cd BigBlueBam

# Set up environment
cp .env.example .env
# Edit .env with your secrets (passwords, session secret)

# Start all services
docker compose up -d

# Create your admin account
docker compose exec api node dist/cli.js create-admin \
  --email admin@example.com \
  --password YourPassword123 \
  --name "Admin User" \
  --org "My Organization"
```

#### Provision the internal MCP service account

Bolt automations and the background worker invoke MCP tools over an internal HTTP path (`POST /mcp/tools/call`) instead of holding a persistent MCP session. That path is authenticated two ways: a shared secret (`INTERNAL_SERVICE_SECRET`, already generated by `cp .env.example .env` or the deploy script) plus a bearer token tied to a dedicated service-account user that `mcp-server` uses to talk to the rest of the stack on behalf of internal callers.

If `MCP_INTERNAL_API_TOKEN` is blank in your `.env`, `mcp-server` still boots and external MCP clients (Claude Desktop, Claude Code) work fine — but every call to `POST /mcp/tools/call` returns HTTP 503 with `INTERNAL_NOT_CONFIGURED`, which means **Bolt automations that invoke MCP tools will fail** and any worker job relying on the internal path won't be able to call MCP tools either. For a self-hosted single-operator setup you can leave it blank; for anything that needs Bolt-to-MCP integration, provision the token once:

```bash
# 1. Mint a service account + API key (prefix bbam_svc_). The --org-slug
#    is the one you created with create-admin above; slugify() lowercases
#    and hyphenates the --org value (e.g. "My Organization" becomes
#    "my-organization"). Run `docker compose exec api node dist/cli.js list-orgs`
#    if you're not sure.
docker compose exec api node dist/cli.js create-service-account \
  --name mcp-internal \
  --org-slug my-organization

# 2. The command prints a token once:
#       Token:      bbam_svc_abcdef0123456789...
#    Copy that value (not the command output around it) and paste it into .env:
#       MCP_INTERNAL_API_TOKEN=bbam_svc_abcdef0123456789...

# 3. Restart mcp-server so it picks up the new env var.
docker compose up -d --force-recreate mcp-server
```

You only need to do this once per stack. If you wipe the postgres volume you will need to re-mint the token because the service-account user lives in the database. The token is not rotated automatically; to rotate, mint a new service account with a different `--name`, swap the env var, restart, then delete the old service-account user via `docker compose exec api node dist/cli.js revoke-api-key --prefix bbam_svc`.

Open **http://localhost/b3/** to access BigBlueBam, **http://localhost/banter/** for Banter, **http://localhost/beacon/** for Beacon, **http://localhost/brief/** for Brief, **http://localhost/bolt/** for Bolt, **http://localhost/bearing/** for Bearing, **http://localhost/board/** for Board, **http://localhost/bond/** for Bond CRM, or **http://localhost/helpdesk/** for the helpdesk portal.

<p align="center">
  <img src="images/01-login.png" alt="Login Page" width="60%" />
</p>
<p align="center"><em>The login page — clean and branded.</em></p>

After login, you land on the project dashboard:

<p align="center">
  <img src="images/02-dashboard.png" alt="Project Dashboard" width="100%" />
</p>

### Services

All services are accessed through a single nginx container on port 80:

| URL Path | Backend | Description |
|----------|---------|-------------|
| `/` | redirect | Redirects to `/helpdesk/` |
| `/b3/` | nginx | Bam React SPA |
| `/b3/api/` | Fastify `:4000` | Bam REST API |
| `/b3/ws` | Fastify `:4000` | WebSocket (real-time updates) |
| `/banter/` | nginx | Banter team messaging SPA |
| `/banter/api/` | Fastify `:4002` | Banter REST API |
| `/banter/ws` | Fastify `:4002` | Banter WebSocket (real-time messaging) |
| `/helpdesk/` | nginx | Helpdesk portal SPA |
| `/helpdesk/api/` | Fastify `:4001` | Helpdesk API (auth, tickets, messages) |
| `/files/` | MinIO `:9000` | Uploaded files (shared) |
| `/beacon/` | nginx | Beacon knowledge base SPA |
| `/beacon/api/` | Fastify `:4004` | Beacon REST API |
| `/brief/` | nginx | Brief collaborative document editor SPA |
| `/brief/api/` | Fastify `:4005` | Brief REST API |
| `/brief/ws` | Fastify `:4005` | Brief WebSocket (real-time co-editing) |
| `/bolt/` | nginx | Bolt workflow automation SPA |
| `/bolt/api/` | Fastify `:4006` | Bolt REST API |
| `/bearing/` | nginx | Bearing Goals & OKRs SPA |
| `/bearing/api/` | Fastify `:4007` | Bearing REST API |
| `/board/` | nginx | Board visual collaboration SPA |
| `/board/api/` | Fastify `:4008` | Board REST API |
| `/board/ws` | Fastify `:4008` | Board WebSocket (real-time canvas sync) |
| `/bond/` | nginx | Bond CRM SPA |
| `/bond/api/` | Fastify `:4009` | Bond REST API |
| `/mcp/` | MCP Server `:3001` | Model Context Protocol (804 tools) |

Infrastructure services (internal, not exposed via nginx):

| Service | Port | Description |
|---------|------|-------------|
| PostgreSQL | `:5432` | Primary database |
| Redis | `:6379` | Cache, PubSub, queues |
| MinIO | `:9000` | S3-compatible file storage |
| Worker | -- | BullMQ background job processor |
| LiveKit | `:7880` | Voice/video SFU (WebRTC media server) |
| Beacon API | `:4004` | Beacon knowledge base REST API |
| Qdrant | `:6333` | Vector search engine (semantic embeddings) |
| Voice Agent | `:4003` | AI voice call participation (Python/FastAPI) |

### Development Mode

```bash
pnpm install
pnpm --filter @bigbluebam/shared build
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

### Run Tests

```bash
pnpm test  # 900+ tests across all packages
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                       Clients (Browser / AI)                         │
└────────────────────────┬──────────────────────┬──────────────────────┘
                         │ HTTP :80              │ WebRTC
┌────────────────────────▼──────────────────────┐│
│               nginx (single container, :80)    ││
│  /b3/          → Bam SPA (static)               ││
│  /b3/api/      → Fastify API :4000             ││
│  /b3/ws        → WebSocket :4000               ││
│  /banter/      → Banter SPA (static)           ││
│  /banter/api/  → Banter API :4002              ││
│  /banter/ws    → Banter WebSocket :4002        ││
│  /beacon/      → Beacon SPA (static)           ││
│  /beacon/api/  → Beacon API :4004              ││
│  /brief/       → Brief SPA (static)            ││
│  /brief/api/   → Brief API :4005               ││
│  /brief/ws     → Brief WebSocket :4005         ││
│  /bolt/        → Bolt SPA (static)             ││
│  /bolt/api/    → Bolt API :4006                ││
│  /bearing/     → Bearing SPA (static)          ││
│  /bearing/api/ → Bearing API :4007             ││
│  /board/       → Board SPA (static)            ││
│  /board/api/   → Board API :4008               ││
│  /board/ws     → Board WebSocket :4008         ││
│  /bond/        → Bond SPA (static)             ││
│  /bond/api/    → Bond API :4009                ││
│  /helpdesk/    → Helpdesk SPA (static)         ││
│  /helpdesk/api/→ Helpdesk API :4001            ││
│  /files/       → MinIO :9000                   ││
│  /mcp/         → MCP Server :3001              ││
└──────┬──────────┬──────────┬───────────────────┘│
       │          │          │                     │
┌──────▼────┐ ┌──▼───────┐ ┌▼──────────┐ ┌──────────┐ ┌───────▼──────┐ ┌──────────┐
│ Bam API   │ │ Banter   │ │ MCP Server│ │ Brief    │ │ Bolt API │ │ LiveKit SFU  │ │ Worker   │
│ :4000     │ │ API :4002│ │ :3001     │ │ API :4005│ │ :4006    │ │ :7880 (voice)│ │ BullMQ   │
│ +WebSocket│ │ +WS      │ │ 804 tools │ │ +WS      │ │          │ │ +voice-agent │ │ jobs     │
└─────┬─────┘ └────┬─────┘ └─────┬─────┘ └────┬─────┘ └──────────────┘ └────┬─────┘
      │             │             │            │                  │
┌─────▼─────────────▼─────────────▼────────────▼───────────────────▼───┐
│  PostgreSQL 16  │  Redis 7        │  MinIO (S3)   │  Qdrant (vectors)    │
│  40+ tables     │  PubSub + cache │  File storage │  Semantic search     │
└──────────────────────┴──────────────────────┴────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, TailwindCSS v4, Motion, TanStack Query, Zustand, dnd-kit, Radix UI |
| **API** | Node.js 22, Fastify v5, Drizzle ORM, Zod |
| **Realtime** | WebSocket + Redis PubSub |
| **MCP** | @modelcontextprotocol/sdk (Streamable HTTP + SSE) |
| **Voice/Video** | LiveKit SFU, WebRTC, Python voice agent (STT/TTS) |
| **Database** | PostgreSQL 16, Redis 7, MinIO, Qdrant |
| **Worker** | BullMQ, Nodemailer |
| **Build** | Turborepo, pnpm workspaces, tsup, Vite |
| **Testing** | Vitest (900+ tests) |
| **Deploy** | Docker Compose, multi-stage Dockerfiles |

### Monorepo Structure

```
apps/
  api/              → Bam Fastify REST API + WebSocket (project management core)
  frontend/         → Every React SPA under one container
  mcp-server/       → MCP protocol server (804 tools, Redis-backed confirm tokens)
  worker/           → BullMQ background jobs (emails, notifications, scheduled Banter posts, webhook dispatch + DLQ)
  helpdesk-api/     → Helpdesk Fastify API (tickets, messages, similar-tickets lookup, user upsert)
  banter-api/       → Banter Fastify API + WebSocket (channels, threads, calls, quiet hours, scheduled posts, agent subscriptions)
  beacon-api/       → Beacon Fastify API (knowledge base, search, graph, policies, upsert-by-slug)
  brief-api/        → Brief Fastify REST API + WebSocket (collaborative docs with upsert-by-slug)
  bolt-api/         → Bolt Fastify REST API (workflow automation, rules, executions, event trace, drift detection)
  bearing-api/      → Bearing Fastify REST API (goals, key results, progress, reporting)
  board-api/        → Board Fastify REST API + WebSocket (whiteboard rooms, shapes, conferencing)
  bond-api/         → Bond Fastify REST API (CRM with upsert-by-email and dedupe primitives)
  blast-api/        → Blast Fastify REST API (email campaigns, templates, segments, analytics)
  bench-api/        → Bench Fastify REST API (analytics dashboards, ad-hoc queries, scheduled reports)
  book-api/         → Book Fastify REST API (scheduling with mixed human/agent availability)
  blank-api/        → Blank Fastify REST API (forms, submissions, conditional routing)
  bill-api/         → Bill Fastify REST API (invoicing, expenses, PDF generation, recurring billing)
  voice-agent/      → AI voice agent (Python/FastAPI, LiveKit Agents SDK)
  integration-tests/→ Cross-app integration harness (Vitest + mock service clients)
  e2e/              → Playwright end-to-end suite
packages/
  shared/           → Zod schemas, TypeScript types, mention-syntax, publishBoltEvent helper
  ui/               → Shared React component library
  logging/          → Pino-based structured logger shared across services
  service-health/   → /healthz + /readyz Fastify plugin
  db-stubs/         → Drizzle stubs and test bootstraps
  livekit-tokens/   → LiveKit access-token minting
infra/
  postgres/         → 187 idempotent numbered migrations (tip 0225)
  nginx/            → Reverse proxy config (single nginx serves every SPA)
  livekit/          → LiveKit SFU configuration
  helm/             → Kubernetes Helm chart
docs/               → Hand-authored plus generated per-app docs
scripts/            → Deploy adapters, seeders, drift guards, screenshot generators
site/               → Marketing site (served at /)
```

### Key Numbers

| Metric | Count |
|--------|-------|
| Apps | 19 (Bam, Banter, Bay, Beacon, Bearing, Bench, Bill, Bin, Blank, Blast, Blip, Blueprint, Board, Bolt, Bond, Book, Brief, Bureau, Helpdesk) |
| MCP tools | 804 across 49 modules (123 Bam + 77 Banter + 69 Bond + 48 Brief + 47 Bill + 40 Board + 38 Beacon + 38 Blip + 38 Bureau + 37 Blueprint + 32 Bench + 30 Bearing + 28 Blast + 25 Book + 24 Bolt + 20 Blank + 19 Bin + 14 Bay + 11 Helpdesk + 46 cross-cutting platform) |
| Bolt event catalog | 122 registered events across app and platform sources |
| Test cases | 900+ |
| Migrations | 187 (tip 0225, additive + idempotent) |

---

## Documentation
<!-- AUTODOCS:DOCS_INDEX:START -->

| Document | Description |
|----------|-------------|
| [Getting Started](docs/guides/getting-started.md) | Setup, first run, troubleshooting |
| [Deployment](docs/guides/deployment.md) | Quickstart wizard, tiers, scaling, Docker Compose + Railway |
| [Operations](docs/guides/operations.md) | Updates, backups, maintenance, troubleshooting |
| [Development](docs/guides/development.md) | Contributing, testing, code style, monorepo workflow |
| [Architecture](docs/reference/architecture.md) | System design, data flow, components |
| [Database](docs/reference/database.md) | ER diagrams, table descriptions, indexing |
| [API Reference](docs/reference/api-reference.md) | All REST endpoints with examples |
| [MCP Server](docs/reference/mcp-server.md) | Tools, resources, prompts, configuration |
| [Permissions](docs/reference/permissions.md) | Permission model, roles, scoping |
| [Agent Conventions](docs/reference/agent-conventions.md) | Rules agents must follow (visibility preflight, audit) |
| | |
| **Per-App Guides** | |
| [Bam (Project Management) Guide](docs/apps/bam/guide.md) | User guide and MCP tool reference |
| [Banter (Team Messaging) Guide](docs/apps/banter/guide.md) | User guide and MCP tool reference |
| [Beacon (Knowledge Base) Guide](docs/apps/beacon/guide.md) | User guide and MCP tool reference |
| [Bearing (Goals & OKRs) Guide](docs/apps/bearing/guide.md) | User guide and MCP tool reference |
| [Bench (Analytics) Guide](docs/apps/bench/guide.md) | User guide and MCP tool reference |
| [Bill (Invoicing) Guide](docs/apps/bill/guide.md) | User guide and MCP tool reference |
| [Blank (Forms) Guide](docs/apps/blank/guide.md) | User guide and MCP tool reference |
| [Blast (Email Campaigns) Guide](docs/apps/blast/guide.md) | User guide and MCP tool reference |
| [Blueprint Guide](docs/apps/blueprint/guide.md) | User guide and MCP tool reference |
| [Board (Visual Collaboration) Guide](docs/apps/board/guide.md) | User guide and MCP tool reference |
| [Bolt (Workflow Automation) Guide](docs/apps/bolt/guide.md) | User guide and MCP tool reference |
| [Bond (CRM) Guide](docs/apps/bond/guide.md) | User guide and MCP tool reference |
| [Book (Scheduling) Guide](docs/apps/book/guide.md) | User guide and MCP tool reference |
| [Brief (Documents) Guide](docs/apps/brief/guide.md) | User guide and MCP tool reference |
| [Bureau Guide](docs/apps/bureau/guide.md) | User guide and MCP tool reference |
| [Helpdesk (Support Portal) Guide](docs/apps/helpdesk/guide.md) | User guide and MCP tool reference |
| [Introduction to BigBlueBam Guide](docs/apps/introduction/guide.md) | User guide and MCP tool reference |

<!-- AUTODOCS:DOCS_INDEX:END -->
---

## License

MIT -- see [LICENSE](LICENSE).

---

<p align="center">
  Built with <a href="https://claude.ai/code">Claude Code</a>
</p>
