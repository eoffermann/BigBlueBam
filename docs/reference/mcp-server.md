# MCP Server Documentation

BigBlueBam exposes a **Model Context Protocol (MCP)** server, enabling any MCP-compatible AI client to interact with project data through structured tool calls. The MCP server is a first-class citizen of the architecture, not a bolt-on.

**340 tools across 43 modules.** High-level split: 54 Bam core, 53 Banter, 30 Beacon, 23 Bond, 18 Brief, 16 Bill, 14 Board, 14 Blast, 13 Bolt, 12 Bearing, 11 Helpdesk, 11 Book, 11 Blank, 11 Bench, and 49 cross-cutting platform surfaces (agent identity/audit/heartbeat, proposals, visibility preflight, unified activity, cross-app search, fuzzy resolver, composite views, entity links, attachments, agent policies, outbound webhooks, Bolt observability, dedupe, phrase counts, expertise, pattern subscriptions, mixed availability, ingest fingerprint). See [Available Tools](#available-tools-340-total) below for a module-by-module listing of every registered tool.

---

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io) is an open standard for connecting AI assistants to external tools and data sources. MCP provides a structured way for AI clients (Claude Desktop, Claude Code, IDE extensions, custom agents) to:

- **Call tools** -- execute actions like creating tasks, moving cards, or closing sprints
- **Read resources** -- pull project data into the AI's context window
- **Use prompts** -- leverage pre-built prompt templates for common workflows

BigBlueBam's MCP server means you can manage your projects through natural language conversation with an AI assistant.

---

## Architecture

```mermaid
graph LR
    subgraph "AI Clients"
        Claude["Claude Desktop"]
        Code["Claude Code"]
        IDE["IDE Extension"]
        Agent["Custom Agent"]
    end

    subgraph "BigBlueBam MCP Server (proxied at /mcp/)"
        Transport["Transport Layer<br/>(Streamable HTTP / SSE / stdio)"]
        Auth["Auth Middleware<br/>(API key validation)"]
        Rate["Rate Limiter"]
        Audit["Audit Logger"]
        Tools["Tool Registry<br/>(340 tools across 43 modules)"]
        Resources["Resource Registry<br/>(Bam + Banter resources)"]
        Prompts["Prompt Registry<br/>(8 prompts)"]
    end

    subgraph "BigBlueBam Core"
        API["API Server (:4000)"]
        BanterAPI["Banter API (:4002)"]
        BeaconAPI["Beacon API (:4004)"]
        DB["PostgreSQL"]
        Redis["Redis"]
        Qdrant["Qdrant (vectors)"]
    end

    Claude -->|"SSE / HTTP"| Transport
    Code -->|"stdio / HTTP"| Transport
    IDE -->|"SSE"| Transport
    Agent -->|"HTTP"| Transport

    Transport --> Auth
    Auth --> Rate
    Rate --> Tools
    Rate --> Resources
    Rate --> Prompts

    Tools -->|"Internal HTTP"| API
    Tools -->|"Internal HTTP"| BanterAPI
    Tools -->|"Internal HTTP"| BeaconAPI
    Resources -->|"Internal HTTP"| API
    Resources -->|"Internal HTTP"| BanterAPI
    Prompts -->|"Internal HTTP"| API
    Prompts -->|"Internal HTTP"| BanterAPI
    Audit -->|"Log"| Redis
    API --> DB
    BanterAPI --> DB
    BeaconAPI --> DB
    BeaconAPI --> Qdrant
```

### Transport Options

| Transport | Use Case | Configuration |
|---|---|---|
| **Streamable HTTP** | Cloud deployments, remote clients | Primary, recommended |
| **SSE** | Backward compatibility, web-based clients | Supported |
| **stdio** | Local CLI/IDE integrations, Docker exec | Available |

### SDK

Built with the official `@modelcontextprotocol/sdk` TypeScript package. Runs as a sidecar Docker container on internal port 3001, exposed externally at `/mcp/` through the shared nginx reverse proxy on port 80. Communicates with the API server over the internal Docker network.

### Endpoint paths

The canonical MCP endpoint for an MCP client is the `/mcp/` path on the public ingress. `/mcp` (no trailing slash) is also accepted. Other paths on the `/mcp/` prefix are reserved for out-of-band operational surfaces:

| External path | Upstream path | Purpose |
|---|---|---|
| `https://DOMAIN/mcp/` or `/mcp` | `/mcp` | **Primary MCP endpoint** — Streamable HTTP transport. POST for client→server requests; GET for server→client SSE notifications on an established session; DELETE to terminate. Use this URL in Claude Desktop / Claude Code / any MCP client config. |
| `https://DOMAIN/mcp/health` | `/health` | Liveness probe. Returns `{"status":"ok","server":"BigBlueBam MCP","version":"..."}`. No auth. |
| `https://DOMAIN/mcp/sse` | `/sse` | SSE transport connection (only active when `MCP_TRANSPORT=sse`; the default is `streamable-http` and this route returns 404). |
| `https://DOMAIN/mcp/messages` | `/messages` | SSE transport POST endpoint for client→server messages (only active when `MCP_TRANSPORT=sse`). |
| `https://DOMAIN/mcp/tools/call` | `/tools/call` | Internal shared-secret direct-invocation route for service-to-service callers (bolt-api, worker, api). Not for external MCP clients — use `/mcp/` for that. |

Configured in `infra/nginx/nginx-with-site.conf` (docker-compose) and `infra/nginx/nginx.conf` (baked-in fallback); the Railway flavor `infra/nginx/nginx.railway.conf` is auto-generated from the former. The routing matches `apps/mcp-server/src/server.ts`.

---

## Authentication

### API Key Authentication

The primary authentication method. Clients include their BigBlueBam API key in the initial HTTP request:

```
Authorization: Bearer bbam_your_api_key_here
```

API keys are prefixed `bbam_`, stored as Argon2id hashes, and scoped to `read`, `read_write`, or `admin` with optional project restriction.

The API key's scope determines available tools:

| Scope | Available Tools |
|---|---|
| `read` | All query/list tools only |
| `read_write` | All tools except configuration changes |
| `admin` | All tools including project configuration |

### OAuth 2.1 Flow

For cloud-hosted MCP endpoints, the server supports OAuth 2.1 with PKCE per the MCP specification:

```mermaid
sequenceDiagram
    participant Client as AI Client
    participant MCP as MCP Server
    participant Auth as Auth Server

    Client->>MCP: Initial connection (no token)
    MCP-->>Client: 401 + OAuth metadata URL
    Client->>Auth: Authorization request (PKCE)
    Auth-->>Client: Authorization code
    Client->>Auth: Token exchange (code + verifier)
    Auth-->>Client: Access token
    Client->>MCP: Reconnect with Bearer token
    MCP->>MCP: Validate token, establish session
    MCP-->>Client: Session ready
```

### Security Properties

| Property | Implementation |
|---|---|
| **Session binding** | Each MCP session is bound to a single authenticated user. All tool calls use that user's permissions. |
| **Input validation** | Every tool input is validated against a Zod schema before execution. |
| **Output sanitization** | Responses are stripped of internal IDs, stack traces, and infrastructure details. |
| **Rate limiting** | Shared pool with REST API. MCP calls count against the same per-user and per-org limits. |
| **Audit logging** | Every tool invocation is logged to `activity_log` with action prefixed `mcp.` for traceability. |
| **Destructive action confirmation** | Tools that delete, close, or remove require a two-step confirmation with time-limited action tokens. |

---

## Available Tools (340 total)

340 tools are registered across 43 modules. The breakdown below is generated from the live registrations in `apps/mcp-server/src/tools/*.ts`; it maps each source module to the tools it registers and groups those modules into product-facing categories. When the source is ambiguous, this document is authoritative over any per-app design spec.

### Bam Core (54 tools)

The original Kanban / sprint / task surface. Core project, board, sprint, task, comment, member, template, import, and reporting tools, plus identity/auth and Bam-specific resolvers.

#### `project-tools.ts` (5)

| Tool | Description |
|---|---|
| `list_projects` | List all projects the current user has access to |
| `get_project` | Get detailed information about a specific project |
| `create_project` | Create a new project |
| `test_slack_webhook` | Send a test message to the Slack webhook configured for a project. Requires project admin or org admin role. |
| `disconnect_github_integration` | Remove the GitHub integration from a project. This is destructive — it deletes the webhook config and all linked commit/PR references. Requires project admin or org admin role. |

#### `sprint-tools.ts` (5)

| Tool | Description |
|---|---|
| `list_sprints` | List all sprints for a project |
| `create_sprint` | Create a new sprint for a project |
| `start_sprint` | Start a planned sprint |
| `complete_sprint` | Complete an active sprint |
| `get_sprint_report` | Get a sprint report with velocity, completion stats, and burndown data |

#### `task-tools.ts` (12)

| Tool | Description |
|---|---|
| `search_tasks` | Search and filter tasks in a project |
| `get_task` | Get detailed information about a specific task |
| `bam_get_task_by_human_id` | Look up a task by its human-readable reference (e.g. 'FRND-42'). The prefix is case-insensitive. Returns the task's id, project_id, human_id, and title. Useful when a prompt or rule refers to a task by its ticket number rather than UUID. |
| `create_task` | Create a new task in a project. Accepts natural identifiers (project name, phase name, sprint name, label name, user email) in addition to UUIDs. |
| `update_task` | Update an existing task. Accepts natural identifiers for task, assignee, state, and sprint in addition to UUIDs. |
| `move_task` | Move a task to a different phase and/or position on the board. Accepts natural identifiers for task and phase. |
| `delete_task` | Delete a task (destructive action - will ask for confirmation) |
| `bulk_update_tasks` | Perform a bulk operation on multiple tasks at once. Each task_ids entry may be a UUID or a human_id (e.g. FRND-42). |
| `log_time` | Log time spent on a task |
| `duplicate_task` | Duplicate an existing task, optionally including its subtasks |
| `import_csv` | Import tasks from CSV data into a project |
| `task_upsert_by_external_id` | Idempotent create-or-update of a task by (project_id, external_id). Natural key is the partial unique index on (project_id, external_id). On insert, allocates a new human_id and accepts the full create payload. On update, patches the supplied fields; human_id is preserved. Returns { data, created, idempotency_key } — `created` is true on insert, false on update. |

#### `comment-tools.ts` (2)

| Tool | Description |
|---|---|
| `list_comments` | List all comments on a task |
| `add_comment` | Add a comment to a task. Accepts either a task UUID or human_id (e.g. 'FRND-42'). |

#### `member-tools.ts` (4)

| Tool | Description |
|---|---|
| `list_members` | List members of a project or the entire organization |
| `get_my_tasks` | Get tasks assigned to the current authenticated user, optionally filtered by project |
| `bam_find_user_by_email` | Find a user by their exact email address (case-insensitive, scoped to the caller's active org). Returns the user `{ id, email, name, display_name, avatar_url }` or null when no match. |
| `bam_find_user` | Fuzzy-search users by display name or email (scoped to the caller's active org). Results are ranked by relevance and capped at 20. |

#### `bam-resolver-tools.ts` (4)

| Tool | Description |
|---|---|
| `bam_list_phases` | List all phases (board columns) for a project, ordered by position |
| `bam_list_labels` | List labels. If project_id is given, lists labels for that project; otherwise lists labels for every project the caller can see in their org. |
| `bam_list_states` | List all task states for a project, ordered by position. Each state has a category in { todo, active, blocked, review, done, cancelled }. |
| `bam_list_epics` | List all epics for a project, with task counts and status. |

#### `template-tools.ts` (2)

| Tool | Description |
|---|---|
| `list_templates` | List available task templates for a project. Accepts project name or UUID. |
| `create_from_template` | Create a task from a template, optionally overriding specific fields. Accepts project name and template name in addition to UUIDs. |

#### `import-tools.ts` (2)

| Tool | Description |
|---|---|
| `import_github_issues` | Import GitHub issues into a project as tasks |
| `suggest_branch_name` | Generate a git branch name suggestion based on a task. Fetches the task and returns a name like "feature/FRND-42-design-login-screen". |

#### `report-tools.ts` (8)

| Tool | Description |
|---|---|
| `get_velocity_report` | Get velocity report showing story points completed across recent sprints |
| `get_burndown` | Get burndown chart data for a specific sprint |
| `get_cumulative_flow` | Get cumulative flow diagram data for a project over a date range |
| `get_overdue_tasks` | Get a report of all overdue tasks in a project |
| `get_workload` | Get workload distribution report showing task counts and story points per team member |
| `get_status_distribution` | Get status distribution report showing task counts per phase/status |
| `get_cycle_time_report` | Get cycle time metrics (created_at → completed_at) for completed tasks in a project. |
| `get_time_tracking_report` | Get aggregated time entries per user for a project, optionally bounded by a date range. |

#### `me-tools.ts` (10)

| Tool | Description |
|---|---|
| `get_me` | Get the authenticated user profile (display name, email, avatar, timezone, notification preferences, active org, superuser flag). |
| `update_me` | Update the authenticated user's own profile fields. |
| `list_my_orgs` | List organizations the authenticated user is a member of, including role in each. |
| `switch_active_org` | Switch the active organization for the current session. Affects which projects/members/tickets are returned by downstream calls. |
| `change_my_password` | Change the authenticated user's password. Requires the current password. |
| `logout` | Invalidate the current session cookie. Note: API-key callers are not affected — this only logs out cookie sessions. |
| `list_my_notifications` | Fetch the caller's notification feed (paginated, cursor-based). |
| `mark_notification_read` | Mark a single notification as read. |
| `mark_notifications_read` | Mark several notifications as read in one call. |
| `mark_all_notifications_read` | Mark every notification in the caller's feed as read. |

### Banter (53 tools)

Team messaging: channels, DMs, messages, threads, reactions, calls, user groups, presence, scheduled posts, quiet hours, and rich embeds.

#### `banter-tools.ts` (53)

| Tool | Description |
|---|---|
| `banter_list_channels` | List all Banter channels the current user has access to |
| `banter_get_channel` | Get detailed information about a Banter channel |
| `banter_get_channel_by_name` | Resolve a Banter channel by name or handle. Accepts "general", "#general", or a slug. Returns the channel {id, name, handle, type, description} or null if not found. |
| `banter_create_channel` | Create a new Banter channel |
| `banter_update_channel` | Update a Banter channel name, description, or topic |
| `banter_archive_channel` | Archive a Banter channel (reversible). Accepts a channel UUID, a bare channel name, or #name — no need to resolve the id first. |
| `banter_delete_channel` | Delete a Banter channel (destructive - requires confirmation) |
| `banter_join_channel` | Join a Banter channel. Accepts a channel UUID, a bare channel name, or #name. |
| `banter_leave_channel` | Leave a Banter channel |
| `banter_add_channel_members` | Add one or more members to a Banter channel. Accepts a channel UUID, name, or #name, and each user may be a UUID, email, or @handle — mixed lists are supported. |
| `banter_remove_channel_member` | Remove a member from a Banter channel |
| `banter_list_messages` | List messages in a Banter channel with pagination |
| `banter_get_message` | Get a specific Banter message by ID |
| `banter_post_message` | Post a new message to a Banter channel. Accepts a channel UUID, a bare channel name, or #name. §13 Wave 4: optionally accepts scheduled_at (ISO-8601, max 30 days out), defer_if_quiet (convert to scheduled if channel is in quiet hours), and urgency_override (bypass quiet hours when both caller and channel policy consent). When a post is scheduled or deferred, the tool returns a scheduled envelope ({ scheduled: true, scheduled_message_id, scheduled_at, defer_reason }) instead of an immediate message. |
| `banter_schedule_post` | Schedule a Banter post for future delivery. Thin wrapper over banter_post_message with scheduled_at REQUIRED. Returns the scheduled envelope { scheduled: true, scheduled_message_id, scheduled_at, defer_reason }. If respect_quiet_hours is true (default) the scheduled_at is honored as-is; if the channel is in quiet hours at fire time, the worker still delivers because scheduled posts are explicit. Use defer_if_quiet on banter_post_message to instead reschedule around a quiet-hours window at request time. |
| `banter_edit_message` | Edit an existing Banter message |
| `banter_delete_message` | Delete a Banter message (destructive - requires confirmation) |
| `banter_react` | Add or remove an emoji reaction on a Banter message |
| `banter_pin_message` | Pin a message in a Banter channel. Accepts a channel UUID, name, or #name. |
| `banter_unpin_message` | Unpin a message from a Banter channel. Accepts a channel UUID, name, or #name. |
| `banter_list_thread_replies` | List replies in a Banter message thread |
| `banter_reply_to_thread` | Post a reply in a Banter message thread |
| `banter_search_messages` | Search messages across Banter channels |
| `banter_browse_channels` | Browse available Banter channels (including unjoined public channels) |
| `banter_search_transcripts` | Search call transcripts across Banter (placeholder - returns available transcripts) |
| `banter_send_dm` | Send a direct message to another user (creates or reuses existing DM channel). Accepts a user UUID, email address, or @handle. |
| `banter_send_group_dm` | Send a group direct message (creates or reuses existing group DM). Each recipient may be a UUID, email, or @handle — mixed lists are supported. |
| `banter_find_user_by_email` | Find a Banter user by email (case-insensitive exact match). Returns {id, email, name, display_name, avatar_url} or null if no match. |
| `banter_find_user_by_handle` | Find a Banter user by handle (accepts "@alice" or "alice"). Banter users do not have a dedicated handle column — matching falls back to a slugified form of display_name (lower-cased, whitespace collapsed to hyphens). Returns the user or null. |
| `banter_list_users` | Fuzzy search Banter users by name, display name, or email. Returns up to 20 users in the active org ordered by relevance. If no query is supplied, returns the 20 most recently created users. |
| `banter_list_user_groups` | List all user groups in the organization |
| `banter_get_user_group_by_handle` | Resolve a Banter user group by handle (accepts "@engineering" or "engineering"). Returns {id, name, handle, description, member_count} or null if no match. |
| `banter_create_user_group` | Create a new user group (e.g. @backend-team) |
| `banter_update_user_group` | Update a user group name, handle, or description |
| `banter_add_group_members` | Add members to a user group |
| `banter_remove_group_member` | Remove a member from a user group |
| `banter_start_call` | Start a new voice/video call in a Banter channel. Accepts a channel UUID, name, or #name. |
| `banter_join_call` | Join an active call |
| `banter_leave_call` | Leave an active call |
| `banter_end_call` | End an active call (destructive - requires confirmation) |
| `banter_get_call` | Get details about a specific call |
| `banter_list_calls` | List calls in a Banter channel (active and recent) |
| `banter_get_transcript` | Get the transcript for a call |
| `banter_invite_agent_to_call` | Invite an AI agent to join an active call as a participant |
| `banter_post_call_text` | Post a text message in a call channel with a call reference (for text-mode AI participation) |
| `banter_get_active_huddle` | Check if a channel has an active huddle and get its details |
| `banter_share_task` | Share a BigBlueBam task as a rich embed in a Banter channel. Accepts a channel UUID, name, or #name. |
| `banter_share_sprint` | Share a BigBlueBam sprint summary as a rich embed in a Banter channel. Accepts a channel UUID, name, or #name. |
| `banter_share_ticket` | Share a Helpdesk ticket as a rich embed in a Banter channel. Accepts a channel UUID, name, or #name. |
| `banter_get_unread` | Get the current user's unread message summary across all Banter channels |
| `banter_get_preferences` | Get the authenticated user's Banter notification and theme preferences. |
| `banter_update_preferences` | Update the authenticated user's Banter notification and theme preferences. |
| `banter_set_presence` | Set the authenticated user's presence status in Banter. The status is ephemeral — it auto-expires via a Redis TTL, so callers should not treat it as persistent. |

### Beacon (30 tools)

Knowledge base: Beacon CRUD, upsert-by-slug, hybrid search, verification lifecycle, tags, typed links, saved queries, graph exploration, and governance policies.

#### `beacon-tools.ts` (30)

| Tool | Description |
|---|---|
| `beacon_create` | Create a new Beacon (Draft). Provide title, body_markdown, visibility, and optional project scope. |
| `beacon_list` | List Beacons with optional filters and pagination. |
| `beacon_get` | Retrieve a single Beacon by ID or slug. |
| `beacon_update` | Update a Beacon (creates a new version). Provide only the fields to change. |
| `beacon_upsert_by_slug` | Idempotent create-or-update of a Beacon entry by slug. Natural key is the globally-unique slug. On update, bumps version and writes a beacon_versions snapshot. Returns { data, created, idempotency_key } — `created` is true on insert, false on update. |
| `beacon_retire` | Retire (soft-delete) a Beacon. |
| `beacon_publish` | Transition a Beacon from Draft to Active. |
| `beacon_verify` | Record a verification event on a Beacon (confirms content is still accurate). |
| `beacon_challenge` | Flag a Beacon for review (challenge its accuracy or relevance). |
| `beacon_restore` | Restore an Archived Beacon back to Active status. |
| `beacon_versions` | List the version history of a Beacon. |
| `beacon_version_get` | Get a specific version of a Beacon. |
| `beacon_search` | Hybrid semantic + keyword + graph search across Beacons. |
| `beacon_suggest` | Typeahead suggestions from the Beacon title/tag index. |
| `beacon_search_context` | Structured retrieval optimized for agent consumption — richer metadata, linked Beacons pre-fetched. |
| `beacon_policy_get` | Get the effective Beacon governance policy for the current scope. |
| `beacon_policy_set` | Set or update the Beacon governance policy at a given scope level. |
| `beacon_policy_resolve` | Preview the resolved effective policy (merging org + project levels). |
| `beacon_tags_list` | List all tags in scope with usage counts. |
| `beacon_tag_add` | Add one or more tags to a Beacon. |
| `beacon_tag_remove` | Remove a tag from a Beacon. |
| `beacon_link_create` | Create a typed link between two Beacons. |
| `beacon_link_remove` | Remove a link from a Beacon. |
| `beacon_query_save` | Save a named search query configuration for reuse. |
| `beacon_query_list` | List saved queries (own + shared in scope). |
| `beacon_query_get` | Retrieve a saved query by ID. |
| `beacon_query_delete` | Delete a saved query (owner only). |
| `beacon_graph_neighbors` | Get nodes and edges within N hops of a focal Beacon for graph exploration. |
| `beacon_graph_hubs` | Get the most-connected Beacons in scope (hub nodes for Knowledge Home). |
| `beacon_graph_recent` | Get recently modified or verified Beacons. |

### Bond CRM (23 tools)

Contacts (with upsert-by-email), companies, deals, pipeline stages, activities, notes, search, reports, and duplicate-handling.

#### `bond-tools.ts` (23)

| Tool | Description |
|---|---|
| `bond_list_contacts` | Search and filter CRM contacts with pagination. Supports lifecycle stage, owner, company, lead score range, and custom field filters. |
| `bond_get_contact` | Get full contact detail including associated companies, deals, and recent activities. |
| `bond_create_contact` | Create a new CRM contact with identity, classification, and optional company association. `owner_id` accepts a user UUID or email; `company_id` accepts a company UUID or name. |
| `bond_update_contact` | Update an existing contact. Provide only the fields to change. `id` accepts a contact UUID, an email, or a name fragment (single-match only). `owner_id` accepts a user UUID or email. |
| `bond_merge_contacts` | Merge duplicate contacts. The target contact absorbs the source contact's deals, activities, and company associations. The source contact is soft-deleted. |
| `bond_upsert_contact` | Idempotent create-or-update of a CRM contact by email. Natural key is (organization_id, lower(email)). Soft-deleted matches are resurrected. Returns { data, created, idempotency_key } — `created` is true on insert, false on update. |
| `bond_list_companies` | Search and filter CRM companies with pagination. |
| `bond_get_company` | Get full company detail including associated contacts, deals, and recent activities. |
| `bond_create_company` | Create a new CRM company. |
| `bond_update_company` | Update an existing company. Provide only the fields to change. |
| `bond_list_deals` | Search and filter CRM deals with pagination. Supports pipeline, stage, owner, value range, and stale flag filters. |
| `bond_get_deal` | Get full deal detail including associated contacts, activities, and stage change history. |
| `bond_create_deal` | Create a new deal in a pipeline. `pipeline_id` accepts a pipeline UUID or exact name; `stage_id` accepts a stage UUID or exact name (within the resolved pipeline); `owner_id` accepts a user UUID or email; `company_id` accepts a company UUID or name; `contact_ids` entries each accept a contact UUID or email. |
| `bond_update_deal` | Update an existing deal. Provide only the fields to change. `id` accepts a deal UUID or a unique title fragment (single-match only). `owner_id` accepts a user UUID or email; `company_id` accepts a company UUID or name. |
| `bond_move_deal_stage` | Move a deal to a new pipeline stage. Records stage history and emits a deal.stage_changed event for Bolt automations. `id` accepts a deal UUID or a unique title fragment; `stage_id` accepts a stage UUID or exact stage name (stage name is resolved within the deal's pipeline). |
| `bond_close_deal_won` | Mark a deal as won. Sets closed_at, moves to the won stage, and emits a deal.won event for Bolt automations. `id` accepts a deal UUID or a unique title fragment. |
| `bond_close_deal_lost` | Mark a deal as lost. Sets closed_at, close_reason, and optionally the competitor who won. Emits a deal.lost event for Bolt automations. `id` accepts a deal UUID or a unique title fragment. |
| `bond_log_activity` | Log an activity (note, call, email, meeting, task, etc.) against a contact, deal, or both. `contact_id` accepts a UUID or email; `deal_id` accepts a UUID or unique deal title fragment; `company_id` accepts a UUID or company name. |
| `bond_get_pipeline_summary` | Get pipeline summary with deal count, total value, and weighted value per stage. |
| `bond_get_stale_deals` | List deals that have exceeded the rotting threshold for their current pipeline stage. Useful for stale deal follow-up automations. |
| `bond_score_lead` | Trigger lead score recalculation for a specific contact. Evaluates all enabled scoring rules and updates the cached lead_score on the contact. |
| `bond_get_forecast` | Get revenue forecast from weighted pipeline value, broken into 30/60/90 day buckets based on expected close dates. |
| `bond_search_contacts` | Full-text search across contact name, email, and phone. Returns contacts ranked by lead score. |

### Brief Documents (18 tools)

Collaborative documents: CRUD, upsert-by-slug, collaborators, versions, search, comments, and graduation to Beacon.

#### `brief-tools.ts` (18)

| Tool | Description |
|---|---|
| `brief_list` | List Brief documents with optional filters and pagination. |
| `brief_get` | Retrieve a single Brief document by ID or slug. |
| `brief_create` | Create a new Brief document. |
| `brief_update` | Update Brief document metadata. Provide only the fields to change. |
| `brief_update_content` | Replace the entire content of a Brief document with new Markdown. |
| `brief_append_content` | Append Markdown content to the end of a Brief document. |
| `brief_archive` | Archive a Brief document (soft-delete). |
| `brief_restore` | Restore an archived Brief document. |
| `brief_duplicate` | Duplicate a Brief document, optionally into a different project. |
| `brief_search` | Search Brief documents by keyword or semantic similarity. |
| `brief_comment_list` | List comments on a Brief document. |
| `brief_comment_add` | Add a comment to a Brief document, optionally as a reply or anchored to specific text. |
| `brief_comment_resolve` | Toggle the resolved state of a comment. |
| `brief_versions` | List the version history of a Brief document. |
| `brief_version_get` | Get a specific version of a Brief document. |
| `brief_version_restore` | Restore a Brief document to a specific previous version. |
| `brief_promote_to_beacon` | Graduate a Brief document to a Beacon knowledge article. |
| `brief_link_task` | Link a Brief document to a Bam task. |

### Bill Invoicing (16 tools)

Invoices, line items, payments, expenses, clients, profitability, and revenue summaries.

#### `bill-tools.ts` (16)

| Tool | Description |
|---|---|
| `bill_list_invoices` | List invoices, optionally filtered by status, client, project, or date range. |
| `bill_get_invoice` | Get full invoice detail including line items and payments. |
| `bill_create_invoice` | Create a new blank draft invoice for a billing client. |
| `bill_create_invoice_from_time` | Generate an invoice from Bam time entries for a project and date range. |
| `bill_create_invoice_from_deal` | Generate a draft invoice from a Bond CRM deal, pulling deal value and contact info. |
| `bill_add_line_item` | Add a line item to a draft invoice. |
| `bill_finalize_invoice` | Finalize a draft invoice — assigns an invoice number and locks edits. |
| `bill_send_invoice` | Mark invoice as sent (triggers email delivery if configured). |
| `bill_record_payment` | Record a payment against an invoice. |
| `bill_get_overdue` | List all overdue invoices with days overdue and amount due. |
| `bill_get_revenue_summary` | Get revenue summary by month, showing total invoiced and collected. |
| `bill_get_profitability` | Get project profitability: invoiced revenue vs. logged expenses per project. |
| `bill_list_expenses` | List expenses, optionally filtered by project, category, or status. |
| `bill_create_expense` | Log a new expense, optionally linked to a project. |
| `bill_resolve_rate` | Resolve the effective billing rate for a given project + user + date. |
| `bill_list_clients` | List billing clients for the organization, with optional fuzzy search across name, email, and linked Bond company name. Returns id, name, email, company_id, company_name, currency (org default), and default_payment_terms_days — the resolver surface every "bill client X" rule needs. |

### Board Whiteboard (14 tools)

Whiteboard rooms, shapes, assets, canvas reading, participants, embeds, and sticky-note-to-task linking.

#### `board-tools.ts` (14)

| Tool | Description |
|---|---|
| `board_list` | List boards with optional filters and pagination. |
| `board_get` | Get board metadata by ID. |
| `board_create` | Create a new visual collaboration board. `template_id` accepts either a UUID or a template name (case-insensitive). |
| `board_update` | Update board metadata. Provide only the fields to change. `id` accepts either a UUID or a board name. |
| `board_archive` | Archive a board (soft delete). `id` accepts either a UUID or a board name. |
| `board_read_elements` | Read all elements on a board. Returns structured data with positions, text, and types. `id` accepts either a UUID or a board name. |
| `board_read_stickies` | Read only sticky note elements from a board. |
| `board_read_frames` | Read frames with their contained elements from a board. |
| `board_add_sticky` | Add a sticky note to a board. `board_id` accepts either a UUID or a board name. |
| `board_add_text` | Add a text element to a board. `board_id` accepts either a UUID or a board name. |
| `board_promote_to_tasks` | Promote sticky notes to Bam tasks in a project. `board_id` accepts either a UUID or a board name. `project_id` accepts either a UUID or a project name. `phase_id` accepts either a UUID or a phase name (scoped to the resolved project). |
| `board_export` | Export a board as SVG or PNG. `id` accepts either a UUID or a board name. |
| `board_summarize` | Get a board summary grouped by frames, including element counts and text content. `id` accepts either a UUID or a board name. |
| `board_search` | Search across board element text content. |

### Blast Email Campaigns (14 tools)

Campaign management, templates, segments, analytics, and subject-line generation.

#### `blast-tools.ts` (14)

| Tool | Description |
|---|---|
| `blast_list_templates` | List available email templates with optional type filter and search. |
| `blast_get_template` | Get email template content and builder state by ID. |
| `blast_create_template` | Create a new email template from HTML and subject line. |
| `blast_draft_campaign` | Create a campaign in draft status with template, segment, and schedule. `template_id` and `segment_id` accept either a UUID or the entity name — exact match preferred, single fuzzy match acceptable. |
| `blast_get_campaign` | Get campaign detail and delivery stats. `id` accepts either a UUID or the campaign name (exact match preferred, single fuzzy match acceptable). |
| `blast_send_campaign` | Send a campaign immediately. Requires human approval by default. `id` accepts either a UUID or the campaign name (exact match preferred, single fuzzy match acceptable). |
| `blast_get_campaign_analytics` | Get engagement metrics for a sent campaign: open rate, click rate, click map, delivery breakdown. `id` accepts either a UUID or the campaign name. |
| `blast_list_segments` | List contact segments with cached recipient counts. |
| `blast_create_segment` | Define a segment from Bond contact filter criteria. |
| `blast_preview_segment` | Preview the first 50 matching contacts for a segment. |
| `blast_draft_email_content` | AI-generate email subject and body from a brief description and tone. |
| `blast_suggest_subject_lines` | Generate 5 subject line variants for A/B comparison. |
| `blast_get_engagement_summary` | Get org-level engagement trends: total sent, avg open rate, avg click rate, unsubscribe rate. |
| `blast_check_unsubscribed` | Check if an email address is on the organization unsubscribe list. |

### Bolt Workflow Automation (13 tools)

Rule CRUD and execution management, templates, triggers, conditions, actions, get-by-name lookups.

#### `bolt-tools.ts` (13)

| Tool | Description |
|---|---|
| `bolt_list` | List workflow automations with optional filters and pagination. |
| `bolt_get` | Get a single automation with its conditions and actions. |
| `bolt_get_automation_by_name` | Resolve an automation by its name within the caller's org. Case-insensitive exact match is preferred; falls back to a single-hit fuzzy ILIKE "%name%" match. Returns a compact projection ({ id, name, description, trigger_source, trigger_event, enabled, action_count, last_execution_at }) or null if no unique match is found. Useful for meta-automations that need to reference other automations by name (e.g. disable the "Nightly Deploys" automation when an incident is declared). |
| `bolt_create` | Create a new workflow automation with trigger, conditions, and actions. |
| `bolt_update` | Update an existing automation. Provide only the fields to change. |
| `bolt_enable` | Enable a workflow automation. |
| `bolt_disable` | Disable a workflow automation. |
| `bolt_delete` | Delete a workflow automation. |
| `bolt_test` | Test-fire an automation with a simulated event payload. |
| `bolt_executions` | List execution history for an automation. |
| `bolt_execution_detail` | Get detailed information about a single execution, including action results. |
| `bolt_events` | List available trigger events, optionally filtered by source. |
| `bolt_actions` | List available MCP tools that can be used as automation actions. |

### Bearing Goals & OKRs (12 tools)

Goal periods, goals, key results, progress updates, links, reports, and at-risk detection.

#### `bearing-tools.ts` (12)

| Tool | Description |
|---|---|
| `bearing_periods` | List OKR periods with optional filters by status and year. |
| `bearing_period_get` | Get a single OKR period with aggregated stats. |
| `bearing_goals` | List OKR goals with optional filters by period, scope, owner, and status. |
| `bearing_goal_get` | Get a single goal with its key results and progress details. |
| `bearing_goal_create` | Create a new OKR goal within a period. `period_id` accepts either a UUID or the period label (e.g. "Q2 2026"). `owner_id` accepts a UUID or the owner's email address. |
| `bearing_goal_update` | Update an existing goal. Provide only the fields to change. `id` accepts either a UUID or the goal title. `owner_id` accepts a UUID or email address. |
| `bearing_kr_create` | Create a key result under a goal. `goal_id` accepts a UUID or the goal title. `owner_id` accepts a UUID or email address. |
| `bearing_kr_update` | Update a key result value or metadata. When current_value is provided, also records a value check-in. `id` accepts either a UUID or the KR title — if multiple KRs share the title the tool fails and asks for disambiguation. |
| `bearing_kr_link` | Link a key result to a Bam entity (epic, project, or task query) for automatic progress tracking. `key_result_id` accepts a UUID or the KR title. |
| `bearing_update_post` | Post a status update on a goal. `goal_id` accepts a UUID or the goal title. |
| `bearing_report` | Generate a period summary, at-risk, or owner report. |
| `bearing_at_risk` | Quick check: list all at-risk or behind goals across the organization. |

### Helpdesk (11 tools)

Ticket operations, public/admin settings, upsert-by-email for support contacts.

#### `helpdesk-tools.ts` (11)

| Tool | Description |
|---|---|
| `list_tickets` | List helpdesk tickets with optional filters |
| `get_ticket` | Get detailed information about a helpdesk ticket including messages |
| `helpdesk_get_ticket_by_number` | Resolve a helpdesk ticket by its human-readable ticket number (e.g. 1234 or #1234). Leading "#" is stripped. Returns the full ticket record enriched with requester and task-derived assignee info, or null if not found. Use this when you only have the ticket number (as typically shown to customers or agents) and need to resolve it to the underlying UUID / full record before calling other helpdesk tools. |
| `helpdesk_search_tickets` | Fuzzy search helpdesk tickets by subject and body within the caller's org. Returns up to 20 matches as a compact projection ({ id, number, subject, status, priority, requester_email, requester_name, assignee_id, assignee_name }), ordered by most recently updated. Optional filters narrow by status and by the linked task's assignee_id. Intended as a resolver for natural-language ticket lookups where only a fragment of the subject/body is known. |
| `reply_to_ticket` | Send a message on a helpdesk ticket (public reply or internal note) |
| `update_ticket_status` | Update the status of a helpdesk ticket |
| `helpdesk_get_public_settings` | Get public helpdesk settings (no auth required). Returns email verification requirement, categories, and welcome message. |
| `helpdesk_get_settings` | Get full helpdesk configuration. Requires admin authentication — the caller's API key must belong to an org admin or owner. |
| `helpdesk_update_settings` | Update helpdesk settings. Requires admin authentication. |
| `helpdesk_set_default_project` | Set the default project for incoming helpdesk tickets for a specific organization. Identifies the org by slug (e.g. "mage-inc") and the project by slug (e.g. "support-backlog"). Future tickets submitted at /helpdesk/<org-slug>/ (no project segment) will land in this project. Per-project portal URLs (/helpdesk/<org-slug>/<project-slug>/) override this default. Requires admin authentication. |
| `helpdesk_upsert_user` | Idempotent create-or-update of a helpdesk end-user by email. Natural key is (org_id, email); the tool resolves the org via the provided org_slug. Returns { data, created, idempotency_key }. SECURITY: the update path ignores the password field, so calling this tool on an existing email cannot change that user's credentials. |

### Book Scheduling (11 tools)

Events, RSVPs, booking pages, and availability (including mixed human-and-agent rosters).

#### `book-tools.ts` (11)

| Tool | Description |
|---|---|
| `book_list_events` | List calendar events in a date range, optionally filtered by calendar IDs. |
| `book_create_event` | Create a calendar event with optional attendees. `calendar_id` accepts either a UUID or a calendar name (case-insensitive). Each attendee `user_id` accepts either a UUID or an email address. |
| `book_update_event` | Update an existing calendar event. `id` accepts either a UUID or an event title (case-insensitive exact or single fuzzy match within +/- 1 year of now). |
| `book_cancel_event` | Cancel a calendar event (sets status to cancelled). `id` accepts either a UUID or an event title. |
| `book_get_availability` | Get available time slots for a user in a date range. `user_id` accepts either a UUID or an email address. |
| `book_get_team_availability` | Get available time slots for multiple users to find common free times. Each entry in `user_ids` accepts either a UUID or an email address. Fails cleanly if any input cannot be resolved. |
| `book_find_meeting_time` | AI-assisted: find optimal meeting times for a set of attendees. Returns up to 3 suggested slots. Each entry in `user_ids` accepts either a UUID or an email address. |
| `book_create_booking_page` | Create a public booking page (scheduling link). |
| `book_get_timeline` | Get aggregated cross-product timeline with Book events, Bam tasks, sprints, and more. |
| `book_rsvp_event` | Accept, decline, or mark tentative for a calendar event on behalf of the current user. `event_id` accepts either a UUID or an event title. |
| `book_find_meeting_time_for_users` | Find meeting-time slots across a mixed roster of humans and agents/service accounts. Agents/service accounts have no calendars; when respect_working_hours_for_humans_only is true (default) they are treated as unconditionally available and skipped from conflict detection. Each entry in user_ids accepts a UUID or an email address. Returns slots with per-attendee availability annotations so the caller can render "agent: always available" alongside the human conflict picture. |

### Blank Forms (11 tools)

Forms, submissions, analytics, AI form generation, and response summarization.

#### `blank-tools.ts` (11)

| Tool | Description |
|---|---|
| `blank_list_forms` | List available forms for the current organization. Supports filtering by status and project. |
| `blank_get_form` | Get a form definition with all its fields. |
| `blank_create_form` | Create a new form with optional inline field definitions. |
| `blank_generate_form` | AI generates a form from a natural-language description. Returns a form specification that can be passed to blank_create_form. |
| `blank_update_form` | Update form metadata or settings. |
| `blank_publish_form` | Publish a draft form, making it available for submissions. |
| `blank_list_submissions` | List submissions for a form. Returns paginated results. |
| `blank_get_submission` | Get a specific submission with all response data. |
| `blank_summarize_responses` | Get analytics data for a form including response counts, field breakdowns, and trends. Useful for AI summarization of form results. |
| `blank_export_submissions` | Export all submissions for a form as CSV data. |
| `blank_get_form_analytics` | Get response aggregation data for a form, including per-field breakdowns, submission trends, and summary statistics. |

### Bench Analytics (11 tools)

Dashboards, widgets, ad-hoc queries, scheduled reports, anomaly detection, and period comparison.

#### `bench-tools.ts` (11)

| Tool | Description |
|---|---|
| `bench_list_dashboards` | List available analytics dashboards for the current organization. Supports filtering by project and visibility. |
| `bench_get_dashboard` | Get a dashboard with all its widget configurations and layout. |
| `bench_query_widget` | Execute a widget query and return the data results. Returns rows, the generated SQL, and execution time. |
| `bench_query_ad_hoc` | Run a structured query against any registered data source. Returns rows, SQL, and duration. Use bench_list_data_sources to discover available sources and their schemas. |
| `bench_summarize_dashboard` | Get all widget data from a dashboard for AI summarization. Returns the dashboard metadata and query results for each widget. |
| `bench_detect_anomalies` | Scan recent metrics for anomalies. Queries the specified data source and compares the most recent period against the previous period to detect significant deviations. |
| `bench_generate_report` | Trigger immediate generation and delivery of a scheduled report. |
| `bench_list_data_sources` | List all available data sources and their schemas (measures, dimensions, filters). Use this to discover what data can be queried through Bench. |
| `bench_list_widgets` | List widgets across the organization, optionally scoped to a single dashboard. Widgets are normally only reachable by nesting inside bench_get_dashboard; this gives them direct addressability for resolver flows. Returns id, name, type, dashboard_id, dashboard_name, position, and query. |
| `bench_list_scheduled_reports` | List scheduled reports for the organization, with optional fuzzy search on name. Returns id, name, dashboard_id, dashboard_name, schedule (cron expression + timezone + enabled), recipients (delivery method/target/format), last_run_at, and next_run_at. |
| `bench_compare_periods` | Compare metrics between two time periods. Returns values for both periods and the percentage change. |

### Cross-Cutting Platform Surfaces (49 tools)

Agent identity, policy, audit, proposals, visibility preflight, unified activity, cross-app search, fuzzy resolver, composite views, entity links, attachments, dedupe, phrase counts, expertise, pattern subscriptions, ingest fingerprint, outbound webhooks, Bolt observability, utility and platform admin.

#### `agent-tools.ts` (3)

| Tool | Description |
|---|---|
| `agent_heartbeat` | Service-account only. Register or refresh the calling runner in agent_runners. Upserts by the service-account user id; bumps last_heartbeat_at and merges name/version/capabilities. Callers that are not service accounts get 403 NOT_A_SERVICE_ACCOUNT. |
| `agent_audit` | Fetch the activity_log stream for a specific agent (service-account user) in the caller's active org. Paginated by created_at cursor. Wave 1 covers activity_log only; bond/helpdesk/banter audit merges are Wave 2. |
| `agent_self_report` | Service-account only. Append a self-report entry (action='agent.self_report') to activity_log under the given project. project_id is REQUIRED — the platform does not create sentinel projects in Wave 1. Callers that are not service accounts get 403 NOT_A_SERVICE_ACCOUNT. |

#### `agent-policy-tools.ts` (3)

| Tool | Description |
|---|---|
| `agent_policy_get` | Fetch the policy row for a specific agent/service user in the caller's active org. Returns enabled flag, allowed_tools glob list, channel_subscriptions, rate_limit_override, notes, and an updated_by_user join so the caller can see who last touched it. 404 if the user is not in the caller's org or has no policy row yet. |
| `agent_policy_set` | Upsert the policy row for an agent/service user. Patch any subset of enabled, allowed_tools, channel_subscriptions, rate_limit_override, notes. allowed_tools uses glob-prefix matching: a single entry '*' allows every tool; entries like 'banter.*' or 'banter_*' allow any tool starting with the prefix; bare entries are exact match. Returns confirmation_required:true when the call flips enabled from true to false on a live agent — the caller is expected to route through confirm_action before committing the kill. 400 if the target is not an agent/service user; 403 if the target is in a different org. |
| `agent_policy_list` | List agent/service policy rows in the caller's active org (SuperUsers may pass org_id to list a different org). Each row carries agent_user_id, agent_name (from users.display_name), enabled flag, allowed_tool_count, last_heartbeat_at from agent_runners (null if the agent has never heartbeat), and updated_at. Use enabled_only=true to restrict to currently-enabled rows. |

#### `agent-webhook-tools.ts` (4)

| Tool | Description |
|---|---|
| `agent_webhook_configure` | Configure or reconfigure an agent runner's outbound webhook. Accepts the target URL, an event_filter list (entries shaped like 'source:event_type' or 'source:*' or a single '*'), and an optional enabled flag (default true). Generates a fresh HMAC signing secret, hashes it with argon2id for server-side storage, and returns the plaintext secret exactly once; subsequent calls require rotation. Rejects URLs that would hit private/loopback/link-local IPs, cloud metadata endpoints, or *.internal hosts, and requires https in production. Resets webhook_consecutive_failures so a reconfigure lifts any circuit-breaker auto-disable. |
| `agent_webhook_rotate_secret` | Rotate the HMAC signing secret for an agent runner's outbound webhook. Returns a fresh plaintext secret exactly once; the predecessor is invalidated atomically. Fails with WEBHOOK_NOT_CONFIGURED if the runner has no webhook_url yet (use agent_webhook_configure first). Unlike api-key rotation, there is no grace window: the next dispatch will be signed with the new secret, and receivers that cache the old secret will see signature mismatches until they swap. |
| `agent_webhook_deliveries_list` | List recent webhook deliveries for the caller's active org. Filter by runner_id (limit to one runner), by status (pending \| delivered \| failed \| dead_lettered), and paginate by passing the created_at of the last row as 'before'. Returns attempt_count, last_error, response_status_code, and timestamps so operators can triage failures and redeliver dead-lettered rows. Capped at 200 per call; default limit 50. |
| `agent_webhook_redeliver` | Re-enqueue a specific webhook delivery. Resets attempt_count to 0 and status to pending, then queues a fresh dispatcher job. Useful for reviving dead-lettered rows after the operator has fixed the receiver, or for forcing a retry on a pending row without waiting for the backoff to elapse. Fails with RUNNER_WEBHOOK_DISABLED if the runner's webhook has been auto-disabled by the circuit breaker; reconfigure or re-enable the runner first. |

#### `proposal-tools.ts` (3)

| Tool | Description |
|---|---|
| `proposal_create` | Create a durable proposal in the agent_proposals queue. The proposal shows up in the approver's inbox and remains actionable until decided or expired. Use this for destructive or human-gated actions where you need an explicit approval on record (not just a DM notification). |
| `proposal_list` | List proposals visible to the caller. By default returns pending proposals where the caller is either the approver or the actor; org admins see the whole org queue. Pass filter[status]=all to see decided rows too. |
| `proposal_decide` | Decide a pending or revising proposal. Only the designated approver (or an org admin) may decide. Returns 409 if the proposal was already decided, 410 if it expired, 403 if the caller is not authorized. |

#### `visibility-tools.ts` (1)

| Tool | Description |
|---|---|
| `can_access` | Preflight a visibility check. Returns { allowed, reason } for whether asker_user_id can see (entity_type, entity_id). Agents that surface cross-app results into shared channels MUST call this for every cited entity and filter out anything that is not allowed. Supported entity_type values: bam.task, bam.project, bam.sprint, helpdesk.ticket, bond.deal, bond.contact, bond.company, brief.document, beacon.entry. Unsupported types return reason='unsupported_entity_type' and MUST NOT be surfaced. |

#### `activity-tools.ts` (2)

| Tool | Description |
|---|---|
| `activity_query` | Query the unified activity log for a given entity. Returns rows from Bam activity_log, Bond bond_activities, and Helpdesk ticket_activity_log under a normalized shape. Visibility is gated server-side: you will only see rows your current user/org can access. Paginated by a `<iso-ts>\|<uuid>` cursor. |
| `activity_by_actor` | Query the unified activity log for everything a specific actor (user) has done across Bam, Bond, and Helpdesk. The target actor must share the caller's active org (404 otherwise). Visibility for individual rows is gated server-side. |

#### `search-tools.ts` (1)

| Tool | Description |
|---|---|
| `search_everything` | Cross-app unified search. Fans out in parallel to per-app search endpoints (Bam tasks, Helpdesk tickets, Bond contacts/companies, Brief documents, Beacon entries, Banter messages, Board elements), normalizes each app's native relevance score, applies a per-app weight, and returns a ranked unified hit list. Use `types` to prune fan-out to a subset of entity kinds. Pass `as_user_id` to run a visibility preflight (can_access) on every supported hit and drop anything the asker cannot see; the count of dropped hits is reported as `filtered_count`. Note: Banter messages and Board elements are NOT in the Wave 2 can_access allowlist, so those hits are always included based on the source app's own RLS (banter channel membership, board visibility). Each arm has a 3s timeout; arm-level failures are reported in `errors[]` without failing the whole call. |

#### `resolve-tools.ts` (1)

| Tool | Description |
|---|---|
| `resolve_references` | Resolve free text (natural language with optional pinned mention syntax like [[ABC-42]], [[deal:Acme]], @jane, #project) into a ranked list of candidate entities. No LLM. Phase 1 deterministically resolves pinned mentions via lookup endpoints; Phase 2 extracts 2-6 word n-grams (cap 5 phrases) and fans out to every app search endpoint in parallel. Returns ranked candidates with confidence, an optional disambiguation hint when siblings are close, and any fragments that did not resolve. |

#### `user-resolver-tools.ts` (3)

| Tool | Description |
|---|---|
| `find_user_by_email` | Find a user by exact email address (case-insensitive) within the caller's active organization. Returns the user object `{ id, email, name, display_name, avatar_url, role }` or `null` if no match. Use this whenever a rule, workflow, or prompt mentions a user by email and you need their user_id to pass to another tool. Works identically for any app (Bam, Banter, Bolt, Bond, etc.) — the underlying users table is shared. |
| `find_user_by_name` | Fuzzy-search active users by name or email within the caller's active organization. Matches against display_name and email, ordered by relevance (exact email match first, then prefix matches, then contains). Returns up to 20 users as `[{ id, email, name, display_name, avatar_url, role }]`. Use this when a rule mentions "assign to Jane" or "notify Bob" and you need to disambiguate the user. |
| `list_users` | List users in the caller's active organization, sorted by display name. Returns `[{ id, email, name, display_name, avatar_url, role, is_active }]`. Defaults to active users only (max 200 per call). Use this to enumerate users when building UIs, workflow targets, or when you need an overview of the org roster. For project-scoped member lists, use `list_members` instead. |

#### `composite-tools.ts` (3)

| Tool | Description |
|---|---|
| `account_view` | Composite account-page view. Resolves one of { company_id, contact_id, domain } to a company, then fans out in parallel to bond (deals, owners), helpdesk (tickets), bill (invoices), bam (tasks), and the Bam activity log (recent_activity). Each arm has a 5s timeout; per-arm failures set the corresponding field to empty and append the arm name to `missing`. Returns only entities visible to the caller; asker-mode (as_user_id) is not supported in Wave 3. Returns 502 COMPOSITE_FAILED only if every arm fails. |
| `project_view` | Composite project-overview view. Fans out in parallel to Bam (project, task count, active sprint, activity for top contributors), Bearing (linked goals), Brief (recent documents), and Beacon (recent entries). Each arm has a 5s timeout; per-arm failures set the corresponding field to empty/null and append the arm name to `missing`. top_contributors is a 30-day client-side GROUP BY over /projects/:id/activity today; when the §5 unified activity_query tool lands, it will be preferred automatically. Returns only entities visible to the caller; asker-mode is not supported in Wave 3. Returns 502 COMPOSITE_FAILED only if every arm fails. |
| `user_view` | Composite person-profile view. Fans out in parallel to Bam (user via /users/:id, recent activity stub), Bond (owned deals), Helpdesk (open tickets via /tickets/search), and Bearing (owned goals). Each arm has a 5s timeout; per-arm failures set the corresponding field to empty and append the arm name to `missing`. user.kind is the users.kind column added in Wave 1 (human/agent/service). Returns only entities visible to the caller; asker-mode is not supported in Wave 3. Returns 502 COMPOSITE_FAILED only if every arm fails. |

#### `entity-links-tools.ts` (3)

| Tool | Description |
|---|---|
| `entity_links_list` | List cross-app entity links touching (type, id). Default direction 'both' returns both outbound and inbound rows; each row carries a 'direction' of 'outbound' or 'inbound' relative to the query. Rows whose far side is not accessible to the caller are silently filtered out and counted in filtered_count. Optional kind narrows to a single link_kind: related_to \| duplicates \| blocks \| references \| parent_of \| derived_from. Reverse directions (e.g. blocked_by) are implicit via direction='dst'. |
| `entity_link_create` | Create a directional cross-app link. Both endpoints are preflighted via can_access and writes are rejected with 403 if either side is not accessible. Only the Wave 2 supported entity types are writable (bam.task/project/sprint, helpdesk.ticket, bond.deal/contact/company, brief.document, beacon.entry); any other type returns 400 UNSUPPORTED_ENTITY_TYPE. link_kind is one of related_to, duplicates, blocks, references, parent_of, derived_from. parent_of and derived_from reject writes that would close a cycle with 400 CYCLE_DETECTED. Re-creating an identical link returns the existing row with created: false (idempotent). There is NO blocked_by; use blocks and query by direction='dst'. |
| `entity_link_remove` | Remove an entity link by id. Returns { ok: true } on success. Caller must have can_access on at least one side of the link (403 otherwise). Returns 404 if the link is not in the caller's org. |

#### `attachment-tools.ts` (2)

| Tool | Description |
|---|---|
| `attachment_get` | Fetch metadata for a single attachment by id, federated across Bam tasks, Helpdesk tickets, and Beacon entries. Runs a visibility preflight on the parent entity BEFORE reading the attachment table, so callers who cannot see the parent get NOT_FOUND (cross-org) or FORBIDDEN (within-org denial) without leaking existence. Returns `deep_link` as a presigned download URL ONLY when scan_status='clean'; infected / pending / error rows return deep_link=null. Brief documents are NOT supported parents (Brief has no attachment table as of Wave 4). AGENTIC_TODO §17 Wave 4. |
| `attachment_list` | List attachments attached to a given parent entity, filtered optionally by scan_status. Supported entity_type values: 'bam.task', 'helpdesk.ticket', 'beacon.entry'. Any other entity_type returns UNSUPPORTED_PARENT_TYPE. Visibility preflight runs on the parent BEFORE the attachment table is queried; unauthorized callers get 403 FORBIDDEN with the can_access reason. `limit` defaults to 50 and is capped at 50. Rows are sorted by uploaded_at desc. Deep links are issued only for scan_status='clean' rows. AGENTIC_TODO §17 Wave 4. |

#### `dedupe-tools.ts` (4)

| Tool | Description |
|---|---|
| `bond_find_duplicates` | Return likely duplicate contacts for a single Bond contact ranked by confidence. Signals combine pg_trgm full-name similarity, exact case-insensitive email match, and exact normalized-phone match. Each candidate row carries the contributing signals and, when a dedupe_decisions row exists for the pair, a prior_decision block so the caller can suppress pairs a human has already resolved. Member and viewer callers only see contacts they own; admins see everything in the org. |
| `helpdesk_find_similar_tickets` | Return similar helpdesk tickets for a single ticket ranked by confidence. Signals combine pg_trgm subject similarity, same-requester boost, same-category boost, and an existing tickets.duplicate_of link. Status filter defaults to 'not_closed' (open + in_progress + waiting + resolved). Pass 'open' for open-only or 'any' to include closed tickets. window_days restricts candidates to tickets created within the window. Each candidate carries a prior_decision block when a dedupe_decisions row exists for the pair. |
| `dedupe_record_decision` | Record a dedupe decision for an entity pair. The tool canonicalizes the pair order before writing, so passing (A, B) and (B, A) collide on the same row. decision is one of 'duplicate' \| 'not_duplicate' \| 'needs_review'. When an agent tries to overwrite a decision that a human previously recorded, the tool returns isError with code HUMAN_DECISION_EXISTS and includes the prior_decision so the caller can surface the human verdict. Humans and service accounts may always write. resurface_after is optional; when set, dedupe_list_pending will resurface the pair once the timestamp has passed. |
| `dedupe_list_pending` | List dedupe-decision pairs that still need human attention. A row is considered pending if its decision is 'needs_review' OR if a resurface_after timestamp was set and has now elapsed. Filter by entity_type to focus on one app's pairs; filter by since to restrict to rows decided after an ISO-8601 timestamp. Rows are returned ordered by decided_at DESC. |

#### `phrase-count-tools.ts` (2)

| Tool | Description |
|---|---|
| `helpdesk_ticket_count_by_phrase` | Count helpdesk tickets whose (subject, description) matches a phrase, bucketed by hour/day/week over a rolling window. Live tsvector query over tickets.search_vector with a 5s server-side statement_timeout. window.since is REQUIRED; window.until defaults to now(). Optional status_filter narrows to a single ticket status. Results are exact, not approximate. |
| `bam_task_count_by_phrase` | Count Bam tasks whose (title, description_plain) matches a phrase, bucketed by hour/day/week over a rolling window. Live tsvector query scoped to the caller's active org; optional label_filter and project_filter narrow further. window.since is REQUIRED; window.until defaults to now(). 5s server-side statement_timeout. Results are exact, not approximate. |

#### `expertise-tools.ts` (1)

| Tool | Description |
|---|---|
| `expertise_for_topic` | Rank the top subject-matter experts for a natural-language topic. Aggregates signals across Beacon ownership (default weight 3.0), Brief authorship (2.0), Bond coverage on deals and contacts (2.0), and Bam task activity (1.0). Each evidence event is dampened by an exponential time decay with a configurable half-life (default 90 days) so recent work dominates. Evidence is preflighted through can_access for the supplied asker_user_id and stripped when the asker cannot see it; scores are preserved. Returns { topic, experts: [{ user_id, name, email, score, signals: [{ source, weight, evidence[] }] }] }. |

#### `banter-subscription-tools.ts` (3)

| Tool | Description |
|---|---|
| `banter_subscribe_pattern` | Create a passive pattern subscription on a Banter channel. Fires banter.message.matched Bolt events whenever an incoming message matches the supplied pattern_spec. Pattern kinds: 'interrogative' (any question-shaped message), 'keyword' (term list with any/all mode), 'regex' (ADMIN-ONLY to mitigate ReDoS), 'mention' (matches @display_name substrings). Subscriber defaults to the caller, who must be users.kind IN ('agent','service'). Returns subscription_id plus effective=false with a reason string when the channel policy or §15 agent_policies blocks routing - the row is still stored so operators can see the intent. |
| `banter_unsubscribe_pattern` | Disable an existing pattern subscription. Idempotent: re-calling on an already-disabled row returns the original disabled_at. Only the subscriber (or a SuperUser) can disable via this path; channel admins wanting to force-unsubscribe an agent should use the channel admin surface. |
| `banter_list_subscriptions` | List the caller's active pattern subscriptions. Pass channel_id to restrict to a single channel. Returns up to 200 rows ordered by created_at desc. |

#### `ingest-fingerprint-tools.ts` (1)

| Tool | Description |
|---|---|
| `ingest_fingerprint_check` | Atomic dedup check for intake flows (forms, tickets, leads). Hashes the incoming payload into a fingerprint; the tool records it under (org_id, source, fingerprint) with the given TTL and reports whether this is the first sighting. Backed by Redis SET NX EX, one round-trip. Use before creating downstream entities to avoid duplicate ticket / lead / agent responses when a sender retries. window_seconds is capped at 3600 (1 hour). Callers should canonicalize the payload (lowercase, collapse whitespace, strip quoted reply text) before hashing. |

#### `bolt-observability-tools.ts` (2)

| Tool | Description |
|---|---|
| `bolt_event_trace` | Return the full evaluation trail for a single Bolt ingest event: every automation that evaluated the event, whether its conditions matched, and the outcome of each action step. Values in actual/expected are truncated to 1KB per field. Empty executions[] means the event hit zero rules. Org-scoped: only executions in the caller's active org are returned. |
| `bolt_recent_events` | List recent Bolt ingest events in the caller's org that matched at least one automation. Each row is aggregated by event_id with the count of matched automations and the earliest started_at. Filters are optional; limit is capped server-side at 500 (default 50). Useful for a live-ish ops view of what is firing. |

#### `platform-tools.ts` (5)

| Tool | Description |
|---|---|
| `get_platform_settings` | SuperUser only. Fetch platform-wide settings (public signup toggle, etc). |
| `set_public_signup_disabled` | SuperUser only. Toggle the platform-wide public signup kill switch. When true, POST /auth/register and POST /helpdesk/auth/register return 403 SIGNUP_DISABLED and the login pages' 'Create one' link routes to the beta-gate page. |
| `list_beta_signups` | SuperUser only. List notify-me submissions from the public beta-gate form, newest first. |
| `get_public_config` | SuperUser only (MCP gate). Read the unauthenticated /public/config — currently returns whether public signup is disabled. The underlying endpoint is public, but we gate MCP access to SuperUsers since this is part of the platform-admin surface. |
| `submit_beta_signup` | SuperUser only (MCP gate). Create a notify-me submission via the public /public/beta-signup endpoint. The HTTP endpoint is public-by-anyone, but we only allow SuperUsers to invoke it through MCP (typically for testing or manual entry on behalf of a prospect). |

#### `utility-tools.ts` (2)

| Tool | Description |
|---|---|
| `get_server_info` | Get information about this MCP server including version, available tools, authenticated user, and rate limit status |
| `confirm_action` | Confirm a destructive action using a confirmation token. First call without a token to stage the action and receive a token. Then call again with the token to execute. TTL is 60 seconds by default; if approver_user_id is supplied and resolves to a human user, TTL is extended to 5 minutes so async human review is feasible (AGENTIC_TODO §9 Wave 2). |

---

## Available Resources

Resources provide read-only data that AI clients can pull into their context window.

| URI Pattern | Description |
|---|---|
| `bigbluebam://projects` | List of all accessible projects |
| `bigbluebam://projects/{id}/board` | Current board state |
| `bigbluebam://projects/{id}/backlog` | All backlog tasks |
| `bigbluebam://sprints/{id}` | Sprint details + task list |
| `bigbluebam://tasks/{human_id}` | Full task detail (by human-readable ID, e.g., `BBB-142`) |
| `bigbluebam://me/tasks` | Current user's task list across all projects |
| `bigbluebam://me/notifications` | Unread notifications |

---

## Available Prompts

Pre-built prompt templates for common AI workflows.

| Prompt | Arguments | Description |
|---|---|---|
| `sprint_planning` | `project_id` | Fetches backlog, last 3 sprint velocities, team list. Guides AI through prioritization and scoping. |
| `daily_standup` | `project_id` | Fetches 24-hour activity log and in-progress tasks. Summarizes what happened and what is planned. |
| `sprint_retrospective` | `sprint_id` | Fetches sprint report, carry-forward history, scope changes. Structures "went well / improve / action items". |
| `task_breakdown` | `task_id` | Fetches task detail and similar historical tasks. Helps break epics into smaller subtasks with estimates. |

---

## Configuration

The MCP server is configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `MCP_ENABLED` | `true` | Enable/disable the MCP server |
| `MCP_TRANSPORT` | `streamable-http` | Transport: `streamable-http`, `sse`, `stdio` |
| `MCP_PORT` | `3001` | Port for MCP server (sidecar mode) |
| `MCP_PATH` | `/mcp` | URL path prefix (integrated mode) |
| `MCP_AUTH_REQUIRED` | `true` | Require authentication (disable only for local dev) |
| `MCP_RATE_LIMIT_RPM` | `100` | Requests per minute per session |
| `MCP_CONFIRM_DESTRUCTIVE` | `true` | Require confirmation for destructive actions |
| `MCP_MAX_RESULT_SIZE` | `50000` | Max characters in a single tool response |
| `MCP_AUDIT_LOG` | `true` | Log all MCP tool invocations to activity_log |
| `API_INTERNAL_URL` | `http://api:4000` | Internal URL for API server communication |
| `REDIS_URL` | (required) | Redis connection for session cache |

---

## Client Configuration Examples

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bigbluebam": {
      "url": "https://app.bigbluebam.io/mcp/",
      "headers": {
        "Authorization": "Bearer bbam_your_api_key_here"
      }
    }
  }
}
```

For a local Docker instance:

```json
{
  "mcpServers": {
    "bigbluebam": {
      "url": "http://localhost/mcp/",
      "headers": {
        "Authorization": "Bearer bbam_your_api_key_here"
      }
    }
  }
}
```

For Claude Code via the `claude mcp add` CLI:

```sh
claude mcp add --transport http bigbluebam https://YOUR_DOMAIN/mcp/ \
  --header "Authorization: Bearer bbam_your_api_key_here"
```

For service-account use (the `bbam_svc_` prefix signals a locked, non-login account minted with `docker compose exec api node dist/cli.js create-service-account`), substitute that token for the user key.

### Claude Code

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "bigbluebam": {
      "command": "npx",
      "args": [
        "@bigbluebam/mcp-server",
        "--api-url", "http://localhost/b3/api",
        "--api-key", "bbam_dev_key"
      ]
    }
  }
}
```

### Local Docker (stdio transport)

```json
{
  "mcpServers": {
    "bigbluebam": {
      "command": "docker",
      "args": [
        "exec", "-i", "bigbluebam-mcp-server-1",
        "node", "dist/mcp-stdio.js"
      ],
      "env": {
        "BIGBLUEBAM_API_KEY": "bbam_your_key"
      }
    }
  }
}
```

---

## Typical AI Workflow

```mermaid
sequenceDiagram
    participant User as User (via Claude)
    participant AI as Claude
    participant MCP as MCP Server

    User->>AI: "What's the status of our project?"
    AI->>MCP: list_projects
    MCP-->>AI: [{name: "BigBlueBam", active_sprint: "Sprint 12", open_tasks: 42}]
    AI->>MCP: get_board(project_id)
    MCP-->>AI: Board with 5 phases, 18 tasks in Sprint 12
    AI-->>User: "Sprint 12 has 18 tasks: 3 in Backlog, 5 in To Do, 3 In Progress, 2 in Review, 5 Done..."

    User->>AI: "Create a task for adding dark mode support"
    AI->>MCP: create_task(project_id, title: "Add dark mode support", priority: "medium")
    MCP-->>AI: {human_id: "BBB-156", title: "Add dark mode support"}
    AI-->>User: "Created BBB-156: Add dark mode support (medium priority, in Backlog)"

    User->>AI: "Add a comment about using CSS custom properties"
    AI->>MCP: add_comment(task_id, body: "Consider using CSS custom properties for theme variables...")
    MCP-->>AI: Comment added
    AI-->>User: "Comment added to BBB-156"

    User->>AI: "Show me all overdue tasks"
    AI->>MCP: search_tasks(project_id, due_date_before: "2026-04-02", priority: ["critical","high"])
    MCP-->>AI: 3 overdue tasks
    AI-->>User: "There are 3 overdue tasks: BBB-101 (critical, 5 days overdue)..."
```

---

## Destructive Action Confirmation

Tools that delete tasks, complete sprints, or remove members use a two-step confirmation flow:

```mermaid
sequenceDiagram
    participant AI as AI Client
    participant MCP as MCP Server

    AI->>MCP: delete_task(task_id: "uuid")
    MCP-->>AI: Confirmation required: "Delete BBB-142: Implement OAuth2 login flow?"
    Note right of MCP: Returns action_token<br/>(valid 60 seconds)

    alt AI confirms
        AI->>MCP: confirm_action(action_token: "tok_...")
        MCP-->>AI: Task deleted successfully
    else AI declines or token expires
        AI-->>AI: Action not taken
    end
```

This prevents accidental data loss from AI misinterpretation and gives the AI client (and its human user) a chance to review before irreversible actions execute.
