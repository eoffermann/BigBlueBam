# BigBlueBam - Comprehensive Project Overview

> **Single-source overview.** This document is intended to give one reader - a new senior engineer or a frontier-class LLM - a comprehensive understanding of BigBlueBam: what it is, why it exists, how it works, how it is meant to work, the technology decisions behind it, and how the codebase is organized. It is self-contained: it links to deeper documents (see the Bibliography in section 22) but you should not need them to understand the project. It was assembled by a multi-agent pass over the live codebase and existing docs; where a claim was uncertain or a doc was found stale against the code, that is noted inline.

## Table of Contents

1. [Executive Summary - What BigBlueBam Is](#1-executive-summary-what-bigbluebam-is)
2. [Design Philosophy & Guiding Principles](#2-design-philosophy-guiding-principles)
3. [The Human + Agent Dual-Interface Thesis](#3-the-human-agent-dualinterface-thesis)
4. [The Application Suite](#4-the-application-suite)
5. [How the Apps Work Together](#5-how-the-apps-work-together)
6. [System Architecture](#6-system-architecture)
7. [Tech Stack & Framework Decisions](#7-tech-stack-framework-decisions)
8. [Monorepo Structure & Project Organization](#8-monorepo-structure-project-organization)
9. [Data Layer - Postgres, Schema, Migrations, RLS](#9-data-layer-postgres-schema-migrations-rls)
10. [API Design & Conventions](#10-api-design-conventions)
11. [The MCP Server & Tool Catalog](#11-the-mcp-server-tool-catalog)
12. [The Agentic Platform](#12-the-agentic-platform)
13. [Permissions, AuthZ & Identity](#13-permissions-authz-identity)
14. [Realtime, Background Jobs & Supporting Infrastructure](#14-realtime-background-jobs-supporting-infrastructure)
15. [Coding Standards & Development Workflow](#15-coding-standards-development-workflow)
16. [Documentation Standards & Practices](#16-documentation-standards-practices)
17. [Deployment, Environments & Operations](#17-deployment-environments-operations)
18. [Testing & Quality Gates](#18-testing-quality-gates)
19. [Roadmap & In-Flight Work](#19-roadmap-inflight-work)
20. [Planned but Not Yet Implemented (Designed vs As-Built)](#20-planned-but-not-yet-implemented-designed-vs-as-built)
21. [Documentation Map - What Exists and What Is Missing](#21-documentation-map-what-exists-and-what-is-missing)
22. [Bibliography - Referenced & Further Reading](#22-bibliography-referenced-further-reading)

---

## 1. Executive Summary - What BigBlueBam Is

BigBlueBam is an open-source, self-hostable suite of integrated business applications built on a single shared data model so that **humans and AI agents are equal first-class users of every app**. Nearly every action a person can take through the UI is also exposed as an MCP (Model Context Protocol) tool, so an AI agent authenticates like a user, is bound by the same organization and permission model, and writes to the same boards, pipelines, documents, and tickets with the same audit trail - not through a separate, weaker integration API. As of the current tree (`CLAUDE.md`), the MCP server exposes **733 tools across 46 modules**, spanning per-app catalogs plus 64 cross-cutting platform tools.

### Scope and shape

The suite is **sixteen apps under one auth, one org/user model, and one permission set** (`docs/apps/introduction/help.md`): Bam (project management / Kanban + sprints), Banter (team chat with LiveKit voice/video), Beacon (knowledge base), Brief (collaborative docs), Board (whiteboard), Bolt (workflow automation), Bearing (goals/OKRs), Bond (CRM), Blast (email campaigns), Bench (analytics), Book (scheduling), Blank (forms), Bill (invoicing), Blueprint (structured diagrams), Bureau (virtual office / presence), and Helpdesk (support portal). Every app name follows the **"B-" naming motif** ("BigBlueBam" itself, then Bam/Banter/Beacon/…). The codebase backs this with 15 Fastify API services under `apps/*-api/` plus their SPAs, an `mcp-server`, a `worker`, and the Python `voice-agent`.

> Note: the top-level `README.md` is stale on the headline numbers - it advertises "14 apps" and "340 MCP tools," whereas `CLAUDE.md` and `docs/apps/introduction/help.md` (16 apps, 733 tools, including Bureau and Blueprint) reflect the current state. The design document's Section 1 (`docs/reference/BigBlueBam_Design_Document.md`) predates the suite expansion entirely and describes only the Bam project-planning core.

**Tenancy posture:** multi-tenant by design - `organizations` is the top-level tenant, isolated by PostgreSQL row-level security gated on the `app.current_org_id` GUC (migrations 0116+) - while remaining fully **self-hostable as a single tenant** via `docker compose up`. **Target audience:** small-to-medium teams of 2-50 users (`docs/apps/introduction/help.md`, design doc §1), scaling horizontally by running more copies of the stateless app containers. Licensed **MIT**.

### The differentiating ideas

- **Agents are architecture, not a sidebar.** AI agents act on the same surfaces, permissions, and audit log as people via the 733-tool MCP surface; agency is the design center, not an add-on chat box.
- **One system, one stack, real cross-app links.** Built recently on a single React 19 / Fastify v5 / PostgreSQL 16 stack with a shared data model, so connections (deal → project → invoice, ticket → task, sticky → task) are first-class FKs and entity links, not webhook glue.
- **Events as connective tissue.** Apps emit Bolt events (`publishBoltEvent`, bare-name + explicit `source`) that automations consume, so cross-app flows extend without code.
- **Pervasive presence.** Work surfaces (tasks, deals, docs, diagrams, tickets, boards) are live and shared; a Bureau presence widget follows you across the suite and one-tap voice/video huddles are ambient, not scheduled.
- **Self-host and own your data.** Run the entire stack with one command; data lives in a Postgres database you can query directly and export with plain SQL.
- **Safety rails for autonomy.** Destructive agent actions pass through visibility preflight (`can_access`), durable approval queues, per-agent kill-switch policies, and Redis-backed `confirm_action` tokens.

### Why this exists

Teams run a dozen disconnected tools and spend their day re-keying information between them while each vendor's bolted-on "AI feature" can summarize but cannot act. BigBlueBam collapses that sprawl into one open, self-hostable suite where the apps genuinely share state and where AI agents are full participants that do real work alongside the people they support.

## 2. Design Philosophy & Guiding Principles

BigBlueBam's stated philosophy lives in three layers that mostly agree but occasionally lag behind the code: the original single-product design tenets (`docs/reference/BigBlueBam_Design_Document.md` §2), the suite-wide positioning (`README.md`, `docs/apps/introduction/help.md`, `docs/marketing-voice.md`), and the realized engineering decisions enumerated in `CLAUDE.md`. Read the design document's §2 as scoped to the original Bam project tool; the suite-level tenets supersede it where they conflict.

### Core design tenets

The five guiding principles from the design document (§2) are concrete and largely realized in code:

- **Configuration over convention.** Phases, task states, sprint cadences, card field schemas, and roles are user-defined per project, not hard-coded. This shows up in real schema: custom fields are JSONB on tasks with definitions in `custom_field_definitions`, phases are rows, and task state is orthogonal to phase (a card in "In Progress" can carry state "Blocked"). The §1 executive summary calls this treating "configurability as a first-class citizen."
- **Motion with meaning.** Animation is meant to communicate state change rather than decorate; the frontend is built on Motion (formerly Framer Motion) with optimistic updates that animate their own rollback on failure.
- **Sprints are containers, not cages.** Carry-forward is a first-class concept: tasks track `carry_forward_count` and `original_sprint_id`, and a badge renders on carried cards.
- **Real-time by default** and **keyboard-first, mouse-friendly.** WebSocket realtime over Redis PubSub broadcasts across instances; a command palette (Cmd+K) and keyboard shortcuts are built in.

### Deliberate tradeoffs

Several decisions are explicit bets that trade one property for another:

- **Last-write-wins concurrency.** Conflict resolution is last-write-wins with an `updated_at` stale check returning HTTP 409, rather than operational-transform or CRDT merge for structured data. Board position conflicts are resolved server-side with an authoritative broadcast. The exception is genuinely collaborative surfaces (Brief documents, Board canvas, Blueprint), which use live co-editing; Blueprint deliberately stores diagrams as a typed relational graph (`blueprint_nodes`/`blueprint_edges`) rather than an opaque collab blob, so every mutation is an auditable API call and an MCP tool, with Yjs reserved for a later multiplayer layer.
- **Float positions over integer ordering.** Task positions use float values so reordering avoids renumbering siblings, trading exact ordinal values for cheap inserts.
- **Self-contained search first.** The design favors PostgreSQL full-text (pg_trgm + tsvector) to avoid an external dependency, with Qdrant added only where semantic retrieval is needed (Beacon, Brief, Bond). This is a "fewer moving parts" bias with named upgrade paths.

### Consistency conventions across apps

The suite's coherence is enforced by shared mechanisms, not convention alone:

- **Shared Zod schemas** between client and API (`@bigbluebam/shared`) are the single validation source of truth.
- **One identity and permission model.** All sixteen apps share a single org/user model and role set (owner/admin/member/viewer/guest); who-can-see-what is decided once. Row-level security is gated by the `app.current_org_id` GUC.
- **Uniform API ergonomics:** cursor-based pagination on list endpoints, the `?filter[field]=value` / `?sort=-field` pattern, and a single error envelope (`error.code`, `message`, `details[]`, `request_id`).
- **Bare-name-plus-source Bolt events** (`publishBoltEvent({ event, source, payload })`) with a CI drift guard (`scripts/check-bolt-catalog.mjs`) rejecting source-prefixed names.
- **A documented surface map** (`docs/reference/mcp-endpoint-mapping.md`) required to stay in sync with every REST/MCP/CLI/UI change.

### Agents as first-class operators

The strongest realized differentiator is parity between humans and agents: nearly every human action is also an MCP tool (733 across 46 modules per `CLAUDE.md`), and agents authenticate as users bound by the same roles, RLS, and append-only audit trail. This is backed by concrete infrastructure: service-account keys (`bbam_svc_` prefix, Argon2id-hashed), a fail-closed policy gate with per-agent kill switches and glob allowlists, Redis-backed `confirm_action` tokens (`apps/mcp-server/src/lib/confirm-token-store.ts`) enforcing two-step confirmation on destructive actions, and a visibility preflight (`can_access`) agents must call before surfacing cross-app results. Marketing voice (`docs/marketing-voice.md`) constrains the claim deliberately: say agents *can* act, never *will*; running agents is the customer's responsibility and a future commercial offering, so the platform ships capability, not turnkey automation.

### Openness, self-hosting, own-your-data

This stance is realized, not aspirational. The repo is MIT-licensed (`LICENSE`, "Copyright (c) 2026 Big Blue Ceiling Prototyping & Fabrication, LLC"). The full stack comes up with one `docker compose up`; data services (Postgres, Redis, MinIO/S3, Qdrant) are swappable for managed equivalents by env vars only, and application containers are stateless and scale horizontally. Data lives in a Postgres database the operator can query directly, with no proprietary export wall. The "no hostage data / no contact-sales-to-export" framing in `docs/marketing-voice.md` is consistent with the architecture.

### Aspirational vs. realized

Two caveats. First, RLS enforcement is staged: `BBB_RLS_ENFORCE` defaults *off* during the Wave 1.A rollout, so multi-tenant isolation by policy binding is opt-in rather than always-on in development; the principle is implemented but not yet the default posture. Second, several headline numbers are stale across docs: `README.md` advertises "340 MCP tools" and "14 apps," while `CLAUDE.md` and `docs/apps/introduction/help.md` cite 733 tools (730+) across 16 apps. Treat the per-app `docs/apps/<app>/meta.json` counts and `CLAUDE.md` as authoritative over the README badges.

## 3. The Human + Agent Dual-Interface Thesis

BigBlueBam is built on one defining premise: every capability is reachable by both humans (UI plus REST) and AI agents (MCP tools), and agents are first-class participants in the org, not a chat box bolted onto the side. `docs/apps/introduction/help.md` states it plainly - "Nearly every action a person can take is also an MCP tool ... An agent can plan a sprint, move a deal, triage a ticket, draft a campaign, or run a report" - and the suite ships **more than 730 MCP tools** (733 per `CLAUDE.md`'s `apps/mcp-server` description) across 46 modules to make that real. The agent surface is the same product on the same boards, under the same permissions and the same audit trail, not a separate, weaker API.

### 3.1 What "first-class agent" concretely means

Agent-hood is a set of platform primitives, mostly delivered in AGENTIC_TODO Waves 1-5 (migrations 0127-0140), not a marketing slogan.

- **Identity kinds.** Migration `0127_agent_identity_heartbeat.sql` adds `CREATE TYPE actor_type AS ENUM ('human','agent','service')` and `users.kind actor_type NOT NULL DEFAULT 'human'`. The same migration mirrors that onto `activity_log.actor_type` and backfills historical rows from `users.kind`, so governance queries can distinguish human/agent/service writes without the old `svc+*@system.local` email-pattern inference. (Note a doc/code drift: `AGENT_DEVELOPMENT.md` §2.1 and §11 still claim "There is no `is_agent` column" and "No `actor_type` column on `activity_log`"; that draft predates 0127 and is stale.)
- **Heartbeats and audit.** `0127` also creates `agent_runners` with `last_heartbeat_at`, version, and advertised capabilities. The MCP tools `agent_heartbeat`, `agent_audit`, and `agent_self_report` exist in `apps/mcp-server/src/tools/agent-tools.ts` (lines 22/83/154). `docs/reference/agent-conventions.md` §7 requires agents to call `agent_heartbeat` at least once per minute and `agent_self_report` at the end of each run so the audit trail stays populated.
- **Policies and kill-switches.** Migration `0139_agent_policies.sql` creates `agent_policies` with a per-agent `enabled boolean DEFAULT true` (the kill switch) and `allowed_tools` glob-prefix allowlist (`banter.*`, `bond.*`, …). A policy-check middleware in `apps/mcp-server/src/lib/register-tool.ts` **fail-closes every service-account tool invocation** against that policy, with a short-TTL in-process cache plus Redis PubSub (`agent_policies:invalidate`) for fast propagation. A small always-permitted core set - `get_server_info`, `get_me`, `agent_heartbeat` (`ALWAYS_PERMITTED_TOOLS` in register-tool.ts:65) - runs regardless of policy so a disabled agent can still introspect and mark itself alive. Human callers bypass the gate; unknown callers fail closed.
- **Proposals / HITL.** Migration `0128_agent_proposals.sql` plus `proposal_create` / `proposal_list` / `proposal_decide` (`apps/mcp-server/src/tools/proposal-tools.ts`:21/99/177) give agents a durable cross-app approval queue, emitting `proposal.created` / `proposal.decided` Bolt events on the `platform` source. Per `agent-conventions.md` §6 these surface in a unified Approvals UI at `/b3/approvals`; the lower-latency `confirm_action` two-step token dance stays for in-conversation destructive-action confirmations.
- **Visibility preflight.** Any agent posting cross-app results into a shared surface MUST call `can_access(asker_user_id, entity_type, entity_id)` (MCP) → `POST /v1/visibility/can_access` for every cited entity and drop anything not allowed (`agent-conventions.md` §1). The authoritative `SUPPORTED_ENTITY_TYPES` allowlist lives in `apps/api/src/services/visibility.service.ts` (export at line 80); the docs table of ~30 entity types is documentation kept in lockstep with it. Crucially, `asker_user_id` is the **human whose visibility gates the surface**, not the agent's service account - citing more than the audience may see is treated as a leak.

### 3.2 The dual REST ↔ MCP surface-mapping discipline

The parity claim is enforced by a maintained map, not assumed. `docs/reference/mcp-endpoint-mapping.md` is the authoritative correspondence between every REST endpoint, its MCP tool (or an annotated skip), MCP-only tools, the 11 `cli.ts` commands, and representative UI call sites. Its surface summary (last full survey 2026-06-17) tallies **971 REST endpoints, 718 with an MCP tool, plus 16 MCP-only tools.** The discipline has hard rules: whenever an endpoint or tool is added, removed, or renamed, the matching table is updated in the same change; the MCP column is never a bare ` - ` but either a backtick-wrapped tool name or ` - _(skip: <reason>)_` (auth, multipart/binary, public-inbound, SuperUser/permission admin, internal service-to-service, realtime/Yjs, resolver-done-internally, deferred). The intentional gaps cluster in Bam org/admin (SuperUser and permission-matrix administration, credential/API-key management) and per-app binary/upload/realtime tails - held UI/CLI-only on purpose. It is not yet CI-enforced, so accuracy depends on convention; a self-check (`grep -cE '^\| \`[^|]+\` \| - \|' …` must print `0`) guards against un-annotated gaps.

### 3.3 Bureau: pervasive presence as the third pillar

"Pervasive presence" extends the human+agent thesis from actions to *being there*. The Bureau app (`docs/apps/bureau/help.md`, served at `/bureau/`, 37 MCP tools) is a virtual office - floors, rooms, presence, knocks, summons, bookings - whose defining artifact is the **docked box**: a floating overlay rendered inside every SPA in the suite. It shows your current room, co-occupants, the page you are viewing, audio/video/screen controls, and one-click Invite / Hunt / Bring-everyone-here actions, and because presence is stored server-side it re-attaches to each surface's huddle as you navigate between apps. `docs/apps/introduction/help.md` frames the mental model as "a hallway, not a meeting."

Agents are first-class spatial occupants here too: an agent that enters a room appears on the floor and in the occupants list with an "(A) " prefix, driving Bureau through 30-plus `bureau_*` tools (`bureau_move_self`, `bureau_who_is_in_room`, `bureau_where_is_user`, `bureau_summon`, etc.), all forwarding the caller's token and gated by the same server-side checks as the UI. High-impact spatial actions (`bureau_summon`, `bureau_book_room`, `bureau_delete_floor`, and three more) use the `confirm_action` two-step, are bound by the `bureau.*` `agent_policies` allowlist, and must pass the same `can_access` preflight before a summon, hunt, or co-presence read reveals a destination - the dual-interface and agent-governance guarantees applied to presence itself.

CLAUDE.md mentions Bureau (in MCP tool counts) but its `apps/` block does not enumerate a `bureau`/`bureau-api` directory pair, while docker-compose.yml and nginx do define bureau-api. That's the doc/code discrepancy to flag. Now writing the section.

## 4. The Application Suite

BigBlueBam ships **sixteen end-user applications** that share one login, one organization/user model, and one permission system (`docs/apps/introduction/help.md`). The count is of user-facing products, not containers: most apps are a *pair* of Docker services (a frontend SPA plus its API), and the platform also runs non-app services (the `mcp-server`, `worker`, `migrate`, `livekit`, and the marketing `site`) that are not counted here. The repo's `apps/` directory and `docker-compose.yml` list the service pairs; `infra/nginx/nginx.conf` maps each to a public path. (Note: the `CLAUDE.md` `apps/` block predates Bureau and does not enumerate a `bureau`/`bureau-api` pair, but `docker-compose.yml` and `nginx.conf` define `bureau-api`, so treat the live config as authoritative.)

### Shared anatomy

Every app follows the same shape, which is why the per-app entries below are structured identically:

- **A React SPA** served by the single nginx container at `/<x>/` (e.g. `/bond/`, `/bench/`), built from `apps/<x>/`.
- **A Fastify API** at `/<x>/api/`, proxied by nginx to an internal container (e.g. `location /bond/api/ → http://bond-api:4009/`), built from `apps/<x>-api/`.
- **Drizzle schema modules** under `apps/<x>-api/src/db/schema/`, with all DDL applied through numbered files in `infra/postgres/migrations/`.
- **MCP tools** in `apps/mcp-server/`, giving agents the same actions as the UI (>730 tools suite-wide).
- **Bolt events** published via `publishBoltEvent` and registered in `apps/bolt-api/src/services/event-catalog.ts`.
- **An nginx route** plus a **sequential internal port** (4001 helpdesk, 4002 banter, 4004 beacon, 4005 brief, 4006 bolt, 4007 bearing, 4008 board, 4009 bond, 4010 blast, 4011 bench, 4012 book, 4013 blank, 4014 bill, 4015 blueprint; Bam's api is 4000). Blueprint and Bureau both bind 4015, which is intentional: each runs in its own container namespace and nginx routes by upstream hostname, not port (see the comment at `docker-compose.yml` near the `bureau-api` definition).

### The "B-" naming motif

Every app name begins with **B** (Bam, Banter, Bond, Bench, Bill, Blank, Blast, Blueprint, Board, Bolt, Book, Brief, Beacon, Bearing, Bureau, Helpdesk), echoing the product name. Helpdesk is the lone exception to the B-word convention while still being a first-class app.

### How to read the per-app entries

Each entry that follows names the app and its one-line purpose, then its SPA path, API path and internal port, schema location, MCP tool count, and notable cross-app links and events. Read them as instances of the shared anatomy above; only the domain logic differs.

The apps, in suite order:

### Bam (core / "B3")

**Purpose.** Sprint-based Kanban project management for small-to-medium teams (2-50 users), served at `/b3/`.

**Problem and users.** Product, engineering, and operations teams that need multi-project task tracking with configurable workflows. Bam is the suite's load-bearing app: it owns the canonical `tasks`, `sprints`, `projects`, and `organizations` schemas that every other app cross-references via peer-app stubs.

**Key user-facing features:**

- **Board and sprint management.** Drag-and-drop Kanban board (dnd-kit), sprint start/close with async BullMQ `sprint-close` job, carry-forward mechanic (`carry_forward_count`, `original_sprint_id` on tasks, badge-rendered on cards).
- **Epics, phases, and task states.** Fully configurable per project; phases and states are first-class schema entities.
- **Custom fields.** JSONB-stored per-task, definitions in `custom_field_definitions` per project.
- **Saved views.** Filter/sort/swimlane presets, per-user or shared.
- **Task templates.** Reusable blueprints with title patterns, default fields, and auto-generated subtasks.
- **Time tracking.** Per-user per-day `time_entries` rows; exportable sprint reports.
- **Import.** CSV, Trello, Jira, and GitHub Issues via `import.routes.ts`, handled through `import-tools.ts` in the MCP layer.
- **iCal feed.** Tasks with due dates exported as `.ics`, authenticated via API key in query string (`ical.routes.ts`).
- **Command palette and keyboard shortcuts.** Built into the frontend; Cmd+K for global navigation.
- **People management.** Org admin/member CRUD at `/b3/people`; SuperUser console under `/b3/superuser`.

**AI agent surface (MCP).** The MCP server exposes Bam-core tools across ten dedicated modules: `task-tools.ts` (20 tools), `project-tools.ts` (25), `member-tools.ts` (15), `sprint-tools.ts` (9), `report-tools.ts` (9), `comment-tools.ts` (8), `epic-tools.ts` (6), `import-tools.ts` (6), `bam-resolver-tools.ts` (5), `template-tools.ts` (5) -- 108 tools by direct count (CLAUDE.md states 105; the discrepancy reflects a stale number in that doc). Destructive MCP actions (delete task, complete sprint, remove member) use a two-step `confirm_action` token flow backed by Redis (`mcp:confirm_token:` prefix, 5 min / 60 s TTL depending on approver type). Bam emits 27 Bolt events (source `bam`) registered in `apps/bolt-api/src/services/event-catalog.ts`, covering `task.created`, `task.completed`, `task.upserted`, `sprint.started`, `sprint.completed`, `comment.created`, `epic.created`, `epic.completed`, and more; these trigger Bolt automation rules and cross-app workflows.

**Technical specifics:**

- **API.** Fastify v5, internal port `:4000`, proxied at `/b3/api/`. 66 route files (including internal service-to-service routes), 54 Drizzle schema modules (including `peer-app-stubs/`). As of CLAUDE.md the count was documented as 40 routes / 38 schema modules; actual tree is larger, indicating the doc is stale relative to current code.
- **Frontend.** React 19 SPA, 143 TypeScript source files (CLAUDE.md states ~87, now stale), 8+ page-level components under `apps/frontend/src/pages/`.
- **Realtime.** WebSocket enabled; nginx proxies `/b3/ws` to the API's Socket.IO / native WS layer; Redis PubSub broadcasts across instances.
- **Worker jobs.** `sprint-close` runs asynchronously via BullMQ (`apps/worker/src/jobs/sprint-close.job.ts`).

**Place in the suite.** Bam is production-grade and the suite's organizational anchor. It is not BETA. All other apps either cross-reference its `organizations`/`users` tables or emit/consume Bolt events originating from its schema. The MCP `task_upsert_by_external_id` idempotent upsert tool (in the cross-cutting write plane) also targets Bam tasks, enabling agent-driven task creation from any other app context.

### Banter

**Purpose:** Real-time team messaging -- channels, direct messages, threads, reactions, pins, bookmarks, and scheduled/agent-driven posts -- integrated into the BigBlueBam identity and org model.

**Problem and users:** Teams producing work in Bam, Helpdesk, Bond, and the rest of the suite need a conversation layer that lives alongside that work, not in a separate product with its own login. Banter uses the host org's identity (sign in once to Bam, Banter uses the same session and user list) and lets any tool in the suite drop a task, sprint, or ticket into a channel as a native share action.

**Key user-facing features:**
- **Channels** -- public (anyone may join), private (invite-only), DM (`dm` / `group_dm`, max 8 people). A `#general` default channel is auto-created and auto-joins all active members on first visit.
- **Messages** -- rich text, `@mentions`, emoji, file attachments (uploaded to MinIO/S3), up to 40,000 chars. Drafts persist per channel.
- **Threads** -- replies pinned to a parent message, with an "Also send to channel" option.
- **Reactions, pins (channel-admin only), bookmarks (private per-user).**
- **Read cursor** -- synced server-side and broadcast live so all open tabs update without a reload.
- **Search** -- Postgres full-text over messages you can see, filterable by channel, author, date range, and attachment presence.
- **Quiet hours** -- per-channel policy that holds non-urgent posts until allowed hours; used primarily by agents and automations.
- **Slack import** -- upload a Slack export `.zip`, map users and channels, dry-run available.
- **Past-call read-only history** -- `/banter/calls/:id` shows type, duration, participants, and transcript. Live audio was retired from Banter; every call write endpoint returns HTTP 410 Gone; live audio is now the Bureau docked box (`huddle-banter-<channel_id>`).

**AI agent surface:** 77 MCP tools (per CLAUDE.md), confirmed as "over 50 core tools plus 3 subscription tools" in the help doc (54 + 3 cited as of that writing). Key tool groups: `banter_post_message`, `banter_reply_to_thread`, `banter_react`, `banter_pin_message`, `banter_send_dm/group_dm`, `banter_edit_message`, `banter_delete_message` (confirm-gated), `banter_schedule_post` / `banter_list_scheduled_messages` / `banter_cancel_scheduled_message`, `banter_subscribe_pattern` / `banter_unsubscribe_pattern` / `banter_list_subscriptions` (pattern kinds: `interrogative`, `keyword`, `mention`, `regex`-admin-only), `banter_share_task` / `banter_share_sprint` / `banter_share_ticket`, and read tools (`banter_search_messages`, `banter_browse_channels`, `banter_get_unread`, `banter_mark_read`, etc.). Destructive tools require the two-step `confirm_action` flow. Subscriptions are gated by the channel's `agent_subscription_policy` and org-level `agent_policies` (`banter.*` glob).

**Bolt events** emitted on source `banter`: `channel.created`, `message.posted`, `message.mentioned`, `message.edited`, `reaction.added`, `message.scheduled`, `message.quiet_hours_deferred`, `message.matched`.

**Technical specifics:**
- Internal port: **:4002**, proxied at `/banter/api/`; WebSocket at `/banter/ws`.
- Route files: **22** (`apps/banter-api/src/routes/`).
- Drizzle schema modules: **24** (`apps/banter-api/src/db/schema/`, including `feed.ts`, `agent-subscriptions.ts`, `scheduled-messages.ts`, `call-transcripts.ts`, `slack-imports.ts`).
- Frontend pages: 11 (`apps/banter/src/pages/`), 7 cited in CLAUDE.md (stale count; 11 files observed on disk).
- Realtime: yes -- WebSocket connection at `/banter/ws`, presence broadcast, read-cursor sync, live message delivery.
- Worker jobs: `banter-notification` and `banter-retention` (BullMQ, in `apps/worker/`).

**Place in the suite:** Banter is the communication backbone that other apps surface into. Bam tasks/sprints and Helpdesk tickets can be shared directly into channels. The Bureau docked box (present in all 16 apps) replaced Banter's call initiation for live audio, with Banter retaining only the read-only transcript history. Bolt consumes Banter events to drive cross-app automations. Agents interact with Banter at high volume -- scheduled posts, pattern subscriptions, and entity shares make it a primary agent-accessible channel surface within the suite.

### Beacon

**One line:** Team knowledge base with freshness governance, hybrid semantic search, and a typed knowledge graph.

**Problem and users.** Teams accumulate documentation that goes stale and misleads. Beacon solves this by treating every article as perishable: each Beacon carries an expiry date, a verification count, and a freshness signal computed from when it was last verified. Knowledge owners, org admins, and governance leads use the "Fridge Cleanout" dashboard to identify and act on expiring content. All authenticated BigBlueBam members can read and create articles; edit rights scope to owners and admins.

**Key user-facing features:**

- **Articles (Beacons):** Markdown body, summary, version history, five lifecycle states (Draft, Active, Pending Review, Archived, Retired), four visibility scopes (Public, Org, Project, Private), per-article comments (threaded, Markdown, 4 levels deep), and file attachments (10 MB limit).
- **Hybrid search:** Semantic + tag expansion + link traversal + keyword fallback, with a live result-count footer, shareable URL state, and named saved queries scoped to Private/Project/Org.
- **Knowledge Graph:** Force-directed canvas of typed article links (Related To, Supersedes, Depends On, Conflicts With, See Also) plus implicit Tag Affinity edges. Configurable hop depth (1-3), status-based dimming, NodePopover actions.
- **Freshness governance:** Hierarchical expiry policies (System/Org/Project), a daily BullMQ sweep (`beacon-expiry-sweep`) that advances stale articles through the lifecycle, and bulk Verify/Retire actions in the Dashboard.
- **Known UI gaps:** The editor's tag field does not persist; tags must be written via MCP or API. Links have no human creation UI; agents and the API are the only path. Restore on a Retired article returns a server error (Retired is terminal).

**AI agent surface:** 38 MCP tools (per CLAUDE.md) covering full CRUD, lifecycle transitions, hybrid retrieval (`beacon_search`, `beacon_search_context`), idempotent upsert (`beacon_upsert_by_slug`, keyed on slug, emits `entry.upserted` to Bolt), graph traversal (`beacon_graph_neighbors`, `beacon_graph_hubs`, `beacon_graph_recent`), link management (`beacon_link_create`, `beacon_link_remove`), tag writes (`beacon_tag_add`, `beacon_tag_remove`), saved query management, policy reads/writes, and agent-typed verification (`AgentAutomatic`, `AgentAssisted`, `ScheduledReview` with optional confidence score). Comments and attachments have no MCP tools. Beacon participates in platform-wide `search_everything` and `resolve_references` with `can_access` visibility preflight (entity type `beacon.entry`). Published Bolt events (source `beacon`): `entry.upserted`, `beacon.created`, `beacon.updated`, `beacon.published`, `beacon.verified`, `beacon.challenged`, `comment.created`, `attachment.uploaded`, `beacon.expired`. A nightly BullMQ job (`beacon-vector-sync`) keeps Qdrant vectors current for semantic retrieval.

**Technical specifics:** Internal port `:4004`, proxied at `/beacon/api/`. 9 route files (`beacon`, `search`, `graph`, `link`, `policy`, `tag`, `version`, `comments`, `attachments`). 12 Drizzle schema modules (`beacon-entries`, `beacon-links`, `beacon-tags`, `beacon-verifications`, `beacon-versions`, `beacon-saved-queries`, `beacon-comments`, `beacon-attachments`, `beacon-expiry-policies`, `beacon-agents`, `bbb-refs`, `index`). No WebSocket; all mutations are REST with Redis PubSub for cross-instance broadcast. Frontend SPA at `apps/beacon/src` has 8 pages, served at `/beacon/`.

**Suite position:** Beacon is the suite's RAG substrate. Other apps and agents retrieve grounded knowledge from it via `search_everything`; Bond, Bam, Brief, and Helpdesk agents are expected callers. Bolt automations consume its lifecycle events. It shares Bam's session and project list.

### Bearing

**Purpose:** Goals and OKR tracker for BigBlueBam teams.

**Problem and users:** Teams running a regular OKR cadence need a way to set time-boxed objectives, attach measurable key results, check in on progress, and surface goals that are drifting before the period ends. Bearing serves team leads, individual contributors, and org admins at small-to-medium orgs.

**Key user-facing features:**
- **Periods** -- named time boxes (Quarter, Half Year, Year, Custom) with a lifecycle: planning, active, completed, archived. The whole UI scopes to one selected period.
- **Goals Dashboard** -- period stats (total goals, avg progress, at-risk count, achieved count), scope tabs (Org/Team/Project/Individual), search, and a goal card grid grouped by scope.
- **Goal Detail** -- title/description, status badge, progress bar (actual vs. expected), key result list with sparklines and current/target readouts, progress-over-time chart, status update feed, and a watchers sidebar card.
- **Key Results** -- metric types: Number, Percentage, Currency, Yes/No. Each check-in records a snapshot that feeds sparklines and the history chart. Goal progress is the average of its KRs.
- **At Risk view** -- goals with status `at_risk` or `behind` sorted by gap from expected progress.
- **My Goals** -- cross-period list of goals owned by the signed-in user, split into Active and Completed.
- Reports and CSV export are API/MCP-only; no human screen for them in this build. Goal-owner reassignment and KR-to-Bam linking are also agent/REST-only.

**Technical specifics:**
- Internal port: 4007, proxied at `/bearing/api/`.
- No WebSocket/realtime (REST only; background recompute job runs server-side).
- Route files: 4 (`goals.ts`, `key-results.ts`, `periods.ts`, `reports.ts`) plus an `index.ts` registrar.
- Drizzle schema modules: 8 (`bearing-goals`, `bearing-periods`, `bearing-key-results`, `bearing-kr-links`, `bearing-kr-snapshots`, `bearing-updates`, `bearing-goal-watchers`, `bbb-refs`).
- Frontend pages: 5 (`DashboardPage`, `GoalDetailPage`, `MyGoalsPage`, `AtRiskPage`, `PeriodListPage`).
- CLAUDE.md states 4 route files and 9 schema modules; the live directory shows 4 routes and 8 schema modules (CLAUDE.md count is off by one on schema).

**AI agent surface:** 30 MCP tools enumerated in `help.md` covering periods (7 tools), goals (11), key results (9), and updates/reports (3). Notable agent-only capabilities: `bearing_goal_status_override` (bypass auto-derived status), `bearing_kr_link`/`bearing_kr_unlink` (bind a KR to a Bam epic/project/sprint/task for automatic recompute), and `bearing_report` (markdown period, at-risk, or owner report). Bolt events fired include goal created/updated/status-changed/achieved/deleted, KR created/updated/linked/deleted, period activated/completed/archived. The background `bearing-recompute` worker job keeps linked KRs current as Bam tasks reach done state; `bearing-digest` and `bearing-snapshot` are additional registered job handlers in the worker.

**Suite position:** Bearing depends on a live Bam session for auth and optionally links KRs directly to Bam epics/sprints/tasks. It emits events consumed by Bolt automations and feeds data into Bench dashboards. Agent-generated OKR digests are commonly routed to Banter or Brief.

All claims are now grounded in actual code and the help doc. Here is the result:

### Bench

**Purpose:** Cross-suite analytics dashboard builder -- a read-and-visualize layer over BigBlueBam operational data.

**Problem and users:** Operators, leads, and AI agents need a single place to aggregate and chart data from Bam, Bond, Blast, Beacon, Bearing, Bureau, and Helpdesk without writing SQL or leaving the suite. Bench provides that: dashboards composed of typed widgets, an ad-hoc explorer, saved queries, and scheduled report delivery.

**Key user-facing features:**

- **Dashboards** -- named, visibility-scoped (Private / Project / Org) containers of drag-reorderable widgets with optional auto-refresh and a fullscreen kiosk mode.
- **Widget Wizard / Widget Edit** -- four-step builder plus a full live-preview editor; eleven chart types (bar, line, area, pie, donut, KPI card, counter, table, funnel, gauge, progress bar).
- **Widget Templates gallery** -- category-filtered prebuilt presets across Project Management, CRM, Email Marketing, and Cross-Product (Support presets build but return no data because the `tickets` table lacks an org column).
- **Ad-Hoc Explorer** -- interactive source query at `/explorer`; runs a fixed shape per source from the UI; full measure/dimension/filter control is agent-only via MCP.
- **Saved Queries** -- reusable query definitions openable directly in the Explorer.
- **Scheduled Reports** -- cron-driven dashboard snapshots delivered via Email, Banter Channel, or Brief Document (PDF/PNG/CSV); delivery is currently a stub that stamps status but sends nothing.
- **Data source registry** -- compile-time allowlist of 11 registered `(product, entity)` pairs; two (`helpdesk:tickets`, `bench:daily_task_throughput`) return no data due to missing org columns on their backing tables.

**AI agent surface:** 32 MCP tools registered in `apps/mcp-server/src/tools/bench-tools.ts`. Covers full CRUD for dashboards, widgets, saved queries, and scheduled reports, plus `bench_query_ad_hoc`, `bench_summarize_dashboard`, `bench_detect_anomalies` (flags >30% period-over-period swings), and `bench_compare_periods`. Emits the `report.delivered` Bolt event (source `bench`) on report completion.

**Technical specifics:** Internal port `4011` (confirmed in `docker-compose.yml`). No WebSocket; all communication is REST. 6 route files (`dashboards`, `data-sources`, `materialized-views`, `reports`, `saved-queries`, `widgets`). 10 schema modules under `apps/bench-api/src/db/schema/`. 9 frontend pages under `apps/bench/src/pages/`. Served at `/bench/`, proxied to `bench-api:4011`.

**Suite position:** A pure read layer. Bench queries other apps' tables through the registry allowlist and never writes to them. It depends on Bam, Bond, Blast, Beacon, Bearing, Bureau, Banter, and Brief as data or delivery targets, and surfaces cross-suite aggregates that no single operational app can provide alone.

### Bill

**One-line purpose:** Invoicing, expense tracking, and recurring billing for client work, scoped to an org within the BigBlueBam suite.

**Problem and users:** Teams that bill clients for project work need to convert tracked hours and won deals into invoices, record payments, manage project costs through an approval flow, and run basic financial reports without leaving the suite. Bill is used by members who prepare drafts and log expenses, and by admins and owners who finalize, send, approve, and reimburse.

**Key user-facing features:**

- **Invoices** with a `draft`/`sent`/`viewed`/`partially_paid`/`paid`/`void` lifecycle; all money stored in integer cents; number format `{prefix}-{n:05d}` assigned only on finalize; PDF generation on demand via a background job; public view token for unauthenticated client access.
- **Invoice creation paths:** blank draft, generate from Bam time entries (`POST /bill/api/v1/invoices/from-time-entries`), or generate from a Bond deal.
- **Recurring schedules** at weekly/monthly/quarterly/annual cadences, with auto-finalize or draft mode; materialized by a daily worker sweep (`apps/worker/src/jobs/bill-overdue-reminder.job.ts` handles the overdue sweep; recurring generation is in the recurring-invoices service).
- **Expenses** with a `pending`/`approved`/`rejected`/`reimbursed` lifecycle; billable flag; receipt upload via API (no UI button exists yet).
- **Rates** scoped to org, project, user, or user-on-project, with effective date ranges; resolver picks the most specific applicable rate.
- **Financial reports:** Revenue by Month, Outstanding Aging, Project Profitability, Overdue Invoices; overdue is computed from due date, not a stored status.

**MCP / automation:** 47 MCP tools registered in `apps/mcp-server/src/tools/bill-tools.ts`, covering the full lifecycle (drafting, line items, finalize, send, payments, clients, expenses, rates, recurring schedules, reports, settings). Bolt events published on source `bill`: `invoice.created`, `invoice.finalized`, `invoice.sent`, `invoice.paid` (from `payment.service.ts`), `payment.recorded`, `recurring.invoice_generated`, `invoice.overdue` (from the worker job). Bond-to-Bill handoff is `bill_create_invoice_from_deal`; time-to-invoice is `bill_create_invoice_from_time`. Finalize and send are gated on admin/owner role even for agent callers.

**Technical specifics:** Internal port `4014` (confirmed in `apps/bill-api/src/env.ts`). No WebSocket or realtime; HTTP only. API: 8 route files (`invoices`, `payments`, `clients`, `expenses`, `rates`, `recurring-invoices`, `reports`, `settings`, `public`), 11 Drizzle schema modules. Frontend SPA: 29 source files across pages, hooks, components, and stores. No beta designation; the feature set is substantially complete, with one noted gap (receipt upload and expense edits have no UI buttons, API and MCP only).

**Suite position:** Bill is the revenue-collection layer. It consumes time data from Bam, deal values from Bond, and routes approval requests through Bam's approval queue (posting a Banter DM via Bolt). Bolt automation rules react to Bill's events to orchestrate dunning, notifications, and cross-app workflows.

### Blank

**Purpose:** No-code forms and surveys builder with public submission collection, analytics, and AI-agent authoring support.

**Problem and users:** Teams need to capture structured input (feedback, intake, bug reports, NPS surveys) from respondents who may or may not be BigBlueBam members, without writing code. Authors log in to build and publish forms; respondents fill them out at a public URL with no login required (unless the form enforces it).

**Key user-facing features:**
- **Visual form builder** (`/blank/forms/<id>/edit`) with a 22-type field palette (Short Text through Page Break), drag-to-reorder, live-preview panel, and per-field conditional-display config (stored on the field; no visual conditional editor yet).
- **Visibility and access gating:** Public / Organization / Project-members scoping, optional sign-in requirement, allowed-email-domain allowlist, per-email submission cap, expiration date, and max response count -- all stackable.
- **File Upload fields:** Files land in MinIO/S3 before form submission; a background worker validates type (extension + MIME allowlist, SVG always blocked) and records a download link. The Responses table exposes a pending/processing/complete/failed status pill.
- **Responses and Analytics:** Tabular responses view with CSV export, attachment-status filter, and an analytics page with a 30-day bar chart plus per-field breakdowns (option counts for selects; avg/min/max/count for numeric types).
- **Multi-page forms** via Page Break fields or per-field Page Number, with optional progress bar.
- **Submission routing:** API-level config can route submissions into Bond (as a contact) or Helpdesk (as a ticket).
- **Notifications:** Email to configured recipients and optional post to a Banter channel on each new submission, dispatched by the BullMQ worker.

**Technical specifics:**
- Internal port: 4013; proxied at `/blank/api/`.
- No WebSocket/realtime. No Yjs.
- Route files: 4 (`forms.routes.ts`, `fields.routes.ts`, `submissions.routes.ts`, `public.routes.ts`).
- Schema modules: 5 (`blank-forms`, `blank-form-fields`, `blank-submissions`, `bbb-refs`, `index`).
- Frontend pages: 8 (`form-list`, `form-builder`, `form-builder` settings dialog, `form-preview`, `form-responses`, `form-analytics`, `form-settings`, `public-form`, `settings`).
- Bolt events emitted (source `blank`): `form.published`, `form.closed`, `submission.created`.

**AI agent surface:** 20 MCP tools covering the full lifecycle -- `blank_generate_form` (heuristic spec from description, no-save), `blank_create_form`, `blank_add_field` / `blank_update_field` / `blank_delete_field` / `blank_reorder_fields`, `blank_publish_form`, `blank_close_form`, `blank_duplicate_form`, `blank_delete_form`, `blank_get_embed_code`, `blank_list_forms`, `blank_get_form`, `blank_update_form`, `blank_list_submissions`, `blank_get_submission`, `blank_summarize_responses`, `blank_get_form_analytics`, `blank_export_submissions` (returns CSV text), `blank_delete_submission`. Several tools (close, per-submission detail, conditional-field editing, embed code) have no matching SPA screen. Per-agent policies gate these under a `blank.*` allowlist; destructive steps can be routed through the approval queue.

**Place in the suite:** Blank is the intake layer. It connects upstream to Bam (Project-members scoping loads Bam projects), Bond and Helpdesk (submission routing), Banter (channel notifications), and Bolt (three emitted events). It is not marked BETA; the CLAUDE.md entry describes it as shipping with 4 route files and 5 schema modules, consistent with the code.

### Blast

**Purpose:** Email campaign tool for targeting Bond CRM contacts, sending bulk HTML email, and tracking engagement.

**Problem and users:** Marketers and operators need to turn CRM contact data into email audiences, send one-off or recurring campaigns, and measure delivery quality (open rate, click rate, bounce, complaints) without managing a separate email platform. Blast fills that gap within the suite, sharing the platform SMTP relay and the same login session as every other BigBlueBam app.

**Key user-facing features:**

- **Campaigns** -- create drafts with a visual block editor, raw HTML, or from a saved template; send immediately via "Send Now"; six status states (`draft`, `scheduled`, `sending`, `paused`, `sent`, `cancelled`).
- **Templates** -- reusable email designs with auto-bumping version numbers; Visual and HTML authoring modes; duplicate action.
- **Segments** -- saved Bond-contact filters (AND/OR conditions over lifecycle stage, lead source, score, city, country, last contacted); cached contact counts; `Recalculate count` action. The UI exposes 6 fields/7 operators; the API and MCP tools surface additional fields (`email`, `first_name`, `last_name`) and operators (`is_set`, `is_not_set`). Known limitation: segment filtering is not yet honored by the sender at send time -- all eligible org contacts (minus unsubscribed addresses) receive the campaign regardless of segment selection.
- **Analytics** -- org-wide roll-up (total sent, delivered, avg open/click rate, bounce rate, weekly engagement trend); per-campaign metrics and paginated per-recipient delivery table.
- **Sender domains** -- SPF/DKIM/DMARC verification flow; DNS record display and live verification check.
- **SMTP** -- information page only; outbound relay is configured once platform-wide in the Bam app at `/b3/settings`, not per-org in Blast.
- **Tracking and compliance** -- open pixel, click redirect (via `/t/`), org-wide unsubscribe suppression (via `/unsub/`), provider webhook ingest for bounces/complaints, CAN-SPAM gate on every send (HTML body must contain unsubscribe mechanism and physical address).

**MCP / agent surface:** 28 MCP tools. Key ones: `blast_draft_campaign`, `blast_send_campaign` (defaults `require_human_approval: true`, scheduling ~1 hour out rather than sending immediately), `blast_pause_campaign`, `blast_cancel_campaign`, `blast_update_campaign`, `blast_create_template` / `blast_update_template` / `blast_duplicate_template` / `blast_preview_template`, `blast_create_segment` / `blast_update_segment` / `blast_preview_segment` / `blast_evaluate_segment` / `blast_recalculate_segment_count` / `blast_check_unsubscribed`, and analytics readers (`blast_get_campaign_analytics`, `blast_get_campaign_device_analytics`, `blast_get_engagement_summary`, `blast_get_engagement_trend`). Tools resolve campaigns/templates/segments by human-readable name as well as UUID. `blast_draft_email_content` and `blast_suggest_subject_lines` are scaffold stubs returning hard-coded strings, not model-generated copy. The `blast.*` prefix is a configurable allowlist prefix in agent policies.

**Bolt events published** (source `blast`): `campaign.created`, `campaign.sent`, `campaign.completed`, `engagement.opened`, `engagement.clicked`, `engagement.unsubscribed`, `engagement.bounced`. These let Bolt rules react to campaign activity and flow engagement data back to Bond contact timelines.

**Technical specifics:**

- Internal port: **4010**, proxied at `/blast/api/`; tracking at `/t/`, unsubscribe at `/unsub/`.
- No WebSocket / realtime layer (all state is polled via REST).
- Route files: **7** (`analytics.routes.ts`, `campaigns.routes.ts`, `segments.routes.ts`, `sender-domains.routes.ts`, `templates.routes.ts`, `tracking.routes.ts`, `webhooks.routes.ts`).
- Drizzle schema modules: **8** (campaigns, engagement-events, segments, send-log, sender-domains, templates, unsubscribes, plus bbb-refs).
- Frontend pages: 10 (campaign list, campaign new, campaign detail, template gallery, template editor, segment list, segment builder, analytics dashboard, domain settings, SMTP settings).

**Suite position:** Blast sits downstream of Bond (contacts as audience) and upstream of Bolt (engagement events as automation triggers). It shares the platform SMTP relay and login with Bam. Scheduling, pausing, cancelling, editing, and deleting campaigns are API/MCP-only actions; the campaign detail UI exposes only Send Now. The help doc explicitly flags the guide's mention of "A/B testing" and an "archived" state as unimplemented -- treat the help doc as authoritative over the guide.

### Blueprint

**Purpose:** A structured-diagram editor in which every diagram is a typed relational graph of rows, not an opaque drawing blob.

**Problem and audience:** Teams need process maps, org charts, flowcharts, and system diagrams that are auditable, version-controlled, and machine-readable. Blueprint serves any BigBlueBam user who wants a canvas that both humans and AI agents can create, read, and mutate through the same API surface, with a full audit trail and live two-way sync to Bam tasks.

**Key user-facing features:**
- **Canvas editor** at `/blueprint/d/<id>` built on React Flow; supports five node shapes, five edge kinds, drag-to-connect, resize handles, snap-to-grid, and a right-click context menu.
- **ELK auto-layout** (server-side): Layered, Force-directed, Tree (mrtree), and Grid (rectpacking) via the UI dropdown; Radial is API/agent-only via `blueprint_apply_layout`.
- **Snapshots (versions)** with labeled restore points, managed from the History panel.
- **Comments** (diagram-level or node-anchored, markdown, resolvable threads) and **collaborators** (Owner/Editor/Commenter/Viewer roles) in dedicated side panels.
- **Bam round-trip:** generate a diagram from a Bam project (one node per task, edges from parent/child links), or promote a diagram back to Bam tasks; linked nodes stay in live two-way title+description sync.
- **Cross-product node links** to bam.task, beacon.entry, bearing.goal, bond.deal, bond.contact, helpdesk.ticket (only bam.task has live sync).
- **Mermaid and JSON export** (in-editor); SVG/PNG deferred to a worker path not yet exposed in the UI. Mermaid import is API/agent-only; no in-editor paste UI exists yet.
- **Templates:** the `blueprint_templates` schema module and the New Diagram dialog expose a template selector, but template content is never applied to new diagrams as of the current code -- treat every new diagram as a blank canvas.

**AI agent surface:** 36 MCP tools covering the full graph surface: `blueprint_create`, `blueprint_generate` (1-500 node specs, up to 2000 edge specs, optional `replace: true`), `blueprint_import_mermaid`, `blueprint_apply_layout`, incremental node/edge CRUD, `blueprint_generate_from_bam`, `blueprint_promote_graph_to_tasks`, `blueprint_promote_node_to_task`, `blueprint_link_entity`, snapshot/version management, comment and collaborator management, `blueprint_star`/`blueprint_unstar`, `blueprint_search`, `blueprint_export`. Destructive tools (`blueprint_archive`, `blueprint_delete_node`, `blueprint_delete_edge`, `blueprint_restore_version`, `blueprint_remove_collaborator`) require a second call with `confirm_action: true`. Service-account calls are checked against the platform `agent_policies` kill switch and the `blueprint.*` prefix allowlist. All agent mutations appear in the unified activity feed under the agent's identity.

**Technical specifics:**
- Internal port: **4015**, proxied at `/blueprint/api/`; WebSocket proxied at `/blueprint/ws` (Hocuspocus follow-up, not yet live).
- Route files: **4** functional routes (`diagrams`, `nodes`, `edges`, `templates`) plus `cross-product.routes.ts` and `ws.routes.ts` (6 files under `routes/`, plus `index.ts`).
- Drizzle schema modules: **10** (`blueprint-diagrams`, `blueprint-nodes`, `blueprint-edges`, `blueprint-collaborators`, `blueprint-comments`, `blueprint-versions`, `blueprint-stars`, `blueprint-templates`, `bam-task-stubs`, `bbb-refs`).
- Realtime: polling-based live collaboration refresh (React Query refetch on WebSocket events); the Hocuspocus/Yjs multiplayer layer is deferred.
- Frontend pages: `list.tsx` (diagram library) and `editor.tsx` (canvas), with subfolders `canvas/`, `components/`, `hooks/`, `stores/`.

**Suite position:** Blueprint is the diagramming layer of the suite. It is the natural entry point for planning work visually before committing it to Bam, and the natural output surface for agents synthesizing process descriptions or org structures into editable graphs. It is generally available (not marked BETA), though Mermaid import, image export, template seeding, and the WebSocket multiplayer layer are either API-only or deferred.

### Board

**Purpose:** Infinite-canvas visual whiteboarding for teams, served at `/board/`.

**Problem and audience:** Replaces ad-hoc screenshot decks and external whiteboard tools for teams already in BigBlueBam. Primary users are facilitators running retros, brainstorming sessions, architecture reviews, and planning workshops; any org member with BigBlueBam access can view or edit boards according to visibility rules.

**Key user-facing features:**
- **Excalidraw canvas** -- shapes, stickies, text, arrows, freehand, frames, and images on an infinite scroll. Auto-saves locally and to the server; no Save button.
- **Real-time collaboration** -- live cursor sync and canvas edits over WebSocket; connection badge shows Live/Connecting/Offline; catches up on reconnect.
- **Visibility and locking** -- per-board visibility (`private`, `project`, `organization`); lock flag freezes edits for non-owners.
- **Templates** -- system and org-custom blueprints across seven categories (General, Retro, Brainstorm, Planning, Architecture, Strategy, All).
- **Version snapshots** -- named restore points; description, element-count, and creator fields exist in the schema but do not return data from the backend today.
- **Chat panel** -- per-board side-thread, poll-refreshed (not realtime push), up to 100 messages.
- **Export** -- server-rendered PNG and SVG via `GET /boards/:id/export/:format`.
- **Element limits** -- soft cap at 500, hard cap at 2 000 live elements.
- **Collaborator management** -- full backend exists; no in-app UI screen ships yet.
- **Audio huddle** -- surfaced through the platform-wide Bureau presence strip in the toolbar; Board itself does not host the audio infrastructure.

**AI agent surface (40 MCP tools):** Tools cover the full lifecycle: discovery (`board_list`, `board_get`, `board_list_recent`, `board_stats`, `board_org_stats`, `board_search`), canvas read (`board_read_elements`, `board_read_stickies`, `board_read_frames`, `board_summarize`), canvas write (`board_create`, `board_add_sticky`, `board_add_text`, `board_update`), lifecycle (`board_duplicate`, `board_archive`, `board_restore`, `board_delete_permanent`, `board_export`), collaborators (`board_add_collaborator`, `board_list_collaborators`, `board_update_collaborator`, `board_remove_collaborator`), templates (`board_list_templates`, `board_create_template`, `board_update_template`, `board_delete_template`, `board_instantiate_template`), versions (`board_list_versions`, `board_create_version`, `board_restore_version`), chat (`board_read_chat`, `board_post_chat`), links (`board_list_links`, `board_delete_link`), integrity (`board_check_integrity`, `board_remediate_integrity`), and `board_star_toggle`. The marquee cross-app agent flow is `board_promote_to_tasks`, which converts sticky notes into real Bam tasks in a named project and phase -- there is no human UI button for this. Lock toggle has no MCP tool; `board_update` does not accept a `locked` field.

**Bolt events emitted:** `board.created`, `board.updated`, `board.locked`, `board.elements_promoted`.

**Technical specifics:**
- Internal port: **4008** (`board-api`), proxied at `/board/api/` and `/board/ws`.
- Route files: **9** (`board`, `chat`, `collaborator`, `element`, `internal`, `link`, `scene`, `template`, `version`).
- Drizzle schema modules: **10** (`boards`, `board-elements`, `board-chat-messages`, `board-collaborators`, `board-stars`, `board-task-links`, `board-templates`, `board-versions`, `board-integrity-audit`, `bbb-refs`).
- WebSocket: yes -- real-time canvas sync runs over the `/board/ws` proxy.
- Auth: shared BigBlueBam session cookie; no separate login.

**Place in the suite:** Board is the spatial-thinking complement to Bam (tasks) and Brief (documents). It integrates directionally with Bam via project scoping and promote-to-tasks, and with Bolt via events. It consumes the platform presence/audio layer rather than implementing its own. The collaborator management UI gap and the version-snapshot metadata gap (description/element-count not persisted) are the two most prominent known limitations.

### Bolt

**Purpose:** Suite-wide event-driven automation engine. Bolt watches for events published by every BigBlueBam app and executes user-defined trigger-condition-action rules in response.

**Problem and users:** Teams that want work to happen automatically when something changes elsewhere in the suite -- a deal goes stale in Bond, a ticket breaches SLA in Helpdesk, a task is created in Bam -- without hand-wiring app-to-app integrations. Primary users are operations leads and team administrators; AI agents are a first-class consumer as well.

**Key user-facing features:**
- **Automations editor** (Simple and Visual modes): WHEN/IF/THEN structure with one trigger (14 sources, including a Schedule/cron source), optional AND/OR conditions (13 operators), and an ordered linear action list. No branching flows; later steps can reference earlier results via `{{ step[N].result.* }}` templates.
- **16 built-in templates** covering common cross-app chains; some are marked "(requires agent)" for the cross-app leg.
- **Execution Log** (org-wide and per-automation): status (Running/Success/Partial/Failed/Skipped), per-step timelines, raw trigger event JSON, condition evaluation scores. Failed/Partial runs are retryable.
- **Test Run**: evaluates conditions against a simulated event without executing actions.
- **Limits per automation**: Max Executions/Hour (1-1000, default 60) and Cooldown (0-3600 s).

**AI agent usage:** 26 MCP tools (help.md count; CLAUDE.md records 24, suggesting 2 were added after that count was written). Covers authoring (`bolt_create`, `bolt_update`, `bolt_patch`, `bolt_duplicate`, `bolt_delete`), discovery (`bolt_events`, `bolt_actions`, `bolt_list_templates`, `bolt_instantiate_template`), inspection (`bolt_executions`, `bolt_execution_detail`, `bolt_event_trace`, `bolt_recent_events`), dry-run (`bolt_test`), versioning (`bolt_list_versions`, `bolt_restore_version` -- no in-app UI for versioning), and AI drafting (`bolt_generate`, `bolt_explain` -- also no in-app UI, requires an LLM provider). Agents receive the `catalog.drift_detected` platform event when an unknown event name is ingested. The `bolt-execute` and `bolt-schedule-tick` BullMQ worker jobs are Bolt's execution substrate.

**Technical specifics:** Internal port `:4006`, proxied at `/bolt/api/`. No WebSocket (REST only). Route files: 7 (`automation.routes.ts`, `event-ingestion.routes.ts`, `event.routes.ts`, `execution.routes.ts`, `observability.routes.ts`, `template.routes.ts`, `ai-assist.routes.ts` -- CLAUDE.md says 6, the ai-assist file is a later addition). Schema modules: 9 (`bolt-automations`, `bolt-conditions`, `bolt-actions`, `bolt-executions`, `bolt-execution-steps`, `bolt-schedules`, `bolt-automation-versions`, `bolt-automation-data-migrations`, `bbb-refs`). Events use bare-name-plus-explicit-source convention (`deal.rotting` + `source: 'bond'`, not `bond.deal.rotting`); the `check-bolt-catalog.mjs` drift guard enforces this in CI against 122 registered events.

**Place in the suite:** Bolt is the suite's single event convergence point. Every app routes its activity through the shared `publishBoltEvent` helper; Bolt is therefore the natural observability and automation hub for cross-app workflows.

### Bond

**Purpose:** CRM for tracking contacts, companies, and deals through a configurable sales pipeline.

**Problem and users:** Sales reps, SDRs, and sales managers need a single place to log relationship touches, move revenue opportunities through defined stages, and report on forecast and close rates. Bond provides that inside the BigBlueBam suite rather than requiring a separate CRM product.

**Key user-facing features:**
- **Pipeline board** -- Kanban-style deal cards draggable between stage columns, with swimlane grouping by owner or close month; orange/red rotting indicators when days-in-stage exceeds the stage threshold.
- **Contacts and Companies lists** -- searchable address book with lifecycle-stage filtering, lead scoring (0-100, rule-driven), soft delete with inline restore.
- **Deal detail** -- full record at `/deals/:id` with stage history, inline activity logging, and a Related panel surfacing linked Bill invoices, Book events, and Bam tasks.
- **Analytics** -- pipeline summary, weighted forecast bucketed by close-date horizon, deal velocity per stage, win rate, top loss reasons and competitors, stale-deals drill-down.
- **Settings** -- pipeline and stage administration, custom fields (Text/Number/Date/Select/Multi-Select/URL/Email/Phone/Boolean, org-wide per entity type), lead scoring rules.

**Technical specifics:**
- Internal port: 4009, proxied at `/bond/api/`.
- No WebSocket; REST only.
- 9 route files (`activities`, `analytics`, `companies`, `contacts`, `custom-fields`, `deals`, `dedupe`, `imports`, `internal`, `pipelines`, `scoring`, `user-settings`, plus `index.ts` -- 12 files in the routes directory excluding index).
- 14 Drizzle schema modules (as stated in CLAUDE.md, confirmed by directory count).
- **69 MCP tools** per CLAUDE.md, grouped under `bond.*` in agent policies.

**AI agent surface:** Bond has the largest single-app MCP catalog in the suite by CLAUDE.md count. Agents can do everything the UI does plus several actions the UI omits: `bond_upsert_contact` (idempotent ingest by email, part of the platform write plane), `bond_score_lead` (no in-app recalculate button), `bond_reorder_stages` and `bond_update_stage` (stage probability/rotting/color/order, inaccessible from Settings UI), `bond_restore_deal`, `bond_duplicate_deal`, `bond_find_duplicates` + `bond_merge_contacts` (dedup loop, no in-app screen). Bond emits nine Bolt events on source `bond`: `deal.created`, `deal.updated`, `deal.stage_changed`, `deal.won`, `deal.lost`, `contact.created`, `contact.upserted`, `activity.logged`, `deal.rotting`. The `deal.rotting` event is also emitted by a daily 2 AM UTC worker job (`bond-stale-deals` handler) for open deals aged past their stage threshold.

**Suite position:** Bond feeds Blast email segments, Bench reports, and Bill/Book/Bam cross-links on the deal Related panel. It is a production-grade app, not marked BETA.

### Book

**Purpose:** Personal and team calendar, availability computation, and public scheduling-link app for the BigBlueBam suite.

**Problem and users:** Teams and individuals need to schedule meetings, publish self-service booking links for external visitors, and see a cross-app timeline that combines their calendar events with Bam task due dates and Bond deal close dates. Book serves any authenticated BigBlueBam user; the public booking flow (`/book/meet/<slug>`) is open to unauthenticated visitors.

**Key user-facing features:**
- **Calendar views:** Week (default landing), Day, and Month grids; event creation and editing via a form (drag-to-create and drag-to-resize are not implemented).
- **Event model:** `tentative`/`confirmed`/`cancelled` status; `free`/`busy`/`tentative`/`out_of_office` visibility controlling availability; soft-cancel semantics. Recurrence is stored but not expanded; reminders are UI-only (not persisted or executed).
- **Attendees and RSVP:** Attendees are set at creation time via API or agent; the human form cannot add them. RSVP (`accepted`/`declined`/`tentative`) is available on the event detail page at `/book/events/<id>`.
- **Working Hours:** Per-user weekly availability windows (Mon-Fri 09:00-17:00 default) that feed availability calculation and booking-page slot generation.
- **Booking pages:** Public scheduling links at `/book/meet/<slug>`; support duration, pre/post buffers, and brand color. Creating a booking optionally auto-creates or updates a Bond contact by email (`auto_create_bond_contact` defaults on) and can spawn a Bam task (`auto_create_bam_task` + `bam_project_id`). Slot collisions are guarded by a row lock returning HTTP 409.
- **Timeline:** Cross-app read-only week view aggregating Book events, Bam task due dates, and Bond deal close dates.
- **External connections:** `.ics` feed subscription (no credentials required; background sync every ~15 minutes). Google Calendar and Microsoft Outlook two-way sync uses the same engine but requires operator-supplied OAuth credentials (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`) before connections can be created.
- **iCal feed export:** Token-authenticated `.ics` URL per calendar via `POST /calendars/:id/ical`; no UI button exists yet.
- **First-use provisioning:** A personal `My Calendar` is created automatically on first access; no setup required.

**AI agent surface:**
- **25 MCP tools** covering events (list, get, create, update, cancel, RSVP), calendars (list, create, update, delete), booking pages (list, create, update, delete), working hours (get, set), availability (`book_get_availability`, `book_get_team_availability`, `book_find_meeting_time`, `book_find_meeting_time_for_users`), timeline (`book_get_timeline`), and external connections (create, list, sync, delete). The availability and meeting-time finder tools have no human UI counterpart and are the primary agent use case.
- **5 Bolt events** published from source `book`: `event.created`, `event.updated`, `event.cancelled`, `event.rsvp`, `booking.created`. The `booking.created` event fires on every public booking and is the canonical trigger for downstream CRM or notification automations.
- `book_update_booking_page` is the only path to set `enabled`, advance limit, minimum notice, confirmation message, redirect URL, and the cross-app auto-create flags, none of which the human editor exposes.

**Technical specifics:**
- **Internal port:** `:4012`, proxied at `/book/api/`.
- **Realtime/WebSocket:** None. The API is pure REST; no WebSocket or Yjs layer.
- **Route files:** 9 (`calendars`, `events`, `availability`, `ical`, `timeline`, `booking-pages`, `connections`, `public-booking`, `internal`).
- **Schema modules:** 10 (`book-calendars`, `book-events`, `book-event-attendees`, `book-booking-pages`, `book-working-hours`, `book-external-connections`, `book-external-events`, `book-ical-tokens`, `bbb-refs`, index).
- **Frontend source:** 25 files across pages (14), hooks (5), components/layout (2), stores, lib, styles, and entry points.
- **Calendar type enum:** `personal`/`team`/`project`/`booking`/`bureau`; the `bureau` type is system-provisioned for room bookings by other apps and is not user-created.

**Place in the suite:** Book is a general-availability, production-ready app. Two sub-features are explicitly incomplete per the help doc: recurrence expansion (stored but not executed) and reminders (UI control present but not wired to any backend job). The stale "booking pages coming soon" banner in the UI is noted as stale in the docs; the booking flow itself is fully shipped. Book integrates with Bond (contact creation on booking), Bam (task due dates on Timeline, optional task creation on booking), Helpdesk (event-to-ticket links), and Bolt (5 automation events).

### Brief

**Purpose:** Real-time collaborative document editor for team writing, review, and knowledge graduation.

**Problem and users:** Teams need a shared, structured writing surface that is distinct from chat (Banter), task cards (Bam), and the read-optimized knowledge base (Beacon). Brief fills the gap: multiple authors co-edit a document simultaneously and, when the document is ready, promote it one-way into a Beacon article. Primary users are anyone in the org who writes specifications, runbooks, meeting notes, or proposals and wants reviewers in the same surface.

**Key user-facing features:**
- **Rich-text editor** built on Tiptap with a formatting toolbar, slash commands, Table of Contents generated from headings, and a live word count.
- **Real-time co-editing** over `/brief/ws` using Yjs CRDT; concurrent edits merge without conflict. Other editors' cursors and a presence strip are visible in the header.
- **Lifecycle statuses:** Draft, In Review, Approved, Archived. In Review is API/agent-only; there is no editor button for it.
- **Folders and project scope** for organization; folder rename/delete is API/agent-only.
- **Threaded and text-anchored comments** with resolve and emoji reaction.
- **Versioned snapshots** (create/restore/diff) are agent and API only; no human button exists.
- **Cross-app links** to Bam tasks and Beacon articles, read-only in the UI; creation/removal is agent or API only.
- **Promote to Beacon**: one-way graduation of a finished document into a Beacon knowledge-base article.
- Export to Markdown and HTML.
- Known UI gaps: the "Brief summary" field is non-functional (input is dropped on save); the Published date and version number are not stored, so the version button can render "vundefined"; the "Public" visibility option in the editor produces a validation error.

**AI agent integration:** 48 MCP tools (`brief.*`) cover the full surface including operations with no human UI: `brief_append_content`, `brief_update` (the only path to set In Review), `brief_version_create`/`brief_version_restore`/`brief_version_diff`, `brief_link_task`/`brief_link_beacon`/`brief_link_remove`, `brief_collaborator_*`, `brief_folder_update`/`brief_folder_delete`, and `brief_template_*`. Brief contributes documents to the platform-wide `search_everything` fan-out and `brief_semantic_search` uses the Qdrant vector index with full-text fallback. Bolt events published: `document.created`, `document.updated`, `document.published`, `document.promoted` (source `brief`).

**Technical specifics:** Internal port 4005, proxied at `/brief/api/`. WebSocket at `/brief/ws` (Yjs collaboration; a dedicated `ws/` directory exists in `apps/brief-api/src/`). 10 route files (`collaborator`, `comment`, `document`, `embed`, `export`, `folder`, `internal`, `link`, `template`, `version`). 10 Drizzle schema modules (`brief-documents`, `brief-collaborators`, `brief-comments`, `brief-embeds`, `brief-folders`, `brief-links`, `brief-templates`, `brief-versions`, `bbb-refs`, `index`). The SPA has 7 page components.

**Suite placement:** Brief sits between Bam (task execution, from which it pulls the project list) and Beacon (knowledge base, into which it graduates documents). It is the authoring tier of the knowledge workflow.

### Bureau

**Purpose:** Virtual office and pervasive presence layer for the BigBlueBam suite.

**Problem and users:** Remote and hybrid teams lack a lightweight, always-available answer to "who is around, can I interrupt them, and can we all look at this together?" Bureau replaces scheduled-meeting overhead with a spatial floor/room model that runs ambient alongside every other app. Any logged-in org member uses it; org admins additionally manage floors, offices, and org-wide settings.

**Key user-facing features:**
- **Floors and rooms:** Navigable office maps with Canvas2D presence canvas (`floor-canvas`); rooms in 8 types (Office, Huddle, Conference, Meeting, Open space, Lounge, Focus, Lobby); door states Open/Knock/Private with live Redis overrides on top of a durable DB default.
- **Docked box:** Floating overlay embedded in every SPA in the suite -- shows current room, occupants, page being viewed ("Viewing:"), mic/cam/screen controls, DND toggle, ephemeral room chat (24h default), and Bring/Invite/Hunt actions. Presence is server-side so cross-app navigation does not drop the session or the audio call.
- **Knocks:** Async entry request to a closed office; auto-times-out at 30 seconds; DND-blocked owners redirect visitors to a Banter DM leave-a-note path.
- **Summon ("Bring everyone here"):** Pulls all room co-occupants to a URL in another app, with per-recipient `can_access` preflight so denied users are reported rather than sent dead links.
- **Ring (Invite) and Hunt:** Ring calls one specific user to a surface; Hunt navigates the caller to wherever a teammate currently is, with DND and destination-access gating.
- **Room bookings:** Reservations of bookable rooms mirrored to Book calendar events; scheduled jobs flip room privacy at booking start/end; gated by `members_can_book` org setting.
- **Ephemeral room chat:** 24h retention, admin-extendable up to permanent; recoverable via "Recent chats" for users who were present.
- **Floor editor (admin):** Canvas drag-to-place room layout with image underlay upload; room inspector sets type, capacity, door default, bookable flag, and office owner.

**AI agent surface:** 38 `bureau_*` MCP tools (per CLAUDE.md). Agents are first-class occupants (appear with "(A) " prefix). Six tools require the `confirm_action` two-step: `bureau_summon`, `bureau_summon_grant_access`, `bureau_book_room`, `bureau_cancel_booking`, `bureau_delete_floor`, `bureau_delete_room`. Key tools: `bureau_move_self`, `bureau_who_is_in_room`, `bureau_who_is_here`, `bureau_where_is_user`, `bureau_knock`, `bureau_respond_knock`, `bureau_knock_inbox`, `bureau_leave_note`, `bureau_get_presence`, `bureau_locate_user`, `bureau_set_status` (durable, Redis-backed). Service-account agents are bound by the `bureau.*` tool-allowlist prefix in `agent_policies`. Bureau emits Bolt events (`user.entered_room`, `user.left_room`, `status.changed`, `room.locked`, `knock.requested`, `knock.resolved`, plus summon and booking events) on source `bureau` for Bolt automation. Daily floor utilization rolls into Bench.

**Technical specifics:**
- **Internal port:** 4015 (same default as blueprint-api; containers are isolated by hostname, not port -- see docker-compose comment).
- **WebSocket:** Yes -- `GET /bureau/ws`; JSON-frame protocol with 11 client-to-server and 11 server-to-client message types; Redis PubSub fan-out per floor/room/user channel; per-socket Redis subscriber connection; rate-limited at 120 messages per 10s.
- **Route files:** 15 (`bookings`, `chat`, `floors`, `internal`, `knocks`, `livekit`, `me-status`, `offices`, `presence-here`, `presence-where`, `ring`, `rooms`, `settings`, `summons`, `ws`).
- **Schema modules:** 3 substantive (`bureau.ts`, `bureau-chat.ts`, `bbb-refs.ts`) plus `index.ts`.
- **LiveKit:** bureau-api mints room tokens via `@bigbluebam/livekit-tokens` on `enter_room`; gated by a `calling_enabled` platform kill switch stored in Redis.
- **Presence store:** Redis hashes/sets under `bureau:floor:*`, `bureau:room:*`, `user:*` key prefixes; mirrored to the suite-wide shared presence store for cross-app reads.
- **Served at:** `/bureau/` (SPA at `apps/bureau`, API proxied at `/bureau/api/`, WebSocket at `/bureau/ws`).

**Suite position:** Bureau is the presence backbone for the entire suite. The docked box is rendered inside Board, Banter, Brief, Bond, and all other SPAs. Summons and rings name Board canvases, Brief docs, and Bond deals as canonical destinations. Bookings write to Book. Bolt events from Bureau drive automation. Floor utilization aggregates into Bench.

### Helpdesk

**One-line purpose:** A public-facing customer support portal that lets end users file and track tickets while automatically mirroring every ticket as a Bam task so staff can triage support work on the same project board as all other work.

**Problem and users:** Small-to-medium teams need a branded, org-scoped intake point for customer support requests that does not expose suite internals. Two distinct identities use it: *customers* (end users with Helpdesk-only accounts, org-scoped email/password, no Bam SSO), and *agents* (Bam staff authenticating with `hdag_`-prefixed per-agent API keys against the agent REST surface; no agent SPA exists).

**Key user-facing features:**
- **Org picker** at `/helpdesk/` listing every configured portal; per-org portals at `/helpdesk/<org-slug>/`, per-project portals at `/helpdesk/<org-slug>/<project-slug>/`
- **Customer auth** (register, email verification, login) fully separate from suite SSO
- **Ticket lifecycle** with five statuses (`open`, `in_progress`, `waiting_on_customer`, `resolved`, `closed`), four priorities (Low/Medium/High for customers; Critical for agents), optional categories, rich-text messages, and attachments with scan gating
- **Duplicate management:** customer-reversible "mark as duplicate" and agent-irreversible merge that physically moves messages to the primary ticket
- **Bam task mirror:** every submitted ticket spawns a linked Bam task in the portal's default project; closing the ticket moves that task to a terminal state
- **Share to Banter** for internal discussion; browser push notifications for customers; live presence strip on ticket detail
- **Admin settings:** default project/phase/priority, categories, allowed email domains, signup toggle, email verification, auto-close days, SLA thresholds (SLA minute values are not editable via the settings API; they require direct DB access or a future UI)

**Known mismatch:** The agent queue SLA badge uses a hardcoded 4-hour first-response target; the breach monitor enforces the per-org setting (default 8h/48h). The two can disagree.

**Technical specifics:**
- Internal port: **4001** (proxied at `/helpdesk/api/`)
- Route files: **10** (`agent`, `analytics`, `attachments`, `auth`, `dedupe`, `public-tenant`, `settings`, `ticket`, `upload`, `users`)
- Drizzle schema modules: **12** (excluding `index.ts`)
- Frontend pages: **7** (`login`, `new-ticket`, `org-picker`, `register`, `ticket-detail`, `tickets-list`, `verify-email`)
- No WebSocket; polling/REST only for the customer SPA
- Worker integration: `helpdesk-task-create` BullMQ job handler; background breach monitor for SLA events

**MCP and automation (13 tools):** Reading (`list_tickets`, `get_ticket`, `helpdesk_get_ticket_by_number`, `helpdesk_search_tickets`, `helpdesk_find_similar_tickets`), acting (`reply_to_ticket`, `update_ticket_status`), configuration (`helpdesk_get_public_settings`, `helpdesk_get_settings`, `helpdesk_update_settings`, `helpdesk_set_default_project`, `helpdesk_upsert_user`), and reporting (`helpdesk_ticket_count_by_phrase`). Agent routes require `hdag_` keys; the platform `helpdesk.*` policy prefix gates these per-agent. Bolt events emitted: ticket created, message posted, status changed, closed, reopened, user upserted, SLA breached. Helpdesk ticket activity is UNIONed into the platform unified activity view; its `actor_type=agent` (human support agent) is remapped to `human` kind to avoid collision with the platform agent identity model.

**Suite position:** Default landing point -- the nginx root redirects to `/helpdesk/`. Not BETA; it is the entry-level, externally visible face of the suite.

## 5. How the Apps Work Together

BigBlueBam is sixteen otherwise-independent products (Bam, Banter, Beacon, Brief, Bolt, Bearing, Board, Bond, Blast, Bench, Book, Blank, Bill, Blueprint, Bureau, Helpdesk) that share one Postgres database, one auth/identity layer, and a small set of cross-app primitives. There is no monolithic "integration service." Instead, apps cooperate through four mechanisms: a fire-and-forget event bus (Bolt), a durable cross-app link table (`entity_links`), an MCP-hosted read plane that fans out across apps, and a shared `@bigbluebam/shared` package that gives every service the same Zod schemas and the same event-publishing helper.

### 5.1 The Bolt event bus

Every state change that another app might care about is published as a Bolt event via the single canonical helper `publishBoltEvent(eventType, source, payload, orgId, actorId?, actorType?)` exported from `packages/shared/src/bolt-events.ts`. It POSTs to `${BOLT_API_INTERNAL_URL || BOLT_API_URL || 'http://bolt-api:4006'}/v1/events/ingest` with an `X-Internal-Secret` header (`INTERNAL_SERVICE_SECRET`). It is deliberately fire-and-forget: the whole body is wrapped in `try { ... } catch {}`, so if Bolt is down the originating operation is unaffected (it never throws, never blocks). `actorType` defaults to `'user'` if an `actorId` is given, else `'system'`.

The naming convention is bare-name-plus-explicit-source: callers pass `'deal.rotting'` with `source: 'bond'`, never `'bond.deal.rotting'`. The authoritative registry of valid pairs is `apps/bolt-api/src/services/event-catalog.ts`, where per-app `EventDefinition[]` arrays (`bamEvents`, `bondEvents`, `beaconEvents`, …, plus `wave1bEvents` and `bureauEvents`) are spread into one `ALL_EVENTS` array exposed through `getAllEvents()` / `getEventsBySource()` / `getEventDefinition()`. Each definition carries a typed `payload_schema` (field name, type, optional `enum`/`format`) that drives Bolt's condition-builder UI.

`scripts/check-bolt-catalog.mjs` is the CI drift guard. It regex-parses the catalog into a `Set` of `source:event_type` pairs, then walks every non-test `.ts` file under `apps/`, finds each `publishBoltEvent(...)` call with a balanced-paren walker, and statically extracts the first two literal arguments. It fails the build if (a) the event name looks source-prefixed, or (b) the `(source, event)` pair is absent from the catalog. Dynamic (non-literal) arguments are skipped to stay conservative. (CLAUDE.md cites "122 events registered"; the live catalog now spans more source arrays than that figure implies, so treat the exact count as catalog-derived, not the doc number.)

### 5.2 entity_links: durable cross-app linking

Per-app foreign keys (e.g. `bill_invoices.bond_deal_id`, `tickets.task_id`) wire specific pairs together, but the general "what is linked to this entity" query lives in the `entity_links` table, surfaced through MCP tools in `apps/mcp-server/src/tools/entity-links-tools.ts`: `entity_links_list`, `entity_link_create`, `entity_link_remove`. Links are typed by `link_kind` (`related_to`, `duplicates`, `blocks`, `references`, `parent_of`, `derived_from`) and addressed by `(type, id)` such as `bam.task` / `bond.deal` / `brief.document`. Reads run the Wave 2 `can_access` preflight and silently drop edges whose far side is inaccessible, reporting `filtered_count` so a caller still knows edges exist.

### 5.3 Cross-app read plane

The MCP server hosts the read-side fan-out: `search_everything` (`search-tools.ts`, cross-app search with normalized scoring and optional asker-mode `can_access` filtering), `resolve_references` (`resolve-tools.ts`, deterministic mention extraction using the canonical syntax in `packages/shared/src/mention-syntax.ts` plus per-app search), and the composite views `account_view` / `project_view` / `user_view` in `composite-tools.ts` that stitch one entity's footprint across apps into a single response.

### 5.4 Shared packages

`@bigbluebam/shared` (`packages/shared/src/index.ts`) re-exports the Zod schemas (`schemas/*` - one module per app), shared types, constants, the `publishBoltEvent` helper, Bolt graph/automation-version shapes, mention syntax, the BullMQ `queues` definitions, the Banter-feed domain, and Bureau surface IDs. The same schemas validate on both client and API, which is why a `task` shape cannot drift between Bam's SPA and its API. Other shared packages (`@bigbluebam/logging`, `service-health`, `db-stubs`, `livekit-tokens`, `ui`) provide the cross-cutting plumbing.

### 5.5 The Acme "lead-to-delivery" scenario and an end-to-end example

`scripts/seed-acme-scenario.mjs` (Phase D of `scripts/seed-all.mjs`) threads one story through nine apps, each step idempotent and tagged `scenario = 'acme-lead-to-delivery'`. The orchestrator resolves the org by `SEED_ORG_SLUG`, runs Phase A (`seed-platform.mjs`, fatal on failure), Phase B per-app seeders, Phase C (Banter + Helpdesk), then Phase D.

A concrete chain crossing more than three apps, drawn directly from the seed steps:

1. **Bond** creates "Acme Corp", contact `ellen@acme.example`, and the deal "Acme Corp enterprise contract" in the Negotiation stage.
2. **Bolt** seeds a `Stale deal auto-task` automation with `trigger_source='bond'`, `trigger_event='deal.rotting'` and an action calling `bam.task.create` with title `Follow up on {{deal.name}}`. When the Bond stale-deal worker emits `deal.rotting` (source `bond`), Bolt fires this action.
3. **Bam** holds task `MAGE-201` "Draft Acme MSA", cross-linked back to the deal via `custom_fields.bond_deal_id` (tasks have no native `bond_deal_id` column).
4. **Bill** issues `INV-2026-0042` whose `bond_deal_id` and `bill_clients.bond_company_id` point at the Bond deal/company, then emits `approval.requested` (source `platform`) to Bolt's `/v1/events/ingest`, routed to an approver (Alice if present) - which a Banter DM automation can pick up.
5. **Helpdesk** files ticket "Cannot sign MSA PDF" from Ellen, with `task_id` referencing the Bam task.

So a single rotting Bond deal flows Bond → Bolt → Bam (via event + MCP action), while Bill → Bolt → Banter carries the invoice approval, and Helpdesk → Bam ties the support ticket back to the same work item - five apps reacting to one customer, glued by the event bus and cross-app FKs rather than any central coordinator.

---

How to see it in action: run `docker compose --profile seed run --rm seed`, then watch the Phase D log lines (`1. Bond …` through `9. Beacon …`). Verify the cross-links with `docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "SELECT invoice_number, bond_deal_id FROM bill_invoices WHERE invoice_number='INV-2026-0042';"` and confirm the Bolt automation with `... -c "SELECT name, trigger_source, trigger_event FROM bolt_automations WHERE name='Stale deal auto-task';"`. Run the drift guard with `node scripts/check-bolt-catalog.mjs` (expect `[bolt-catalog] OK`).

## 6. System Architecture

BigBlueBam is a Docker-native monorepo whose entire runtime is brought up with a single `docker compose up`. Every service is defined in `docker-compose.yml`, and all browser- and agent-facing traffic enters through **one nginx container** (the `frontend` service) on host ports 80/443. The published-port surface to the host is deliberately tiny: only `frontend` (80/443), `livekit` (7880/7881 + a UDP media range + optional TURN 5349), and `mcp-server` (3001, a developer-host convenience for MCP clients that reject the self-signed nginx cert) bind host ports. Every other service is reachable only on the internal Docker networks. The `docs/reference/architecture.md` diagrams predate most of this and are stale (they say "86 tools", "8 services", and show only Bam/Banter/Helpdesk); the authoritative description is `infra/nginx/nginx.conf` plus `docker-compose.yml`, used here.

### 6.1 The single-nginx fronting model and route table

The nginx server (`infra/nginx/nginx.conf`) listens on `:80` (TLS variants are rendered from `nginx-with-site.conf` by the container entrypoint when certs are present), enforces a 25 MB body cap, gzip, and a fixed set of security headers (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a `Permissions-Policy` denying camera/mic/geo). The bare root `/` returns a tiny HTML shim that fetches `/b3/api/root-redirect` and redirects to whatever the API reports (falling back to `/helpdesk/`). A block of top-level `rewrite` rules forwards legacy unprefixed auth links (`/login`, `/bootstrap`, `/verify-email/...`, etc.) into the `/b3/` SPA.

Each product app follows the same two-or-three-location pattern: a `location /<app>/` that `alias`es the built SPA from `/usr/share/nginx/html/<app>/` with a `try_files ... /<app>/index.html` SPA fallback; a `location /<app>/api/` that `proxy_pass`es to the upstream container, stripping the prefix; and, where the app is realtime, a `location /<app>/ws` with `Upgrade`/`Connection: upgrade` headers and an 86400 s read timeout.

| Public path | Upstream | Notes |
|---|---|---|
| `/` | (inline HTML) | dynamic redirect, falls back to `/helpdesk/` |
| `/b3/`, `/b3/api/`, `/b3/ws` | `api:4000` | Bam SPA + REST + WebSocket |
| `/helpdesk/`, `/helpdesk/api/`, `/helpdesk/ws` | `helpdesk-api:4001` | also `/helpdesk-api/` for the Bam frontend's helpdesk panel |
| `/banter/`, `/banter/api/`, `/banter/ws` | `banter-api:4002` | |
| `/beacon/`, `/beacon/api/` | `beacon-api:4004` | |
| `/brief/`, `/brief/api/`, `/brief/ws` | `brief-api:4005` | WS reserved for Yjs collaboration |
| `/bolt/`, `/bolt/api/` | `bolt-api:4006` | |
| `/bearing/`, `/bearing/api/` | `bearing-api:4007` | |
| `/board/`, `/board/api/`, `/board/ws` | `board-api:4008` | tldraw collab + chat |
| `/bond/`, `/bond/api/` | `bond-api:4009` | |
| `/blast/`, `/blast/api/`, `/t/`, `/unsub/` | `blast-api:4010` | `/t/` open-pixel + click; `/unsub/` |
| `/bench/`, `/bench/api/` | `bench-api:4011` | |
| `/book/`, `/book/api/`, `/meet/` | `book-api:4012` | `/meet/` public booking pages |
| `/blank/`, `/blank/api/`, `/forms/` | `blank-api:4013` | `/forms/` public form submit |
| `/bill/`, `/bill/api/`, `/invoice/` | `bill-api:4014` | `/invoice/` token-based public view |
| `/blueprint/`, `/blueprint/api/`, `/blueprint/ws` | `blueprint-api:4015` | WS reserved for Hocuspocus |
| `/bureau/`, `/bureau/api/`, `/bureau/ws` | `bureau-api:4015` | presence/knock/summons fan-out |
| `/livekit-ws/` | `livekit:7880` | same-origin signalling WS so HTTPS pages avoid mixed-content |
| `/files/` | `api:4000/files/` | shared attachment serving |
| `/mcp`, `/mcp/`, `/mcp/...` | `mcp-server:3001` | exact-match `/mcp` + `/mcp/` hit upstream `/mcp`; subpaths strip the prefix; `proxy_buffering off` for SSE |

A trailing `location ~* .../assets/...` regex serves immutable, year-cached static assets for every app directly from disk.

### 6.2 Internal port registry

Inside the Docker networks every service binds a fixed port (set via `PORT=` env in `docker-compose.yml`, except where noted). Note that **`blueprint-api` and `bureau-api` both bind container port 4015** - this is intentional and safe because each runs in its own network namespace, and nginx routes by upstream hostname, not port.

| Service | Internal port | Service | Internal port |
|---|---|---|---|
| `api` | 4000 | `book-api` | 4012 |
| `helpdesk-api` | 4001 | `blank-api` | 4013 |
| `banter-api` | 4002 | `bill-api` | 4014 |
| `voice-agent` | 4003 (Dockerfile `EXPOSE 4003`, uvicorn) | `blueprint-api` | 4015 |
| `beacon-api` | 4004 | `bureau-api` | 4015 |
| `brief-api` | 4005 | `mcp-server` | 3001 |
| `bolt-api` | 4006 | `postgres` | 5432 |
| `bearing-api` | 4007 | `redis` | 6379 |
| `board-api` | 4008 | `minio` | 9000 (API) / 9001 (console) |
| `bond-api` | 4009 | `qdrant` | 6333 |
| `blast-api` | 4010 | `livekit` | 7880 (RTC) / 7881 (TCP) |
| `bench-api` | 4011 | `worker` | none (no listener) |

Two helper one-shots have no long-lived port: `migrate` (runs `node dist/migrate.js`, a `service_completed_successfully` dependency of every DB-using service) and `livekit-config` (re-renders `livekit.yaml` before `livekit` starts). The MCP server reaches each satellite over these internal ports using `*_API_URL` env vars, most of which include the `/v1` route prefix (e.g. `BOND_API_URL=http://bond-api:4009/v1`).

### 6.3 Stateless apps vs. swappable data services

Two bridge networks separate concerns (`docker-compose.yml`): every API/SPA/worker/mcp container joins `backend`; the externally-reachable ones (all the `*-api` services, `frontend`, `site`, `livekit`) additionally join `frontend`. All application containers are **stateless** - they hold no durable local state, so they scale horizontally and are freely restarted. Durable state lives in four data services, each behind an env-var-only seam so a managed cloud equivalent can be swapped in without code changes:

- **`postgres`** (PostgreSQL 16-alpine, volume `pgdata`, `DATABASE_URL`) - system of record; RLS, JSONB custom fields, partitioned activity log.
- **`redis`** (Redis 7-alpine, volume `redisdata`, `REDIS_URL`) - sessions, cache, PubSub fan-out, and BullMQ queues. Configured `--maxmemory-policy noeviction` because eviction would silently corrupt queue state.
- **`minio`** (S3-compatible, volume `miniodata`, `S3_ENDPOINT`/`S3_*`) - attachments and uploads; drop-in for AWS S3 / R2.
- **`qdrant`** (volume `qdrantdata`, `QDRANT_URL`) - vector store for Beacon/Brief/Bond semantic retrieval.

Cross-app server-to-server calls go directly between containers on `backend` (e.g. `worker → bolt-api:4006`, `bureau-api → book-api:4012`/`board-api:4008`/`brief-api:4005`), authenticated with `INTERNAL_SERVICE_SECRET`; they never traverse nginx.

### 6.4 Request lifecycle for a typical UI action

A user dragging a Bam card to a new phase:

```
Browser (React SPA, /b3/)
   │  1. dnd-kit drop → TanStack Query optimistic cache update (card moves instantly)
   │  2. PATCH /b3/api/tasks/:id  (session cookie)
   ▼
nginx :80  (location /b3/api/ → proxy_pass http://api:4000/, prefix stripped)
   ▼
api:4000 (Fastify)
   │  3. auth plugin resolves session + active_org_id (X-Org-Id / sessions.active_org_id)
   │  4. Zod-validate body; RBAC + optional per-action resolver (BBB_PERMISSIONS_ENFORCE)
   │  5. UPDATE tasks (float position) + INSERT activity_log   ── postgres:5432
   │  6. PUBLISH project:{id} task.moved                       ── redis:6379
   │  7. 200 OK (authoritative task) ─────────────────────────► Browser (cache reconciles)
   ▼
redis PubSub  ──► every api replica subscribed to project:{id}
   ▼
api WebSocket hub ──► /b3/ws clients in that project room
   ▼
Other browsers: task.moved → animated reflow
```

Reads follow the same hop minus the write/publish; background work (email, exports, sprint-close, Bolt execution) is enqueued to Redis and drained by the portless `worker`. On a write conflict the API returns HTTP 409 (last-write-wins with an `updated_at` stale check) and the client refetches. WebSocket connections carry the same 86400 s nginx read timeout so long-lived realtime sessions survive idle periods.

## 7. Tech Stack & Framework Decisions

BigBlueBam is a TypeScript monorepo: every runtime service is Node.js (`engines.node >= 22.0.0` in the root `package.json`) and every frontend is React, so a single language and a single set of Zod schemas span client and server. Versions below are quoted from the actual `package.json` files, not the prose specs; where the design docs disagree with the code, the discrepancy is noted inline.

### 7.1 Frontend (the Bam SPA, `apps/frontend`)

| Library | Pinned range | Role / rationale |
|---|---|---|
| `react` / `react-dom` | `^19.1.0` | Concurrent rendering and the transitions API; `@types/react` `^19.1.2`. |
| `motion` | `^12.9.3` | Spring-physics + layout animations for card reflow and drag gestures. This is the successor to Framer Motion; **the docs say "Motion v11+" but the installed major is 12** - a forward drift, not a regression. |
| `@tanstack/react-query` | `^5.75.5` | Server-state cache backing the optimistic-update + rollback pattern used for all mutations. |
| `@tanstack/react-router` | `^1.114.3` | Type-safe routing. **Not mentioned in CLAUDE.md's stack list**, which omits the router entirely; the code uses TanStack Router, not React Router. |
| `@tanstack/react-virtual` | `^3.13.23` | Row/card virtualization for long boards and lists. |
| `zustand` | `^5.0.5` | Minimal client-only state (UI/filter state) without reducer boilerplate. |
| `@dnd-kit/core` `^6.3.1`, `/sortable` `^10.0.0`, `/utilities` `^3.2.2` | | Accessible drag-and-drop with sortable, multi-container support for the Kanban board. |
| `tailwindcss` + `@tailwindcss/vite` | `^4.1.4` | Tailwind v4 via the first-party Vite plugin (see `apps/frontend/vite.config.ts`), not the legacy PostCSS pipeline, though `postcss`/`autoprefixer` are still present as devDeps. |
| `@radix-ui/*` | `1.x`-`2.x` | Unstyled accessible primitives: `react-dialog`, `react-dropdown-menu`, `react-popover`, `react-select`, `react-tooltip`, `react-avatar`. |
| `react-hook-form` `^7.56.1` + `@hookform/resolvers` `^5.0.1` + `zod` `^3.24.4` | | Performant forms validated by the same Zod schemas the API enforces (`@bigbluebam/shared`). |
| `lucide-react`, `clsx`, `date-fns` `^4.1.0`, `dompurify` `^3.3.3`, `papaparse` | | Icons, class composition, date math, HTML sanitization for rendered rich text, CSV import parsing. |

**Tiptap correction.** Both CLAUDE.md and `docs/reference/architecture.md` list **Tiptap as a Bam-frontend dependency for "task descriptions and comments." It is not present in `apps/frontend/package.json`.** The ProseMirror-based Tiptap stack (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm`, and ~25 extensions, all `^2.11.5`) lives in `apps/brief`, the collaborative document editor, with custom extensions under `apps/brief/src/extensions/` (mentions, slash commands, task/beacon embeds, callouts). Treat "Tiptap" as a suite-level, Brief-specific choice rather than a Bam editor.

Build tooling for every SPA is **Vite `^6.3.2`** with `@vitejs/plugin-react` `^4.4.1`; the Bam app is served under `base: '/b3/'` and proxies `/b3/api` and `/b3/ws` to `:4000` in dev.

### 7.2 API services (`apps/api` and the sibling Fastify apps)

| Library | Pinned range | Role / rationale |
|---|---|---|
| `fastify` | `^5.2.0` | High-throughput HTTP with schema-based validation and a plugin model; `fastify-plugin` `^5.0.0` for encapsulation breaks. |
| `@fastify/*` plugins | `9.x`-`11.x` | `cookie`, `cors`, `multipart` (attachment uploads), `rate-limit`, `swagger`+`swagger-ui` (OpenAPI), `websocket` `^11.0.0`. |
| `drizzle-orm` `^0.36.0` + `drizzle-kit` `^0.28.0` | | SQL-first, type-safe ORM; Drizzle schema files are the source the `db:check` drift guard diffs against the live DB. |
| `postgres` | `^3.4.0` | The `postgres.js` driver Drizzle runs on. |
| `zod` | `^3.23.0` | Runtime validation shared with the client; same major (3.x) as the frontend so `@bigbluebam/shared` schemas are import-compatible. |
| `bullmq` | `^5.0.0` | Redis-backed job queue powering `apps/worker` (email, exports, sprint-close, vector sync, etc.). |
| `ioredis` | `^5.4.0` | Redis client for sessions, cache, pub/sub fan-out, and BullMQ. |
| `ws` | `^8.20.0` | **Native WebSocket, not Socket.IO.** The architecture doc lists "Socket.IO / WebSocket"; the actual dependency is `ws` plus `@fastify/websocket`, with cross-instance broadcast done over Redis PubSub via `ioredis`. CLAUDE.md's "Socket.IO **or** native WebSocket" phrasing is the accurate one. |
| `argon2` `^0.41.0` | | Argon2id hashing for `bbam_`/`bbam_svc_` API keys and passwords. |
| `minio` `^8.0.0` | | S3-compatible object storage client (MinIO locally, swappable for S3/R2 by env). |
| `nodemailer`, `file-type`, `nanoid`, `pino`+`pino-pretty`, `dotenv` | | SMTP send, upload MIME sniffing, ID generation, structured logging (`@bigbluebam/logging`), env loading. |

Each service builds with **tsup `^8`** and runs in dev under **tsx `^4`**.

### 7.3 Data layer

PostgreSQL 16 is the system of record, chosen for the three features the design leans on hardest: **row-level security** (policies gated by the `app.current_org_id` GUC, migration 0116), **JSONB** custom fields on tasks, and **monthly range-partitioned** `activity_log`. Redis 7 is the single backbone for sessions, cache, pub/sub, and BullMQ queues. MinIO provides S3-compatible attachment storage. **Qdrant** is the vector store for semantic retrieval - the client `@qdrant/js-client-rest` `^1.12.0` is a real dependency of `apps/beacon-api`, `apps/brief-api`, and `apps/worker` (the worker runs `beacon-vector-sync`), confirming the Beacon/Brief/Bond semantic-search claim in code rather than only in docs.

### 7.4 MCP server (`apps/mcp-server`)

Built on `@modelcontextprotocol/sdk` `^1.0.0`. It exposes two transports in code: **Streamable HTTP** (`StreamableHTTPServerTransport`, the default) and **SSE** (`SSEServerTransport`) - both imported and session-tracked in `apps/mcp-server/src/server.ts` (`streamableTransports`/`sseTransports` maps). The stdio transport named in CLAUDE.md is not wired in this file; the running sidecar is HTTP/SSE on internal `:3001`. Tool inputs are validated with the same `zod` `^3.23.0`, and `ioredis` backs the Redis `confirm_action` token store. It depends on `@bigbluebam/permissions` and `@bigbluebam/shared` so MCP tools enforce identical permission and schema rules as the REST API.

### 7.5 Build, tooling, and quality gates

The monorepo is orchestrated by **Turborepo `^2.3.3`** over **pnpm `9.15.4`** workspaces (`packageManager` field, root `package.json`), with task graphs for `build`/`lint`/`typecheck`/`test`. **Biome `^1.9.4`** is the single lint+format tool (`pnpm check` runs `biome check --write`), replacing a separate ESLint+Prettier pair. **TypeScript `^5.7.3`** (root) compiles every package; app-level `typecheck` is `tsc --noEmit`. Tests run on **Vitest** - `^3.1.2` in the frontend, `^2.0.0` in the API and MCP server (a deliberate-or-incidental major split worth flagging) - and **Playwright `^1.59.1`** drives the `apps/e2e` suite. Root scripts wrap the Docker Compose lifecycle (`docker:up`, `db:migrate`) and the bespoke guards (`check:bolt-catalog`, `lint:migrations`, `db:check`) that the CLAUDE.md conventions depend on.

## 8. Monorepo Structure & Project Organization

BigBlueBam is a single repository managed with **Turborepo** (task orchestration) and **pnpm workspaces** (dependency management). The workspace globs are declared in `pnpm-workspace.yaml` - only two roots, `apps/*` and `packages/*` - so every buildable unit lives under one of those two trees. The package manager is pinned (`pnpm@9.15.4`) and Node is constrained to `>=22.0.0` in the root `package.json`.

### Task orchestration

`turbo.json` defines the cross-package task graph. The key tasks are `build`, `dev`, `lint`, `typecheck`, `test`, `test:unit`, `test:e2e`, and `clean`. Almost all of them declare `"dependsOn": ["^build"]`, meaning a package's upstream workspace dependencies (e.g. `@bigbluebam/shared`) are built before the task runs - this is why `pnpm --filter @bigbluebam/shared build` is the prerequisite for most other work. `build` caches its `dist/**` output; `dev` and the e2e/clean tasks set `"cache": false`. Root `package.json` scripts wrap these (`turbo run build`, `turbo run typecheck`, etc.) and also expose non-Turbo utilities that call scripts directly: `db:check`, `db:migrate`, `seed`, `lint:migrations`, `check:bolt-catalog`, `check:permission-catalog`, `permissions:codegen`, the `docs:*` capture/compose pipeline, and `help:index`.

### `apps/` (one line each)

Verified directory listing - note `bureau`/`bureau-api` exist in the tree but are absent from the CLAUDE.md app roster, and `voice-agent` is a Python service, not a Node app.

- `api` / `frontend` - Bam core REST+WS API and the Bam React SPA.
- `banter-api` / `banter` - team chat/feed API and SPA.
- `beacon-api` / `beacon` - knowledge base (search, graph, policies) API and SPA.
- `brief-api` / `brief` - collaborative document editor API and SPA.
- `bolt-api` / `bolt` - workflow automation engine API and SPA.
- `bearing-api` / `bearing` - goals/OKRs API and SPA.
- `board-api` / `board` - whiteboard/conferencing API and SPA.
- `bond-api` / `bond` - CRM (contacts, companies, deals) API and SPA.
- `blast-api` / `blast` - email campaigns API and SPA.
- `bench-api` / `bench` - analytics dashboards API and SPA.
- `book-api` / `book` - scheduling/booking API and SPA.
- `blank-api` / `blank` - forms/submissions API and SPA.
- `bill-api` / `bill` - invoicing/expenses API and SPA.
- `blueprint-api` / `blueprint` - structured-diagram API and SPA.
- `bureau-api` / `bureau` - pervasive presence/"virtual office" service: floors, offices, rooms, knocks, rings, summons, presence, LiveKit-backed conferencing (route files include `presence-here`, `presence-where`, `knocks`, `ring`, `summons`).
- `helpdesk-api` / `helpdesk` - support portal API and SPA.
- `mcp-server` - MCP protocol server (700+ tools) exposing the suite to agents.
- `worker` - BullMQ background job processor (no exposed port).
- `voice-agent` - Python/FastAPI LiveKit voice agent (placeholder).
- `integration-tests` - cross-app Vitest integration harness; `e2e` - Playwright suite.

### `packages/`

The shared workspace libraries, all published under the `@bigbluebam/*` scope (verified list - matches the brief's expected set exactly):

- `shared` - Zod schemas, types, constants, the canonical `publishBoltEvent` helper.
- `ui` - shared React component library.
- `logging` - pino structured-logger factory.
- `service-health` - Fastify `/healthz` + `/readyz` plugin (single `src/index.ts`).
- `db-stubs` - Drizzle stubs/helpers for tests and isolated DB bootstraps.
- `livekit-tokens` - LiveKit access-token minting shared by board-api and voice callers.
- `permissions` - permission resolver with a generated catalog; ships subpath exports (`.`, `./resolver`, `./generated`) and is fed by `pnpm permissions:codegen`.
- `bureau-client` - the in-browser Bureau presence dock widget (React/TS: `chat-panel`, `ring-handler`, `video-tiles`, `ws-client`, etc.) embedded across the suite's SPAs.
- `smtp-resolver` - SMTP/MX resolution helper.
- `docs-capture` - declarative screenshot/seeding harness (`runner`, `recipe`, `manifest`, `seeding`) used by the `docs:*` scripts.

### `infra/`, `scripts/`, `docs/`

- `infra/postgres/migrations/` - 163 numbered, append-only, idempotent SQL migrations (tip `0201_banter_feed.sql`); the single source of truth for schema.
- `infra/nginx/` - `nginx.conf`, `nginx.railway.conf`, `nginx-with-site.conf`, `entrypoint.sh`, and a `tls-redirect.conf.template`.
- `infra/livekit/livekit.yaml.template` (rendered config is gitignored); `infra/site/Dockerfile` builds the standalone marketing `site/`; `infra/railway/` holds per-service Railway config for livekit/minio/qdrant.
- `scripts/` - deploy adapters (`deploy.sh/.ps1/.bat`, `deploy/`), the `seed-all.mjs` orchestrator and per-app seeders, drift guards (`db-check.mjs`, `check-bolt-catalog.mjs`, `check-permission-catalog.mjs`, `lint-migrations.mjs`), screenshot generators, and the `docs/`, `help/`, `livekit/`, `docs-book/` toolchains.
- `docs/` - `reference/` (authoritative design doc, `architecture.md`, `api-reference.md`, `database.md`, `mcp-endpoint-mapping.md`, `permissions.md`, etc.), plus `apps/`, `guides/`, `plans/`, `history/`, `auto/`, and `images/`.

### Typical app structure

Every Node API app follows the same `src/` skeleton (confirmed identical across `apps/api` and `apps/bond-api`):

- `server.ts` - Fastify entry point; `env.ts` - validated environment config.
- `routes/` - domain-grouped `*.routes.ts` files (e.g. bond: `contacts`, `companies`, `deals`, `pipelines`, `analytics`, plus an `internal.routes.ts` for service-to-service calls). The Bam `api` has **66** route files today - far more than the **23** stated in `docs/reference/architecture.md`, which is stale.
- `services/` - business logic, one `*.service.ts` per domain (bond has `deal.service.ts`, `scoring.service.ts`, `dedupe.service.ts`, etc.).
- `db/schema/` - one Drizzle table definition per file, re-exported via `db/index.ts`. The Bam `api` declares **54** schema modules (architecture.md says 24 - also stale); `bond-api` declares 16.
- `plugins/` - Fastify plugins (`auth.ts`, `redis.ts`, `permissions.ts`).
- `middleware/` - request-scoped middleware (`bond-api` carries a `dual-read.ts` for expand-contract reads; Bam `api` adds `authorize.ts`/`error-handler.ts`).
- `lib/` - local helpers (e.g. bond's `bolt-events.ts`, `bolt-enrichment.ts`).
- The Bam `api` additionally owns `cli.ts` (admin/service-account commands), `migrate.ts` (the migration runner), and a `boot/` directory (e.g. RLS boot).

Front-end SPAs share a parallel convention: `App.tsx`/`main.tsx` entry, plus `components/`, `pages/`, `hooks/`, `stores/` (Zustand), `lib/`, and `styles/`.

## 9. Data Layer - Postgres, Schema, Migrations, RLS

BigBlueBam stores all primary state in PostgreSQL 16 (with Redis for sessions/cache/queues, MinIO/S3 for blobs, and Qdrant for vectors, none of which are covered here). A single logical database backs every service: the Bam API, the per-app APIs (helpdesk, beacon, brief, bolt, bearing, board, bond, blast, bench, book, blank, bill, blueprint), the Banter API, and the worker all connect to the same Postgres instance via `DATABASE_URL`. Tenancy, schema authority, change management, and access control are described below.

### 9.1 Schema source of truth: Drizzle per app, SQL as on-disk history

There are two layers of "source of truth," and they are deliberately distinct:

- **Drizzle TypeScript schemas** in `apps/<app>/src/db/schema/*.ts` are the authoritative table *shapes* the application code reads and writes. Each API owns its schema modules (e.g. the Bam API has 38 schema modules, bond-api 14, blast-api 9).
- **Hand-written numbered SQL files** in `infra/postgres/migrations/` are the authoritative on-disk *history* applied to Postgres. There is no generated SQL and no Drizzle `migrate` codegen path; migrations are written by hand.

The drift guard (§9.4) is what keeps these two layers honest. Note the drift guard only parses three schema roots (`apps/api`, `apps/helpdesk-api`, `apps/banter-api`); the newer per-app APIs are not currently in its scan set, a gap worth knowing when reasoning about coverage.

### 9.2 The migration system

Migrations live in `infra/postgres/migrations/`. As of this writing the tree contains **163 files**, tip **`0201_banter_feed.sql`** (the count is lower than the max sequence number because some numbers are skipped, e.g. there is no `0009`). `0000_init.sql` is the canonical baseline; the legacy `infra/postgres/init.sql` bootstrap has been deleted, so there is no special first-boot path - the empty container DB is built entirely by the migrate sequence.

**The migrate sidecar.** The runner is `apps/api/src/migrate.ts`, executed as the `migrate` Docker Compose service (it reuses the api image and runs `node dist/migrate.js`). It is a `service_completed_successfully` dependency of every DB-using service, so it must finish before api/helpdesk-api/banter-api/worker (and the rest) start. It runs on every `docker compose up` and is a no-op against an up-to-date DB. The runner reads files from `MIGRATIONS_DIR`, sorts them lexicographically, and for each applies the whole file inside a single transaction, then records it.

**`schema_migrations` + SHA-256 checksums + immutability.** Applied migrations are tracked in `schema_migrations(id text PK, checksum text, applied_at timestamptz)`, where `id` is the filename without `.sql`. The checksum is a SHA-256 computed over the SQL *body only*: `bodyChecksum()` strips the leading run of blank lines and `--` comment lines before hashing, so the `-- Why:` / `-- Client impact:` header can be edited freely. On every boot the runner re-hashes each on-disk file and, if a recorded checksum no longer matches the current body, **aborts loudly with `CHECKSUM MISMATCH`** - migrations are immutable once applied. Two escape valves exist: a quiet automatic re-stamp when the stored value matches the *legacy* full-file hash (the pre-body-only era), and an opt-in `MIGRATE_ALLOW_HEADER_RESTAMP=1` env var for one-time header-only edits. This guard is exactly what caused the 2026-04-18 production incident where an inline `-- noqa:` tag changed a body byte and stalled migrations for ~24h; the practical rule is to never touch an applied file's body, and to register lint suppressions in `scripts/lint-migrations.mjs::OFF_FILE_SUPPRESSIONS` rather than inline.

One non-obvious behavior: before applying each new file the runner calls `ensureSuperuserSentinel()`, which idempotently seeds a sentinel org and a locked, unloginable superuser (`system-bootstrap@bigbluebam.internal`, fixed UUIDs). This exists because `0023_beacon_tables.sql` seeds a row with a NOT NULL FK to a superuser that does not yet exist on a fresh DB.

**Conventions** (enforced by `pnpm lint:migrations` / `scripts/lint-migrations.mjs`, run in CI by `.github/workflows/db-drift.yml`):
- **Filename**: `^[0-9]{4}_[a-z][a-z0-9_]*\.sql$` (zero-padded 4-digit sequence + snake_case).
- **Header**: within the first ~20 lines, a comment block containing the filename marker, a `-- Why:` line, and a `-- Client impact:` line. `0201_banter_feed.sql` and `0127_agent_identity_heartbeat.sql` both follow this shape.
- **Idempotency**: `CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP ... IF EXISTS`; `CREATE TRIGGER` preceded by `DROP TRIGGER IF EXISTS` or wrapped in a `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` block; destructive ALTERs wrapped in guarded `DO $$` blocks. Idempotency is mandatory because a file may run against a fresh DB (where `0000_init.sql` already created the object) or an older DB catching up.

**The bind-mount gotcha.** `docker-compose.yml` bind-mounts `./infra/postgres/migrations:/app/migrations:ro` into the migrate service, so the host directory is read live on every container start and new files are visible instantly without a rebuild. This was added to fix an earlier failure mode where Docker Desktop's WSL2 file sync silently dropped newly added files from the build context, producing images missing the latest migration while the sidecar cheerfully reported "N applied, N already up-to-date." Two traps remain: the sidecar's completion is cached via `service_completed_successfully`, so after adding a file you must explicitly run `docker compose run --rm migrate` (rebuilding a dependent service does not re-trigger it); and the production image still `COPY`s migrations in (apps/api/Dockerfile) as a fallback for Helm/k8s where no bind mount exists.

### 9.3 Multi-org scoping and RLS

Tenancy is org-scoped: `organizations` is the top-level tenant and effectively every row carries an `org_id`. Membership is authoritative in `organization_memberships` (many-to-many); the older `users.org_id` column is retained for backward compatibility only.

Row-level security is **defense-in-depth on top of** application-level org scoping, not a replacement for it. `0116_rls_foundation.sql` defines policies on 11 core tables (`organizations`, `projects`, `tasks`, `sprints`, `phases`, `activity_log`, `organization_memberships`, `api_keys`, `sessions`, `custom_field_definitions`, and one more) gated by `current_setting('app.current_org_id')`. The GUC is set per request by `apps/api/src/plugins/rls.ts`, a Fastify `preHandler` that runs `set_config('app.current_org_id', <active_org_id>, true)` (the `true` makes it transaction-local). Enforcement is staged via `BBB_RLS_ENFORCE`: when unset/`0` (the current default) the app role keeps BYPASSRLS and policies are advisory; when `1`, the boot hook `apps/api/src/boot/rls-boot.ts` flips the role to NOBYPASSRLS so policies bind on every query and a request that forgets to set the GUC sees zero rows. The plugin sets the GUC in both modes; in soft mode a `set_config` failure is logged and swallowed, in enforce mode it is rethrown.

### 9.4 JSONB custom fields, partitioned activity log, drift guard

**JSONB custom fields.** Per-project field definitions live in `custom_field_definitions` (`field_type` ∈ text/number/date/select/multi_select/url/checkbox/user, with `options` JSONB for select types). Values are stored on `tasks.custom_fields` as a JSONB map keyed by definition id, queried with standard JSONB operators (`custom_fields->>'<id>'`). JSONB is also used for `organizations.settings`, `projects.settings`, `activity_log.details` (structured field-level diffs), and `users.notification_prefs`.

**Monthly-partitioned activity log.** `activity_log` is an append-only audit trail range-partitioned by `created_at` into monthly partitions plus a `_future` catch-all, so recent-activity queries prune to the current partition and old months can be detached for archival. A worker job provisions upcoming partitions ahead of time and archives those past the retention window (doc default cited as 2 years). `activity_log.actor_type` mirrors `users.kind` at write time (added `0127_agent_identity_heartbeat.sql`, defaulting existing rows to `human`).

**Drift guard - `pnpm db:check`.** `scripts/db-check.mjs` parses every `pgTable(...)` across `apps/api`, `apps/helpdesk-api`, `apps/banter-api`, unions by table name, and diffs against the live DB at `DATABASE_URL`. Missing tables/columns (declared in Drizzle, absent in DB) and unknown ones (in DB, undeclared) both exit 1; type mismatches are warnings only; `schema_migrations` is always ignored. CI runs both `lint:migrations` and `db:check` against a freshly-migrated Postgres 16 container on every push and PR via `.github/workflows/db-drift.yml`. When it fails, the fix is never to edit an existing migration - update the Drizzle schema and add a new numbered, idempotent migration.

## 10. API Design & Conventions

Every BigBlueBam HTTP surface - the Bam API (`apps/api`) and all sibling product APIs (`banter-api`, `bond-api`, `beacon-api`, etc.) - follows one shared set of conventions so a client (or an agent driving the MCP tool layer) can move between apps without relearning the contract. The authoritative reference is `docs/reference/api-reference.md`; the conventions below are verified against the running Fastify code.

### Versioning and routing

Endpoints are normally mounted under a `/v1` prefix and reached through nginx at `/<app>/api/v1/` (e.g. Bam at `/b3/api/v1/`, internal Fastify on `:4000`). The prefix is not yet universal: `/auth/*`, `/superuser/*`, and the Helpdesk routes are currently served without `/v1` (called out as a tracked inconsistency in `api-reference.md` §Base URL). `GET /health` is intentionally unversioned.

### The shared error envelope

Every error response is a single `error` object:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [{ "field": "title", "issue": "required" }], "request_id": "req_abc123" } }
```

`code` is a stable machine string (`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `GONE`, `UNPROCESSABLE`, `RATE_LIMITED`, `INTERNAL_ERROR`, plus endpoint-specific codes such as `VERSION_CONFLICT`, `TASK_RELATION_CYCLE`, `AGENT_AUTH_DISABLED`); `details` is an array of `{ field, issue }`; `request_id` echoes the Fastify request id for support correlation. This shape is hand-constructed at each `reply.status(...).send(...)` site - see `apps/api/src/routes/label.routes.ts` lines 128-136 for a canonical 404 - so the envelope's consistency is a discipline, not a framework guarantee.

### Pagination, filtering, sorting

List endpoints are cursor-paginated. Responses carry `{ data: [...], pagination: { next_cursor, prev_cursor, has_more, total_count } }`; requests take `?cursor=<opaque>&limit=<int>` (default 50, max 200). Filtering uses bracket syntax `?filter[field]=value` with comma lists (`filter[priority]=high,critical`), range operators (`filter[due_date][gte]=...`), and sentinel values (`filter[assignee_id]=unassigned`). Sorting is `?sort=field` ascending / `?sort=-field` descending, comma-separated for multi-sort. `?fields=` trims the payload; GET responses ship an `ETag` for `If-None-Match` conditional fetches.

### Optimistic updates and conflict handling

The frontend applies TanStack Query optimistic mutations and rolls back on error. The intended write-conflict model is last-write-wins with a stale-`updated_at` check returning `409 CONFLICT`. In practice this is implemented unevenly:

- **Membership edits use an explicit integer `version` column.** `PATCH /org/members/:userId` and `/active` accept an optional `version` token; a mismatch throws `VersionConflictError` (`apps/api/src/services/org.service.ts:346`) → `409 VERSION_CONFLICT`, with the current server version surfaced in `details[0].current_version`.
- **Bam task writes do not enforce a stale check.** `api-reference.md` documents `PATCH /tasks/:id` honoring `If-Match` with a 409 on conflict, but `taskService.updateTask` always stamps `updated_at: new Date()` and has no expected-version guard. The 409s the task routes actually emit (`task.routes.ts:337/362/398`) are domain conflicts - `IncompleteSubtasksError`, `TaskRelationCycleError` - not optimistic-concurrency rejections. Treat the documented task-level `If-Match` behavior as aspirational.

### Shared Zod schemas

Validation lives in `@bigbluebam/shared` (`packages/shared/src/schemas/`) and is imported by both client and server, so request shapes have a single source of truth (e.g. `registerSchema`, `loginSchema`, `superuser*` schemas). Routes that need only a local shape define an inline `z.object({...})` and call `.parse(request.body)` (see `label.routes.ts:80`); a Zod parse failure becomes the `VALIDATION_ERROR` envelope.

### Storage conventions: float positions, JSONB custom fields

Orderable rows use float positions so reordering never renumbers siblings: `tasks.position` is `doublePrecision('position')` (`apps/api/src/db/schema/tasks.ts:56`), indexed by `(phase_id, position)`, and a move sets a midpoint value (e.g. `2048.0`). Per-project custom fields are stored as `tasks.custom_fields jsonb` (line 74, default `{}`), keyed by the field-definition UUID, with definitions in a separate `custom_field_definitions` table; `tasks.links` is a second JSONB column.

### Health and readiness

`@bigbluebam/service-health` (`packages/service-health/src/index.ts`) is a `fastify-plugin` registered by every Node service. It exposes `GET /health` (always 200 - liveness, returns `{ status:'ok', service, version, timestamp }`), `GET /health/ready` (readiness - runs each configured dependency check with a 5 s timeout and returns 503/`degraded` if any fails), and `GET /metrics` (uptime/memory/pid). Note the route names are `/health` and `/health/ready`, **not** `/healthz` + `/readyz`; the CLAUDE.md summary's "/healthz + /readyz" label is stale.

### How a route is structured

The pattern is a Fastify route plugin plus an optional service module. A route file default-exports `async function xRoutes(fastify)` and registers handlers with a `preHandler` chain that composes cross-cutting middleware: `requireAuth`, capability checks (`fastify.requireCan('bam.task.move')` or `requireScope('read_write')`), and entity-scoped authorization (`requireProjectAccessForEntity('task')`). The handler parses input with Zod, then either runs Drizzle queries directly for simple CRUD (the label routes query `db` inline) or delegates to a service module under `apps/api/src/services/` (`task.routes.ts` calls `taskService.updateTask/moveTask`). Services own business rules and throw typed errors (`IncompleteSubtasksError`, `VersionConflictError`, `TaskRelationCycleError`) that the route layer catches and maps to the appropriate status + envelope, keeping HTTP concerns in the route and domain logic in the service.

## 11. The MCP Server & Tool Catalog

The MCP server (`apps/mcp-server/`) is BigBlueBam's agent control plane: a single Model Context Protocol endpoint through which any MCP-compatible client - Claude Desktop, Claude Code, IDE extensions, or a custom service-account agent - can drive the entire suite with the same authority a human has in the web UI. Built on `@modelcontextprotocol/sdk`, it runs as a stateless sidecar container on internal port `3001` (`MCP_PORT` defaults to `3001`, see `apps/mcp-server/src/env.ts`) and is exposed publicly at `/mcp/` through the shared nginx proxy on port 80. It holds no data of its own; every tool handler is a thin (or composite) HTTP caller against the per-app Fastify APIs over the internal Docker network.

### 11.1 Transports and exposure

Three transports are supported, selected by the `MCP_TRANSPORT` env var (`z.enum(['streamable-http', 'stdio', 'sse'])`, default `streamable-http`, in `env.ts`):

- **Streamable HTTP** (primary): `POST /mcp` for client→server requests, `GET /mcp` for the server→client SSE notification stream on an established session, `DELETE /mcp` to terminate. Session transports are tracked in a `Map<string, StreamableHTTPServerTransport>` (`server.ts:92`).
- **SSE** (legacy/back-compat): `/sse` + `/messages`, only wired when `MCP_TRANSPORT=sse`; otherwise those routes 404.
- **stdio**: for local CLI/IDE/`docker exec` integrations.

Canonical client endpoint is `/mcp/` (trailing slash optional). `/mcp/health` is an unauthenticated liveness probe. Routing lives in `infra/nginx/nginx-with-site.conf` (with `nginx.railway.conf` auto-generated from it) and mirrors `apps/mcp-server/src/server.ts`.

### 11.2 Scale and shape of the tool catalog

The live catalog is **733 tools across 46 modules** in `apps/mcp-server/src/tools/*.ts` (verified: summing `registerTool(` occurrences yields exactly 733; `ls tools/*.ts | wc -l` yields 46). This matches CLAUDE.md. Note: `docs/reference/mcp-server.md` still claims "340 tools across 43 modules" - that figure and its per-module tables are stale and should not be trusted over the source tree.

Per-app breakdown (registerTool count per module): Banter 77, Bond 69, Brief 48, Bill 47, Board 40, Beacon 38, Bureau 38, Blueprint 37, Bench 32, Bearing 30, Blast 28, Book 25, Bolt 24, Blank 20. Bam core (~105) is split across `project-tools`, `task-tools`, `sprint-tools`, `comment-tools`, `member-tools`, `me-tools`, `report-tools`, `epic-tools`, `template-tools`, `import-tools`, and the `bam-resolver` modules. Helpdesk has 11.

On top of the per-app catalogs sits the **cross-cutting platform surface** (~64 tools), which is what makes this a control plane rather than 16 separate API facades: agent identity/audit/heartbeat (`agent-tools.ts`), agent policies (`agent-policy-tools.ts`), outbound webhooks (`agent-webhook-tools.ts`), approval proposals (`proposal-tools.ts`), the `can_access` visibility preflight (`visibility-tools.ts`), unified activity (`activity-tools.ts`), cross-app `search_everything` (`search-tools.ts`), the `resolve_references` fuzzy resolver (`resolve-tools.ts`), composite `account_view`/`project_view`/`user_view` (`composite-tools.ts`), `entity_links` (`entity-links-tools.ts`), federated attachments (`attachment-tools.ts`), dedupe (`dedupe-tools.ts`), phrase counts, expertise, Banter pattern subscriptions, Bolt observability, and ingest fingerprinting.

### 11.3 The register-tool wrapper (policy gate)

Every tool registers through `registerTool()` in `apps/mcp-server/src/lib/register-tool.ts`, which wraps the handler so each invocation passes through a per-session `PolicyGate` (keyed by `McpServer` identity in a `WeakMap`, attached via `attachPolicyGate` before any registration runs). The gate fail-closes the §15 `agent_policies` controls:

- **Human callers** (`/auth/me` returns `kind === 'human'`) bypass the gate entirely.
- **Always-permitted core tools** - `get_server_info`, `get_me`, `agent_heartbeat` (the `ALWAYS_PERMITTED_TOOLS` set) - run regardless of policy, so a disabled agent can still identify itself and heartbeat.
- **Agent/service callers** are checked against the agent's enabled flag and glob-prefix `allowed_tools` allowlist via `POST /v1/agent-policies/:id/check?tool=...`, with a short-TTL in-process decision cache (`DEFAULT_CACHE_TTL_MS = 5_000`, capped at 30s) invalidated by Redis PubSub. A kill-switched agent gets `AGENT_DISABLED`; a tool outside the allowlist gets `TOOL_NOT_ALLOWED` (`buildPolicyDenialResult`). **Unknown** callers fail-closed. A separate, env-gated Wave D layer (`BBB_PERMISSIONS_ENFORCE` = `off`/`warn`/`on`) can additionally run a synchronous per-action permission resolver (`checkPermissionViaResolver`) and block with `PERMISSION_DENIED`.

### 11.4 Two-step destructive confirmation

Destructive tools (delete task, complete sprint, delete channel, end call, etc.) route through the `confirm_action` tool (`apps/mcp-server/src/tools/utility-tools.ts`). The first call stages the action and returns a token; the second call replays the token to execute. Tokens are Redis-backed (`apps/mcp-server/src/lib/confirm-token-store.ts`, key prefix `mcp:confirm_token:`, expiry enforced by Redis `SET ... PX`), so the staging and confirm legs can land on different MCP instances behind a load balancer and survive rolling deploys; if Redis is unavailable the store degrades gracefully to an in-process `Map` with a 30s sweeper. The **TTL is dynamic**: `CONFIRM_TTL_AGENT_MS = 60_000` (agent-to-agent chains) versus `CONFIRM_TTL_HUMAN_MS = 5 * 60_000` (when `approver_user_id` resolves to a `kind === 'human'` user, so async human review is feasible). `resolveConfirmTtlMs` falls back to the short agent TTL on any probe failure.

### 11.5 Internal `/tools/call` and service accounts

For in-cluster service-to-service invocation (bolt-api's action runner, worker, api), the server also hosts `POST /tools/call` (`apps/mcp-server/src/routes/tools-call.ts`), a Wave-0.2 direct-invocation shortcut that bypasses the Streamable-HTTP/SSE session handshake. It authenticates with a timing-safe-compared `X-Internal-Secret` (`INTERNAL_SERVICE_SECRET`, shared across api/worker/bolt-api/mcp-server), constructs a per-request `ApiClient` from a service-account bearer token, and returns the raw MCP `CallToolResult` as JSON. `X-Org-Id`/`X-Actor-Id` headers are advisory (audit only); real authorization always flows through the service-account token. Service accounts are locked, no-login users minted via `cli.js create-service-account` carrying a `bbam_svc_` key prefix, and every service-account invocation is subject to the §11.3 policy gate.

### 11.6 REST↔MCP surface-map discipline

`docs/reference/mcp-endpoint-mapping.md` is the authoritative map of the full surface. Its current summary records **971 REST endpoints** (718 with an MCP tool, 253 without) plus **16 MCP-only tools** with no backing endpoint. The convention is that every REST row's MCP column is either a real tool name or an explicit ` - _(skip: <reason>)_`, never a bare ` - `. The map is not yet CI-enforced, so it is maintained by hand in the same change that touches any endpoint, tool, CLI command, or UI call site; the self-check `grep -cE '^\| \`[^|]+\` \| - \|' docs/reference/mcp-endpoint-mapping.md` must print `0`.

## 12. The Agentic Platform

Beyond the per-app MCP catalogs (Bam, Banter, Bond, Brief, etc.), BigBlueBam ships a set of *cross-cutting* agent surfaces that any service-account-driven agent uses regardless of which app it is touching. These live primarily in `apps/mcp-server/src/tools/` (one module per concern) backed by `/v1/...` routes on the Bam API, and by migrations `0127`-`0140`. The authoritative protocol is `docs/reference/agent-conventions.md`; the visibility logic is `apps/api/src/services/visibility.service.ts`.

### 12.1 Identity, audit, heartbeat (migration 0127)

`users.kind` is an enum (`human` / `agent` / `service`) that is mirrored onto `activity_log.actor_type` at write time, so the audit trail records *what kind of actor* produced each row, not just its id. The `agent_runners` table records a runner per service-account user with `last_heartbeat_at`, version, and an advertised `capabilities` array. The MCP module `agent-tools.ts` exposes four tools: `agent_heartbeat` (service-account only - upserts the `agent_runners` row by service-account user id, bumps `last_heartbeat_at`; non-service callers get `403 NOT_A_SERVICE_ACCOUNT`), `agent_self_report` (service-account only; appends an `action='agent.self_report'` row to `activity_log` under a **required** `project_id`), `agent_audit` (any authed user; paginated `activity_log` stream for one agent), and `agent_list` (any authed user; runners sorted by `last_heartbeat_at` desc, a `NULL` value meaning registered-but-never-seen). `agent_heartbeat` is on the always-permitted core list (see 12.6) so a disabled agent can still mark itself alive for triage.

### 12.2 Approval queues (migration 0128)

`agent_proposals` is a durable approval inbox, distinct from fire-and-forget Bolt approval events. `proposal-tools.ts` provides `proposal_create` (records `proposed_action`, optional `proposed_payload`, an `approver_id`, optional `subject_type`/`subject_id`, and a `ttl_seconds` defaulting to 7d / max 30d), `proposal_list` (defaults to pending rows where the caller is approver or actor; org admins see the whole org queue; `status=all` removes the filter), and `proposal_decide` (`approve` / `reject` / `request_revision` - only the designated approver or an org admin; `409` if already decided, `410` if expired). The lifecycle emits `proposal.created` and `proposal.decided` Bolt events on the `platform` source.

### 12.3 Unified activity view (migration 0129)

`v_activity_unified` is a SQL view that UNIONs Bam `activity_log`, `bond_activities`, and helpdesk `ticket_activity_log` into normalized columns. A semantic collision is handled at the view level: Helpdesk's `actor_type='agent'` (meaning a *human* support agent) is remapped to the §10 `'human'` kind so it does not read as an autonomous agent.

### 12.4 Read plane (Wave 3)

The read plane gives agents one fan-out surface instead of per-app polling. `search_everything` (`search-tools.ts`) fans out across apps with normalized scoring and an optional asker-mode that runs `can_access` filtering inline. `resolve_references` (`resolve-tools.ts`) does deterministic mention extraction (canonical syntax in `packages/shared/src/mention-syntax.ts`) plus per-app search. `activity_query` and `activity_by_actor` (`activity-tools.ts`) read the unified view. The composite tools `account_view`, `project_view`, and `user_view` (`composite-tools.ts`) assemble cross-app rollups for a single subject in one call.

### 12.5 Write plane (Wave 4, migrations 0130-0133)

Idempotent writes are the headline: `bond_upsert_contact`, `beacon_upsert_by_slug`, `helpdesk_upsert_user`, and `task_upsert_by_external_id` each create-or-update and emit a `*.upserted` event carrying a `created` boolean so a re-run is safe. `task_upsert_by_external_id` is backed by the `task_external_id` column (0130). `banter_schedule_post` schedules posts honoring per-channel quiet hours (`banter_channels_quiet_hours`, 0133). The `entity_links` table (0132) is a durable cross-app linking layer, backfilled from known per-app FKs, so a Bond deal and a Bam project can be tied together first-class rather than by convention. `attachment_get` / `attachment_list` (`attachment-tools.ts`) are a federated dispatcher routing to the owning app's blob store; the scan-status column (0131) gates serving.

### 12.6 Agent policies and outbound webhooks (Wave 5, migrations 0139 + 0140)

`agent_policies` (0139) drives a per-agent kill switch (`enabled`) and a glob-prefix `allowed_tools` allowlist: `'*'` allows everything, `'banter.*'` / `'banter_*'` allow by prefix, bare entries are exact. Enforcement is in `apps/mcp-server/src/lib/register-tool.ts`: every `registerTool` call wraps its handler in a `PolicyGate.check()`. The gate **fail-closes** - human callers and the `ALWAYS_PERMITTED_TOOLS` set (`get_server_info`, `get_me`, `agent_heartbeat`) bypass; everyone else is denied unless `POST /v1/agent-policies/:id/check?tool=` returns `allowed`. Decisions are cached per session (default 5s TTL, 30s ceiling) and invalidated via Redis PubSub (`agent_policies:invalidate`); an `'unknown'` caller kind or any non-2xx fails closed with `AGENT_DISABLED`. Denials return a structured `AGENT_DISABLED` / `TOOL_NOT_ALLOWED` error envelope (`buildPolicyDenialResult`). `agent-policy-tools.ts` (`agent_policy_get` / `_set` / `_list`) exposes the table; `_set` returns `confirmation_required: true` when flipping a live agent to disabled (advisory - the row is already written, the two-step gate lives at the UI). Note the file also wires a `BBB_PERMISSIONS_ENFORCE` per-action resolver layer (off / warn / on) via `/internal/permissions/dual-read` (migrations 0144-0149); `'on'` blocks on an explicit resolver `deny` with a distinct `PERMISSION_DENIED` code.

Outbound webhooks (0140) push subscribed Bolt events to agent runners. `agent-webhook-tools.ts` provides `agent_webhook_configure` (HMAC secret minted, argon2id-hashed, plaintext returned **once**; `event_filter` entries shaped `source:event_type` / `source:*` / `*`; SSRF guards reject loopback/link-local/cloud-metadata/`*.internal` and require https in production), `agent_webhook_rotate_secret` (no grace window, unlike API keys), `agent_webhook_deliveries_list`, and `agent_webhook_redeliver`. The `agent_webhook_deliveries` table tracks `status` (`pending`/`delivered`/`failed`/`dead_lettered`) and `attempt_count`; `webhook_consecutive_failures` on the runner drives a 20-failure circuit-breaker auto-disable. (The 0s/30s/2m/10m/30m/2h/6h backoff schedule and 256KB cap described in CLAUDE.md live in the worker dispatcher rather than the migration body.)

### 12.7 Visibility preflight - the `can_access` contract

Because an agent runs under its *own* service-account key, its RLS-scoped reads see the agent's visibility, not the asker's. Before surfacing any cited entity in a shared channel an agent MUST call `can_access(asker_user_id, entity_type, entity_id)` (MCP) → `POST /v1/visibility/can_access`, implemented by `preflightAccess()` in `visibility.service.ts`. The dispatch is **deny-by-default**: the `switch` covers exactly the 20 types in `SUPPORTED_ENTITY_TYPES` (`bam.task/project/sprint`, `helpdesk.ticket`, `bond.deal/contact/company`, `brief.document`, `beacon.entry`, `blueprint.diagram/node`, `banter.message/channel`, `bearing.goal/kr`, `board.board`, `book.event`, `bill.invoice`, `blank.form`, `bolt.rule`); anything else returns `allowed: false, reason: 'unsupported_entity_type'`. Each branch mirrors (but does not reuse) the owning app's predicate. Cross-org references and genuine non-existence both return `not_found` to avoid leaking existence; within-org denials carry specific reasons (`not_project_member`, `private_document_no_collaborator`, `bond_restricted_role_not_owner`, `beacon_private_not_owner`, `banter_not_channel_member`, `board_private_no_collaborator`). One documented inconsistency: `blueprint.diagram`/`node` enforce only the org-id gate at this layer (an explicit MVP simplification noted in the source) - the full per-collaborator rule set is enforced authoritatively by blueprint-api's `assertCanRead` at the request boundary.

### 12.8 Long tail - dedupe, trends, expertise (Wave 5)

`dedupe-tools.ts` offers `bond_find_duplicates` and `helpdesk_find_similar_tickets`, plus `dedupe_record_decision` backed by the `dedupe_decisions` table (0136). Trend queries `helpdesk_ticket_count_by_phrase` and `bam_task_count_by_phrase` live in `phrase-count-tools.ts`. `expertise_for_topic` (`expertise-tools.ts`) ranks people by topic. Banter agent-pattern subscriptions (`banter_agent_subscriptions`, 0134) drive `can_access`-gated worker fan-out, and Bolt observability (`bolt-observability-tools.ts`, evaluation trace in 0138) lets agents trace event evaluation.

## 13. Permissions, AuthZ & Identity

BigBlueBam runs two authorization systems side by side: the legacy role/scope middleware that still gates most requests, and a newer **granular permission engine** (`@bigbluebam/permissions`) that is being rolled out behind a staged enforcement flag. Understanding both - and which one is canonical at any moment - is essential.

### 13.1 The granular permission catalog

The action catalog lives in `packages/permissions/src/generated/permissions.ts`, auto-generated by `scripts/build-permission-codegen.mjs` from `docs/permissions-action-manifest.json`. As of this writing it declares **1071 permissions across 17 apps**. Each permission is an `app.resource.verb` id (e.g. `bam.task.create`, `banter.message.delete`, `platform.org.delete`) with metadata: `is_destructive`, `requires_confirmation`, `is_read`, and `requires_superuser`. The package also exports `ALWAYS_PERMITTED` (a 3-element set: `platform.system.get_info`, `platform.user.get_profile`, `agent.self.heartbeat`), plus `TOOL_TO_PERMISSION` and `ROUTE_TO_PERMISSION` maps so the MCP `register-tool` wrapper and REST routes can look up a permission id without re-deriving it.

### 13.2 The resolver

`packages/permissions/src/resolver.ts` exports a pure function `resolve(ctx, permissionId, scope)` (no I/O) returning a `{ decision, reason }` (`ResolveResult`). The ordered evaluation is:

1. **`superuser_bypass`** - `ctx.subject.is_superuser` → allow immediately.
2. **`always_permitted_core`** - id in `ALWAYS_PERMITTED` → allow. A second short-circuit allows the entire `helpdesk.*` namespace (the customer-portal auth model is preserved at helpdesk-api's own layer), and a `requires_superuser`-flagged permission (set by migration `0152`) denies any non-SuperUser regardless of group defaults - without it the Owner builtin, which grants every permission, would reach `/superuser/*` surfaces.
3. **`api_key_ceiling`** - if `api_key_scope` is non-null: `read` denies any non-read verb; `read_write` denies destructive verbs. The destructive check reads the catalog's `is_destructive` column, falling back to a verb set (`delete`, `archive`, `transfer`, `set_role`, `invite`, `remove`, …) for permissions added between codegen runs. Session auth has `api_key_scope === null` and no ceiling.
4. **`agent_policy`** - only for `kind in (agent, service)`: deny if policy missing/`!enabled` (`agent_disabled`), or if the id matches no glob in `allowed_tools` (`agent_tool_not_allowed`). Mirrors the §15 outer gate in `apps/mcp-server/src/lib/register-tool.ts`.
5. **`account_override` → `group_default`** - per scope, in order project → org → global. At each scope `resolveAtScope` checks `account_permissions` (explicit per-user grant/deny) before falling to the user's `permission_group_defaults` via `account_group_memberships`. A membership with `detached_at` set is *snapshotted*: only `account_permissions` rows count (the `account_permissions` detach trigger freezes the group's defaults at detach time, `is_snapshot=true`). Reason codes distinguish `project_override`/`org_group_default`/`global_snapshot`/etc.
6. **`implicit_deny`** - catalog has the id but no scope answered. (`permission_not_in_catalog` if the id is unknown - a distinct reason for telemetry.)

### 13.3 `requireCan` middleware and rollout modes

`packages/permissions/src/index.ts` ships `permissionsPlugin` (decorates `fastify.requireCan(permissionId)` and `canResolve`) plus an HTTP-backed `httpPermissionsPlugin` for satellite APIs that POST to apps/api's `/internal/permissions/dual-read`. Enforcement is gated by `BBB_PERMISSIONS_ENFORCE` (`apps/api/src/env.ts:124`, default `'off'`):

- **off** - `requireCan` mounts as a no-op; every check resolves allow. Legacy gates remain canonical.
- **warn** - runs the resolver, records divergence against the legacy decision (via `reportDivergence`), never blocks.
- **on** - denies return HTTP 403 `PERMISSION_DENIED` with `{ permission_id, reason }`; null context returns 401.

The system is currently shipped at the legacy-canonical end of this rollout; the granular engine is dual-read/measurement until the flag flips. (`shadowOnly` is the telemetry-only gate; the docstring notes `dualReadGate` was removed in Waves E.A/E.B.)

### 13.4 Builtin groups and legacy_role mapping

Migration `0146_permissions_builtin_groups.sql` seeds five immortal (`is_builtin=true`) global-scope groups, each carrying a `legacy_role`: **Owner** (every permission), **Admin** (all except `platform.org.delete`, `%.transfer*`, and platform-settings actions), **Member** (read everywhere, write on most resources, no org/member admin), **Viewer**, **Guest** (project-scoped read). This bridges the legacy role world to the catalog: a user's legacy org role maps to the same-named group's defaults.

### 13.5 Legacy roles, SuperUser, and the rank rule

The original model (`docs/reference/permissions.md`) defines five org roles - `owner`, `admin`, `member`, `viewer`, `guest` - stored in `organization_memberships` (CHECK-constrained, one row per `(user_id, org_id)`, partial unique index on `is_default`), plus a separate `users.is_superuser` boolean. SuperUser is **not** an org role; it is checked first (`apps/api/src/middleware/require-superuser.ts`: 401 if unauthenticated, 403 if `is_superuser !== true`) and bypasses everything, including cross-org access via `sessions.active_org_id` and impersonation (`X-Impersonate-User`).

`checkRankAbove(callerRole, targetRole, callerIsSuperuser)` in `apps/api/src/services/org.service.ts:358` enforces **strictly below** on every admin-on-member action: `ROLE_HIERARCHY = ['guest','viewer','member','admin','owner']`; the caller must be ≥ admin and `callerLevel > targetLevel` (not `≥`), so one admin cannot act on a peer admin and one owner cannot modify another owner - only a SuperUser can. Violations raise `InsufficientRankError` → 403. The motivation is containment: a single compromised admin cannot lock out the others.

### 13.6 RLS, API keys, service accounts, OAuth, bootstrap

**RLS** uses PostgreSQL policies gated by the `app.current_org_id` GUC (set per-request by `apps/api/src/plugins/rls.ts`); the role's bypass flag is toggled at boot from `BBB_RLS_ENFORCE` (default off during the staged Wave 1.A rollout; `1` forces NOBYPASSRLS). The permission tables (`account_permissions`, `account_group_memberships`) carry their own org-isolation policies.

**API keys** are prefixed `bbam_` (user) or `bbam_svc_` (service-account), stored as Argon2id hashes, looked up by a short `key_prefix` to bound verifications, with timing-safe verification (`argon2.verify` runs before the `expires_at` check). Scopes are `read`/`read_write`/`admin` with optional `project_ids` restriction; `requireScope(minScope)` in `apps/api/src/plugins/auth.ts` enforces them (no-op for session auth and SuperUsers). `admin` scope is owner/SuperUser-only (`403 ADMIN_SCOPE_OWNER_ONLY`). Rotation (migration 0117) supports a 7-day grace window where both predecessor and current secret authenticate for zero-downtime rollover.

**Service accounts** are locked, no-login users minted via `cli.js create-service-account`, carrying `bbam_svc_` tokens, used for internal calls like the MCP `POST /tools/call` route.

**OAuth SSO** (migrations 0118/0119) lives in `apps/api/src/routes/oauth.routes.ts`, with providers in `oauth_providers` and linkage in `oauth_user_links`.

**First-run bootstrap**: `POST /auth/bootstrap` atomically creates the first org/user/membership/session when no non-sentinel SuperUser exists (rate-limited 5/5min/IP, audited). `isBootstrapRequired()` gates it; `/public/config` surfaces `bootstrap_required` and `/root-redirect` forces `/b3/bootstrap` until the first account is minted.

Two caveats worth flagging: the prose doc (`docs/reference/permissions.md` §7) still describes the *legacy* check order, not the resolver's; and the resolver path is non-canonical until `BBB_PERMISSIONS_ENFORCE` leaves `off`.

## 14. Realtime, Background Jobs & Supporting Infrastructure

This section covers the cross-cutting infrastructure every BigBlueBam app leans on: WebSocket realtime with Redis fan-out, the BullMQ worker, the LiveKit SFU and voice agent, object storage, Qdrant vector search, and email delivery. The authoritative narrative is `docs/reference/architecture.md` ("Real-Time Architecture"); the operational details below are verified against the running code and configs.

### 14.1 Realtime: WebSocket per app + Redis PubSub

Realtime is not a single hub. Each app that needs live updates runs its own WebSocket endpoint inside its Fastify service, and nginx proxies a per-app `/ws` path to it (`infra/nginx/nginx.conf`):

- `/b3/ws` → `api:4000/ws`
- `/banter/ws` → `banter-api:4002/ws`
- `/helpdesk/ws` → `helpdesk-api:4001/helpdesk/ws`
- `/brief/ws` → `brief-api:4005/ws`
- `/board/ws` → `board-api:4008/ws`
- `/blueprint/ws` → `blueprint-api:4015/ws`
- `/bureau/ws` → `bureau-api:4015/bureau/ws` (note: the nginx config maps both Blueprint and Bureau to host `:4015`; the `bureau-api` port assignment overlaps Blueprint's in this file - flag as a probable config collision to confirm against the actual `bureau-api` listen port)

Horizontal scaling is handled by **Redis PubSub**, not by sticky sessions. When the API mutates state it (1) writes to Postgres, (2) publishes an event to a Redis channel, (3) every API replica subscribed to that channel receives it, and (4) each replica re-broadcasts to its locally-connected WebSocket clients in the matching room. Rooms are scoped at three levels - `org:{org_id}`, `project:{project_id}`, and `user:{user_id}` - so a `task.created` goes to `project:{id}` while a `notification` goes to `user:{id}`. The Bam event vocabulary (`task.created`, `task.moved`, `task.reordered`, `comment.added`, `sprint.status_changed`, `user.presence`, etc.) is tabulated in the architecture doc.

Helpdesk is a separate hub that shares the same Redis channel (`bigbluebam:events`) so events published anywhere fan out to portal clients. It auto-subscribes every client to `helpdesk:user:{userId}`, gates `ticket:{ticketId}` subscriptions on a server-side ownership check, and - unique among the apps - persists customer-facing broadcasts to `helpdesk_ticket_events` *before* publishing, making the DB row the source of truth and PubSub the push optimization. Clients track the highest event id seen and `resume` after reconnect (replay also available via `GET /helpdesk/tickets/:id/events?since=<id>`). See `apps/helpdesk-api/src/ws/handler.ts` and `apps/helpdesk-api/src/lib/broadcast.ts`.

### 14.2 BullMQ worker

`apps/worker` is a port-less BullMQ consumer (`apps/worker/src/worker.ts`, ~1875 lines) that connects to Redis, registers one `Worker` per queue, and logs completion/failure per job. **CLAUDE.md's "16 job handlers" is stale** - `apps/worker/src/jobs/` contains roughly 50 handlers. The real set spans every app:

- **Bam core**: `email`, `notification`, `export`, `sprint-close`, `task-link-title-fetch`.
- **Banter**: `banter-notification`, `banter-retention` (self-scheduled daily via a `banter-retention` Queue), `banter-transcription`, `banter-scheduled-post`, `banter-pattern-match`, `banter-feed-fanin`.
- **Helpdesk**: `helpdesk-task-create`, `helpdesk-email-notify`, `helpdesk-sla-monitor`.
- **Bond/CRM**: `bond-stale-deals` (daily rotting-deal sweep), `bond-bulk-score`.
- **Beacon/Brief (vector + lifecycle)**: `beacon-vector-sync`, `beacon-expiry-sweep`, `brief-embed`, `brief-snapshot`, `brief-export`, `brief-cleanup`.
- **Bearing**: `bearing-digest`, `bearing-recompute`, `bearing-snapshot`, `bearing-watcher-notify`.
- **Bench**: `bench-mv-refresh`, `bench-report-deliver`. **Bill**: `bill-pdf-generate`, `bill-email-send`, `bill-overdue-reminder`, `bill-recurring-generate`. **Blast**: `blast-send`. **Blank**: `blank-confirmation-email`, `blank-file-process`. **Board**: `board-thumbnail`. **Book**: `book-calendar-sync`.
- **Bolt automation**: `bolt-execute`, `bolt-schedule-tick`, `bolt-execution-cleanup`.
- **Bureau presence**: `bureau-presence-reap`, `bureau-knock-timeout`, `bureau-summon-fanout`, `bureau-booking-lifecycle`, `bureau-chat-expiry`, `bureau-analytics-rollup`.
- **Infra watchdogs**: `livekit-ip-drift`, `turn-cert-expiry`, plus `agent-webhook-dispatch` / `agent-webhook-dlq` (outbound HMAC webhooks) and `slack-import`.

### 14.3 LiveKit SFU + voice-agent

Realtime audio/video (Board conferencing, Bureau presence, the voice agent) runs through a LiveKit SFU. The defining constraint is **zero hardcoded network addresses**: `scripts/livekit/render-config.mjs` renders `infra/livekit/livekit.yaml` (gitignored) from a template, advertising a *list* of ICE candidates so WebRTC negotiates per-client. In `host` mode it detects the LAN IP via the UDP-connect routing trick and persists it to `.lan-ip`; in `container` mode the `livekit-config` one-shot compose service re-detects the WAN IP via STUN on every `docker compose up`. Because nothing re-renders while a stack keeps running and small-office WAN IPs rotate, the hourly **`livekit-ip-drift`** worker re-checks the public IP against `advertised.json` (read-only mount at `/livekit-info`) and writes a deduped `LIVEKIT_WAN_IP_DRIFT` row to `system_errors` with the exact remediation command rather than attempting a fix it has no Docker authority to make. Full reference: `docs/livekit-networking-notes.md`. The `voice-agent` is a Python/FastAPI service (`apps/voice-agent/src/`: `pipeline.py`, `stt.py`, `registry.py`, `api.py`) on internal `:4003`, currently a placeholder STT/TTS pipeline.

### 14.4 Object storage (MinIO/S3)

Attachments live in MinIO (S3-compatible), served to browsers under nginx `/files/` → `api:4000/files/`. The reference implementation is `apps/api/src/services/upload.service.ts`: a `minio.Client` built from `S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_REGION`, with `uploadFile`/`getFileStream`/`deleteFile`, lazy `ensureBucket`, **24-hour presigned GET URLs** (`presignedGetObject(..., 24*60*60)`), and a stable key layout `${orgId}/${projectId}/${taskId}/${uuid}-${filename}`. CLAUDE.md calls the client "triplicated"; it is actually duplicated in **seven** places - `apps/api`, `apps/helpdesk-api`, `apps/banter-api` (×2: `file.routes.ts`, `slack-import.service.ts`), `apps/beacon-api/src/lib/minio.ts`, `apps/blank-api/src/lib/storage.ts`, and `apps/worker/src/utils/storage.ts` - a candidate for extraction into a shared package.

### 14.5 Qdrant vector search

Qdrant backs semantic retrieval. Beacon is the most complete consumer (`apps/beacon-api/src/lib/qdrant.ts`, `qdrant.service.ts`, `embedding.service.ts`, `search.service.ts`), with Brief also depending on it (`@qdrant/*` in `apps/brief-api/package.json`, `brief-embed` worker job, `apps/brief/src/hooks/use-search.ts`). **Bond does not use Qdrant**: there is no Qdrant dependency in `apps/bond-api/package.json` and no Qdrant import in its source, so CLAUDE.md's "Beacon, Brief, and Bond semantic retrieval" overstates Bond's status - treat Bond semantic search as not-yet-implemented.

### 14.6 Email / SMTP

Email delivery routes through the worker. SMTP credentials are resolved by the shared `@bigbluebam/smtp-resolver` package wrapped in `apps/worker/src/utils/smtp-config.ts`, deliberately the single source of truth so the API and worker can never disagree about whether the platform can send mail (the wrapper's comment cites the 2026-06-11 "SMTP not configured" false-negative as the reason). Many jobs emit mail through this path: `email`, `helpdesk-email-notify`, `bill-email-send`, `bill-overdue-reminder`, `blank-confirmation-email`, `blast-send`, and `bearing-watcher-notify`.

## 15. Coding Standards & Development Workflow

### 15.1 Language, runtime, package manager

Everything server-side runs on **Node.js 22** (the root `package.json` pins `"engines": { "node": ">=22.0.0" }`) and is written in **TypeScript 5.7** (`typescript@^5.7.3`, devDependency at the root). The repo is a **pnpm 9 workspace** (`"packageManager": "pnpm@9.15.4"`) orchestrated by **Turborepo 2** (`turbo@^2.3.3`). All app code is ESM: API source uses `.js` extensions on relative imports (e.g. `import { db } from '../db/index.js'`) because the compiled output is native ESM. The dev guide's stated TypeScript posture - `strict` mode everywhere, explicit return types on exported functions, `unknown` over `any`, `interface` over `type` for object shapes - is convention, not all machine-enforced (Biome only *warns* on `noExplicitAny`).

### 15.2 Biome (formatting + linting)

`biome.json` (schema `1.9.4`, matching `@biomejs/biome@^1.9.4`) is the single formatter/linter config at the repo root. Global formatter settings: **2-space indentation**, **100-character line width**, JS/TS **single quotes**, **always semicolons**, **trailing commas "all"** (note: "all", not the "ES5" the dev guide claims - the guide is stale here). `organizeImports` is on globally, the `recommended` lint ruleset is enabled, and `node_modules`, `dist`, `.turbo`, `coverage` are ignored.

There is one large `overrides` block that is easy to misread: for `apps/**/src/**`, `apps/**/test/**`, and top-level `src/`/`test/`, the **formatter and organizeImports are disabled** and only a curated list of lint rules (all set to `"warn"`) applies - `noExplicitAny`, `useExhaustiveDependencies`, `noForEach`, the full `a11y` family, etc. The practical consequence: Biome does *not* auto-format the bulk of application source; it lints it with warnings. Commands: `pnpm format` (`biome format --write .`) and `pnpm check` (`biome check --write .`). `pnpm lint` runs `turbo run lint` per package. The dev guide mentions ESLint alongside Biome; the root toolchain is Biome-only, so treat ESLint references as historical.

### 15.3 Shared-Zod discipline

Validation schemas live once in `@bigbluebam/shared` (`packages/shared/src/schemas/*.ts`, re-exported from `packages/shared/src/index.ts`) and are consumed by both the API (request/response validation) and the frontend (form validation, typing). Types are derived, never hand-written: `export type CreateWidgetInput = z.infer<typeof createWidgetSchema>`. Because `shared` is a build dependency, `turbo.json` makes `build`, `lint`, `typecheck`, and `test` all `dependsOn: ["^build"]`, so `@bigbluebam/shared` compiles before any consumer. When iterating locally, build it first: `pnpm --filter @bigbluebam/shared build`.

### 15.4 Layered route → service → schema pattern

The intended layering is: **Drizzle schema** (`apps/*/src/db/schema/*.ts`) defines tables; a **service** (`apps/*/src/services/*.service.ts`) holds the data-access/business logic; a **route** (`apps/*/src/routes/*.routes.ts`) is a thin Fastify plugin that parses input with a shared Zod schema, calls the service, and shapes the reply. The repo really is organized this way - `apps/api/src/services/` has dedicated files like `auth.service.ts`, `org.service.ts`, `entity-links.service.ts`, and `apps/api/src/routes/` has the matching `*.routes.ts` plugins. Caveat: the worked example in `docs/guides/development.md` inlines `db.insert(...)`/`db.select(...)` directly in the route handler and skips the service layer. That is a simplification for the doc; new endpoints with non-trivial logic should put it in a service, matching the existing service files rather than the doc snippet.

### 15.5 Naming conventions

- Route files: `<feature>.routes.ts`, default-exporting an `async (fastify) => {}` plugin, registered in `apps/<app>/src/server.ts` with a `prefix`.
- Service files: `<feature>.service.ts`, exporting named async functions.
- Drizzle schema files: plural table name (`widgets.ts`), re-exported via `db/schema/index.ts`.
- DB columns and JSON payload fields are **snake_case** (`project_id`, `created_at`); TS-local variables are camelCase.
- Migrations: `^[0-9]{4}_[a-z][a-z0-9_]*\.sql$`.
- Bolt events: bare name + explicit `source` (`deal.rotting`, not `bond.deal.rotting`).
- Branches: `<type>/<task-id>-<desc>`; commits follow Conventional Commits (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`). Per the user's memory rules, commits in this repo omit the `Co-Authored-By` trailer and avoid em dashes.

### 15.6 Step-by-step recipes

**REST endpoint:** (1) add the Zod schema to `packages/shared/src/schemas/` and export it; (2) declare the Drizzle table in `apps/<app>/src/db/schema/` and re-export it; (3) write + apply a migration (§15.7); (4) add a service function in `apps/<app>/src/services/<feature>.service.ts`; (5) add the route plugin in `apps/<app>/src/routes/<feature>.routes.ts`; (6) register it in `server.ts` with the right `prefix`; (7) add Vitest tests; (8) update `docs/reference/mcp-endpoint-mapping.md` (mandatory - the MCP-tool column must be a tool name or ` - _(skip: reason)_`, never a bare ` - `).

**MCP tool:** add a handler under `apps/mcp-server/src/tools/`, register it through `apps/mcp-server/src/lib/register-tool.ts` (the wrapper enforces the §15 `agent_policies` kill-switch/allowlist on every service-account call), and update the same surface-map doc. Destructive tools must route through the `confirm_action` two-step token flow.

**Frontend component:** create it under `apps/frontend/src/features/<area>/`, fetch via a TanStack Query hook in `apps/frontend/src/api/hooks/`, type request/response off the shared Zod types, and use optimistic updates with rollback for mutations.

### 15.7 Migrations (compressed)

Hand-author a new numbered, idempotent file in `infra/postgres/migrations/` with the required header (`-- NNNN_<name>.sql`, `-- Why:`, `-- Client impact:`). Validate with `pnpm lint:migrations`, apply with `docker compose run --rm migrate` (the migrate service bind-mounts the migrations dir, so no rebuild needed on dev hosts), then confirm zero drift with `pnpm db:check`. Applied migrations are **immutable** - the runner hashes the SQL body and aborts on any change. Never edit an applied file; for lint suppressions on already-applied files use `OFF_FILE_SUPPRESSIONS` in `scripts/lint-migrations.mjs`, not an inline `-- noqa:`.

### 15.8 Local dev

Data services first: `docker compose up -d postgres redis minio migrate`, then `pnpm dev` (runs `turbo run dev`; `dev` is `cache: false, persistent: true`). Hot-reload everything in Docker via `pnpm docker:dev` (`docker compose -f docker-compose.yml -f docker-compose.dev.yml up`); the dev override runs each Node service under `tsx watch` with `src/` bind-mounted and `NODE_ENV=development`, exposing api `:4000`, helpdesk-api `:4001`, banter-api `:4002`, bearing-api `:4007`, and the Vite frontend `:5173`. Scope work with pnpm filters: `pnpm --filter @bigbluebam/api typecheck`. **Never** `docker compose down -v` - it wipes seeded volumes.

### 15.9 "Pre-existing is not a dismissal" + verification-required culture

Two non-negotiable `CLAUDE.md` rules govern every change. First, **pre-existing errors are not a free pass**: when any verification command (`typecheck`, `test`, `lint`, `db:check`) surfaces a failure that predates your work, you must record it (a `TaskCreate` with file/line/message, or surface it in your response), fix it if small and obviously safe, and otherwise flag it loudly. Reporting a build "clean" while `tsc --noEmit` exits non-zero is prohibited; CI must be green before merge or `main`→`stable` promotion, including pre-existing reds. Second, **every task ends with a "How to see it in action" block** distinct from the summary: the exact URL path + clicks, `curl`/`psql`/`docker compose exec` invocation, visible UI string, or SQL to confirm row counts - operator-grade, plus the negative check where relevant. Purely-internal changes still get the block, stated as "nothing user-visible; confirm CI is green."

## 16. Documentation Standards & Practices

BigBlueBam treats documentation as part of the build surface, not an afterthought. Docs are versioned alongside code, several are generated from code, and the project convention (encoded in `CLAUDE.md`) is that a change which alters a documented surface must update the matching doc *in the same change*. This section maps how the project documents itself and the rules that keep those documents honest.

### 16.1 The `docs/` taxonomy

`docs/README.md` defines a deliberately lean tree (verified against the live directory listing):

- **`reference/`** - evergreen specs describing the system as it is: `architecture.md`, `api-reference.md`, `database.md`, `permissions.md`, `mcp-server.md`, `agent-conventions.md`, `cli.md`, the surface map `mcp-endpoint-mapping.md`, and the authoritative `BigBlueBam_Design_Document.md` plus its `_v1_Addendum.md`.
- **`guides/`** - task-oriented how-to: `getting-started.md`, `development.md`, `deployment.md`, `operations.md`, `railway-runbook.md`, `seeding-smoke-test.md`.
- **`apps/<name>/`** - per-app documentation, one folder for each of the 16 apps (`bam, banter, beacon, bearing, bench, bill, blank, blast, blueprint, board, bolt, bond, book, brief, bureau, helpdesk`) plus an `introduction/` chapter. Each folder carries `help.md` (the human source), the *derived* `help-index.json` (never hand-edited), and supporting `guide.md`, `marketing.md`, `mcp-tools.md`, `_narrative.md`, `_marketing_hook.md`, and `screenshots/`.
- **`plans/`** - plans for work still in flight only; shipped plans are deleted because the code is the record (e.g. Bay design draft, audit/activity viewer, Banter feed fan-in, Bolt advanced UI, configurable elements, Phase 3 workstreams).
- **Notes** at the `docs/` root (`help-system-notes.md`, `permissions-notes.md`, `banter-feed-notes.md`, `livekit-networking-notes.md`, `marketing-voice.md`, `docs-book-style-guide.md`, `docs-refresh-findings.md`) track active work and sharp edges, with `deploy/`, `history/`, `auto/`, and `images/` holding deploy decisions, one kept recovery record, generated artifacts, and shared diagrams.

### 16.2 Per-app help docs and the in-app Help Center

Each `docs/apps/<app>/help.md` is the single source of truth for that app's help, authored to the `help-doc-authoring` skill standard: an Overview, a feature reference with explicit how-to steps, named User Stories (each with `Who` / `Goal` / `Before you start` / numbered `Steps` / `Result`), and a Related section. Source priority is code first, then existing docs, then marketing/screenshots, then README - any claim not backed by a route, component, or MCP tool is flagged rather than asserted. Conventions include second-person task-oriented prose, no em dashes, exact rendered UI labels, and a leading `>` blockquote intro (confirmed in `docs/apps/bam/help.md`).

The in-app help system (notes in `docs/help-system-notes.md`, standard in `.claude/skills/suite-help-system/SKILL.md`) renders that content directly. `scripts/help/build-help-index.mjs` (`pnpm help:index`) compiles each `help.md` into the derived `help-index.json` (`{ title, toc, sections, labels, crossrefs }`), served statically by nginx at `/docs/apps/<app>/`. One shared component, `packages/ui/help-center.tsx`, provides the top-bar "(?)" Help Center (TOC, search, deep-link anchors) and the right-click "Help: \<element\>" handler. Wiring a new app is two steps: add the `@bigbluebam/ui/help-center` Vite alias and render `<HelpTrigger app="<app>" />`. Two load-bearing constraints: the component's `slugify()` must stay byte-for-byte identical to the build script's (anchors silently miss otherwise), and right-click help only resolves a control if its rendered label is quoted in bold in `help.md` and thus enters the `labels` map. CI fails via `pnpm help:check` if any index is stale.

### 16.3 The surface map discipline

`docs/reference/mcp-endpoint-mapping.md` is the authoritative correspondence between every REST endpoint, its MCP tool (or an explicit skip reason), MCP-only tools, the 11 `cli.ts` commands, and representative UI call sites - grouped by app then the cross-app platform surface, with a summary table (currently 971 REST endpoints, 718 with a tool, 16 MCP-only; last full survey 2026-06-17). The rule, restated in both the file header and `CLAUDE.md`, is that the map must be **complete, not merely accurate**: no bare ` - ` is allowed in the MCP column - it is either a backtick tool name or ` - _(skip: <reason>)_`. The self-check `grep -cE '^\| \`[^|]+\` \| - \|' docs/reference/mcp-endpoint-mapping.md` must print `0` (verified: it does). It is not yet CI-enforced, so keeping it honest is a manual discipline.

### 16.4 Migration headers

Every file in `infra/postgres/migrations/` opens with a comment block carrying the filename marker, a `-- Why:` line (motivation), and a `-- Client impact:` line (`none` / `additive only` / `expand-contract step N/M`), as seen in `0201_banter_feed.sql`. The migrate runner strips this leading `--` header before hashing the body, so header edits are free while any other byte change to an applied migration trips the checksum immutability guard. `pnpm lint:migrations` enforces filename, header, and idempotency conventions in CI.

### 16.5 The printable manual

`docs/docs-book-style-guide.md` is the design system for the downloadable manual (DOCX + PDF served from `/docs`), assembled by the `docs-book-author` skill via `scripts/docs-book/build-book.mjs`. The body text is the *exact* prose from each app's `help.md` (aggregated into `site/src/content/manual.generated.json`), so the book and website never drift; the book adds only an authored layer (per-chapter color openers, intros, pull-quotes, callouts, figure captions, and a "Check yourself" quiz, except the Introduction). DOCX is built with the `docx` library, PDF via headless LibreOffice; outputs are committed to `site/public/downloads/BigBlueBam-Manual.{docx,pdf}`. Hard rules: no em dashes, no invented facts/numbers/screenshots, readable body text.

### 16.6 CLAUDE.md as the agent operating manual and "keep it current"

`CLAUDE.md` is the agent-facing operating manual: it carries the architecture/route map, schema-and-migration rules, branch model, the surface-map mandate, and explicit behavioral rules (response style, never `docker compose down -v`, "pre-existing is not a dismissal," and the mandatory "How to see it in action" closing block). The unifying expectation across all of the above is **keep it current in the same change**: editing a REST endpoint, MCP tool, CLI command, or UI call site updates the surface map; changing help text reruns `pnpm help:index`; a schema change adds a new numbered migration with a proper header; help/website prose stays the manual's source. A stale doc is treated as worse than a missing one.

## 17. Deployment, Environments & Operations

BigBlueBam ships as a single Docker Compose stack and targets two production substrates today: **single-machine Docker Compose** (Tier 1) and **Railway** (managed cloud). A Kubernetes Helm chart is described in `docs/guides/deployment.md` but is explicitly marked planned/not-yet-authored, so treat any `infra/helm/` reference as aspirational.

### 17.1 The canonical stack: Docker Compose

The entire system runs from `docker-compose.yml` at the repo root. Infrastructure services (`postgres:16-alpine`, `redis:7-alpine`, `minio`, plus `qdrant` and `livekit`) carry named volumes and healthchecks; application services (`api`, the 14 per-app `*-api` services, `mcp-server`, `worker`, `helpdesk-api`, `frontend`, `voice-agent`) are stateless and scale horizontally. The shared `x-common` anchor sets `restart: unless-stopped` and log rotation (`max-size: 10m`, `max-file: 3`).

```bash
cp .env.example .env      # fill required secrets first
docker compose up -d      # full stack
docker compose -f docker-compose.yml -f docker-compose.dev.yml up   # dev, hot reload
```

All HTTP traffic enters through one nginx container (`frontend`) on port 80 (`HTTP_PORT`), which proxies `/b3/`, `/b3/api/`, every per-app mount, `/mcp/`, `/files/`, and the three WebSocket paths (`/b3/ws`, `/banter/ws`, `/helpdesk/ws`).

**The marketing site is the exception.** The `site` service (Vite app under `site/`, built by `infra/site/Dockerfile`, `serve -s dist` on `:3000`) is a real Compose service but is **not** fronted by the app nginx - `infra/nginx/nginx.conf` has no `site`/`:3000` route, and the service is attached only to the `frontend` network with no host port mapping in the committed file; its healthcheck probes `http://localhost:3000/` internally. It serves itself on its own port/domain (a separate Railway service in cloud). Because anything under `site/public/` (including `site/public/downloads/BigBlueBam-Manual.{pdf,docx}`) is baked into the image at build time, changes require `docker compose build site && docker compose up -d --force-recreate site` locally; on Railway it ships on push to `stable`.

> Note: `docs/guides/deployment.md` says "site (3000) - Marketing website (proxied at `/` by frontend)." That contradicts both `nginx.conf` and `CLAUDE.md`; the nginx config is authoritative - the site is not proxied.

### 17.2 Environments & the two-branch model

- **`main`** - bleeding-edge integration branch; features land here first.
- **`stable`** - production branch; the **default** for `./scripts/deploy.sh` and the branch operators normally deploy. Promotion is a `main`→`stable` merge once validated.

`./scripts/deploy.sh` (wrappers: `deploy.ps1`, `deploy.bat`) hands off to `scripts/deploy/main.mjs`, which prompts for platform (Docker Compose vs Railway) and branch, persists both in `.deploy-state.json`, and reuses them on later runs. Both platform adapters honor the branch choice: Compose uses it for `git fetch`/`git pull` on upgrade; Railway links every created service to it so Railway auto-rebuilds on new commits. Re-run with `--reconfigure` to change branch or settings, `--reset` to start fresh.

### 17.3 Required configuration

Required env vars (`.env`, copied from `.env.example`; Compose hard-fails on missing values via `${VAR:?}` interpolation): `POSTGRES_USER`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `SESSION_SECRET` (32+ chars, `openssl rand -hex 32`), `INTERNAL_HELPDESK_SECRET`, `INTERNAL_SERVICE_SECRET`, and `MCP_INTERNAL_API_TOKEN` (a `bbam_svc_` service-account token minted via `create-service-account`). Notable optional knobs: `PUBLIC_URL` (must be the address users actually reach the stack at - a stale `localhost` breaks deep-links), `COOKIE_SECURE`, `CORS_ORIGIN`, OAuth/SMTP/LiveKit/Qdrant credentials, and `BBB_RLS_ENFORCE`. The deploy script auto-generates secrets; a bare `docker compose up` requires setting them by hand.

### 17.4 Migrate-on-boot and the volume-safety rule

There is no `init.sql`; schema lives entirely in `infra/postgres/migrations/NNNN_*.sql`. The `migrate` service reuses the api image, runs `node dist/migrate.js`, and is a `service_completed_successfully` dependency of every DB-using service, so app containers never start against a stale schema. It bind-mounts `./infra/postgres/migrations:/app/migrations:ro` so new files are visible without a rebuild, and tracks applied files by SHA-256 in `schema_migrations` (immutable bodies; editing an applied file aborts with `CHECKSUM MISMATCH`).

Trap: the sidecar is cached by `service_completed_successfully` and will **not** re-run on a plain `up -d`. After adding a migration, run `docker compose run --rm migrate` explicitly. The deploy script forces a `--no-cache` api rebuild and an explicit migrate run on upgrade for exactly this reason.

**Never run `docker compose down -v`** unless deliberately wiping data - the `-v` flag deletes the `pgdata`, `redisdata`, `miniodata`, and `qdrantdata` volumes. Use `docker compose down` (no `-v`) to stop, and target individual services (`build <svc> && up -d --force-recreate <svc>`) to update.

### 17.5 Backups, RPO/RTO, monitoring

`docs/guides/operations.md` documents a `backup.sh` script: `pg_dump | gzip` of Postgres, a `tar` of the `miniodata` volume, and a Redis `BGSAVE` + `dump.rdb` copy, wired to a daily 2 AM cron. `docs/guides/deployment.md` states the backup/DR targets: daily logical `pg_dump` (30-day retention) plus continuous WAL archiving for point-in-time recovery (7-day window). These are stated targets/recipes, not an automated, running backup service in the committed stack - operators must install the cron themselves.

Health endpoints (via nginx on port 80): `GET /b3/api/health` (DB/Redis/MinIO), `/b3/api/health/live`, `/b3/api/health/ready`, `/mcp/health`, and per-app `/<app>/api/health`. A failing check flips status to `degraded` and returns 503, which drives container/pod restarts. Recommended (not bundled) monitoring stack: Sentry, Prometheus scraping `/metrics`, Grafana, Loki.

### 17.6 CI pipeline (actual)

`CLAUDE.md` and `deployment.md` describe one integrated pipeline; the real CI is six separate GitHub Actions workflows. On **every PR** all six run; on **push** the subset with branch filters runs:

| Workflow | File | Push branches |
|---|---|---|
| Lint (Biome + ESLint + migration header/idempotency check) | `lint.yml` | `main`, `stable` |
| Typecheck (`tsc --noEmit`, all packages) | `typecheck.yml` | `main`, `stable` |
| Test (Vitest, with Postgres 16 + Redis 7 service containers) | `test.yml` | PR only |
| DB Drift Guard (`db-check.mjs`, Drizzle ↔ SQL) | `db-drift.yml` | `main` |
| Migration Replay (apply all migrations on fresh Postgres) | `migration-replay.yml` | `main`, `recovery` |
| Seed Smoke (full seed orchestrator, asserts `failed: 0`) | `seed-smoke.yml` | PR (paths: `scripts/seed-*.mjs`) |

The "build images → push to GHCR → deploy to staging → tag `v*` promotes to prod" flow described in the docs is not represented by any committed workflow file; image build/deploy is driven by the deploy script and Railway's own auto-rebuild, not by GitHub Actions.

---

**How to see it in action**

- Bring up the stack: `docker compose up -d`, then `docker compose ps` (all `healthy`/`Up`) and `curl http://localhost/b3/api/health` → expect `{"status":...,"checks":{"database":"ok","redis":"ok","minio":"ok"}}`.
- Confirm migrations applied: `docker compose exec postgres psql -U bigbluebam -c "SELECT id, applied_at FROM schema_migrations ORDER BY id DESC LIMIT 5;"`.
- Confirm the site is unproxied: `curl -i http://localhost/` should hit the helpdesk redirect, **not** the marketing site; the site is only reachable on its own `:3000`/domain.
- Verify the CI claim yourself: list `.github/workflows/*.yml` (six files) - there is no GHCR/staging/promote workflow, matching §17.6.
- Verify branch wiring: `cat .deploy-state.json` after a `./scripts/deploy.sh` run shows the persisted `platform` and branch.

## 18. Testing & Quality Gates

BigBlueBam's verification surface is three test layers plus a set of structural drift guards, all gated behind a "CI must be green" merge rule. The dev guide's `docs/guides/development.md` "Testing Strategy" table describes the intended shape; several of its claims are aspirational, and the differences are called out below where they matter.

### 18.1 Test layers

**Unit tests (Vitest, per package/app).** Each workspace package declares its own `test` script (typically `vitest run`) and colocates `*.test.ts` files alongside source. `pnpm test` fans out via Turborepo (`turbo run test`), and CI runs the equivalent `pnpm -r --parallel --if-present test`. Run a single package with a filter, e.g. `pnpm --filter @bigbluebam/api test` or `pnpm --filter @bigbluebam/shared test`. Shared Zod schemas, services, route handlers, and frontend components are all exercised here; the dev guide's "~315 test files / 439 tests" figure is illustrative and not asserted by any guard.

**Cross-app integration harness (`apps/integration-tests`).** Package `@bigbluebam/integration-tests`, run with `vitest run`. As implemented today this is a single smoke test (`src/tests/cross-app-chain.smoke.test.ts`) that exercises the canonical Bam → Bond → Bolt → Beacon automation loop using **in-process mock service clients** (`src/fixtures/mock-service-clients.ts`) - no Docker Compose stack is required, contrary to the dev guide's "spin up a Docker Compose stack with real PostgreSQL and Redis" description. The file's own header notes it is "the scaffold Wave 4 CI work will extend by swapping the mock clients for real HTTP clients." Because its script is plain `vitest run`, it is picked up by the same recursive run as unit tests.

**End-to-end (`apps/e2e`, Playwright).** Package `@bigbluebam/e2e` with `playwright.config.ts` defining per-app projects (b3, banter, beacon, bearing, bench, bill, blank, blast, board, bolt, bond, book, brief, helpdesk) across ~66 `.spec.ts` files. These require a live stack, so the package's `test` script is a deliberate no-op that prints a redirect; run them at the repo root with `pnpm test:e2e` (→ `playwright test`), per-app via `pnpm test:e2e:b3`, or interactively with `pnpm test:e2e:ui`.

### 18.2 What CI runs, by trigger

CI lives in `.github/workflows/`. There are six workflows; **note that the CLAUDE.md "CI Pipeline" description overstates the deploy side** - there is no image-build/push or production-promotion workflow in this repo, and the bolt-catalog guard is not wired into CI at all (see §18.3).

| Trigger | Workflows that fire | What they do |
|---|---|---|
| **Every push** to `main`/`stable` and **every PR** | `lint.yml`, `typecheck.yml`, `test.yml`, `migration-replay.yml` | Biome/ESLint via `pnpm lint`; `tsc --noEmit` via `pnpm -r --parallel --if-present typecheck`; full Vitest run against Postgres 16 + Redis 7 service containers with migrations applied first; replay all migrations on a fresh Postgres and assert the applied count matches files on disk. |
| **PR**, plus push to `main` | `db-drift.yml` | Drizzle ↔ SQL drift (`pnpm db:check`), `SCHEMA_ROOTS` coverage regression, migration lint, and MCP tool-return-schema coverage. |
| **PR/push touching** `scripts/seed-*.mjs`, `infra/postgres/migrations/**`, or `docker-compose.yml` | `seed-smoke.yml` | Stands up throwaway Postgres, applies every migration, mints an admin/org, runs `scripts/seed-all.mjs`, and fails unless the run reports `failed: 0`. |

There is **no merge-triggered image build to GHCR and no tag-triggered (`v*`) production promotion**; deployment is driven out-of-band by `scripts/deploy.sh` (Docker Compose / Railway adapters), not by GitHub Actions. The Playwright e2e suite is **not** run in CI - `test.yml` explicitly defers it because it needs the full compose stack.

### 18.3 Structural drift guards

These catch divergence between declarations and ground truth:

- **DB drift** (`pnpm db:check` → `scripts/db-check.mjs`): parses every Drizzle `pgTable(...)` across the API services and diffs against the live DB; exits 1 on missing/extra tables or columns (type mismatches are warnings). CI-enforced by `db-drift.yml` and `migration-replay.yml`.
- **Migration lint** (`pnpm lint:migrations` → `scripts/lint-migrations.mjs`): enforces filename pattern, required `-- Why:` / `-- Client impact:` header, and idempotent DDL. CI-enforced in both `lint.yml` and the `migration-lint` job of `db-drift.yml`.
- **MCP tool-return coverage** (`scripts/check-tool-return-coverage.mjs`): asserts every tool registers via `registerTool()` with a returns schema. CI-enforced (`tool-return-coverage` job).
- **Permission-catalog and help-index drift** (`pnpm check:permission-catalog`, `pnpm help:check`): CI-enforced in `lint.yml`.
- **Bolt catalog drift** (`pnpm check:bolt-catalog` → `scripts/check-bolt-catalog.mjs`): exists and is runnable locally, but **is not invoked by any workflow** - CLAUDE.md's "CI drift guard that rejects source-prefixed event names" is currently a local-only check. Treat it as a manual pre-merge step until it is wired in.

### 18.4 The "CI must be green" gate

Every PR must pass all applicable workflows before merge, and the same gate applies to the `main` → `stable` promotion. Per repo convention, pre-existing red checks are not a license to merge: failures (including ones you did not introduce) must be fixed or explicitly tracked, never waved through as "pre-existing." A non-zero `tsc --noEmit`, a single failed seeder, or any drift-guard failure blocks the change.

---

Notable doc/code mismatches surfaced while grounding this section, in case they should be reconciled elsewhere:
- `docs/guides/development.md` and `CLAUDE.md` both describe a deploy-side CI pipeline (image build → GHCR → staging → tag-based prod promotion) that **does not exist** in `.github/workflows/`.
- CLAUDE.md calls `scripts/check-bolt-catalog.mjs` a CI drift guard; it is not referenced by any workflow.
- The dev guide describes the integration layer as Docker-Compose-backed with real Postgres/Redis; the actual `apps/integration-tests` harness is fully mocked and in-process.

```markdown
## 19. Roadmap & In-Flight Work

This section separates *what ships today* from *what is planned*. Everything in §19.2 and §19.3 is design or partial; none of it should be assumed live. The plan documents themselves live in `docs/plans/`.

### 19.1 The original design-doc roadmap (§26)

`docs/reference/BigBlueBam_Design_Document.md` §26 lays out the original 7-phase, ~30-week plan for the **Bam** core product: Phase 1 Foundation (monorepo, Docker stack, auth, org/user/project/task CRUD, drag-and-drop board), Phase 2 Sprint Engine (sprint lifecycle, carry-forward, list view), Phase 3 Collaboration & Realtime (WebSocket + Redis pubsub, presence, comments, attachments, activity log, notifications), Phase 4 MCP Server (tool registry, confirm_action flow, Resources/Prompts), Phase 5 Power Features (labels/epics/subtasks, custom fields, swimlanes, saved views, command palette, time tracking), Phase 6 Reporting & Integrations (burndown/velocity/CFD, email digests, GitHub/Slack, import/export, webhooks), Phase 7 Scale & Polish (a11y, virtualization, Gantt/calendar/My Work, Helm chart, HA validation). **Status: substantially shipped** — Phases 1–6 are reflected in live code, and the suite has expanded far beyond this single-product plan into 16+ apps. Two Phase 7 items remain open (see §19.3): the Kubernetes Helm chart at `infra/helm/bigbluebam/` does not exist, and Gantt/calendar views are partial.

### 19.2 New-product and feature design docs (not yet shipped)

- **Bay** (`BigBlueBam_Bay_Design_Document.md`, v0.1, *Status: Draft — Awaiting Approval*) — a media review/approval product (Frame.io/SyncSketch analog) with version stacks, frame/timecode/region annotation, per-reviewer decisions, and AI agents as first-class reviewers. Would own its own `bay-api` Fastify service. **Design only.**
- **Bin** (`Bin_Storage_Providers_Design_Document.md`, *Status: design — Wave 2 candidate*) — the DAM/storage substrate: a single config home for live-media and backup storage providers (org S3/MinIO/GCS or a novice "back up to Google Drive" wizard), scheduled reversible provider migration with write freeze, and backup cadence/retention policy. **Design only.**
- **Banter Feed** (`banter-feed-design-document.md`, *Status: DRAFT — awaiting review*) — a ranked, top-down cross-app stream *inside* Banter (no new app/port). Its architectural claim is that Feed and unified notifications are two renderings of one substrate; adds three `banter_`-prefixed tables, a worker fan-in job, and MCP tools, with read-time scoring. **Design only.**
- **Full-Suite Synchronous Editing** (`full-suite-synchronous-editing-plan.md`, *Status: Phase 1 (Brief repair) implemented same-day; later phases awaiting review*). Diagnosis: Brief's complete Yjs/Tiptap CRDT stack never connected because the client posts the room in the WS *path* (`/brief/ws/<docId>`, 404s) while the server reads it from the *query string* (`/brief/ws?doc=<id>`). **Partial** — Brief fix landed; extending live editing across the suite is unbuilt.
- **Configurable Elements** (`configurable-elements-plan.md`, *Status: Plan — not yet implemented*). Task priorities are a hardcoded compile-time enum (`PRIORITIES` in `packages/shared/src/constants/index.ts`) with no table/routes/UI, unlike phases/labels/custom-fields/epics; Part A makes them data-driven end-to-end, Part B sweeps every other Bam config surface lacking a UI. **Design only.**
- **Audit & Activity Viewer** (`audit-activity-viewer-plan.md`, *Status: Plan — not yet implemented*). The data and most endpoints exist (`v_activity_unified`, `GET /superuser/audit-log`) but there is no standalone SuperUser audit console, no human UI over the unified activity view, and no org-wide activity browser. **Design only.**
- **Bolt Advanced UI** (`bolt-advanced-ui-strategy.md`, *Status: Design exploration; no code changes proposed yet*). Follows the `bolt-mcp-deepdive` work (resolver tools, name-or-id acceptance, payload enrichment) that raised what a rule can express; this doc argues the five-section rule-builder UI hasn't caught up and scopes the next UI round. **Design only.**

### 19.3 In-flight execution and known open work

- **Frndo Phase 3** (`phase-3-workstreams.md`) — *active execution*, not a product design. 44 epics / 44 top-level tasks / 248 acceptance-criteria subtasks in the Bam `Frndo` project (prefix `FRNDO`, June 1–Oct 31, 2026), spanning voice-agent latency, capture accuracy, and TTS pacing work. Status/dates live in Bam, not the doc.
- **Remaining work** (`remaining-work-2026-04-16.md`, rev 2) — most rev-1 items closed; genuine open follow-ups: CI standardization on Linux; the **Kubernetes Helm chart** (`infra/helm/` does not exist, blocking honest Tier-4 deploy docs); Slack→Banter import; OAuth-provider admin UI; activity-log partitioning; and per-app gaps (Board clustering endpoint, Bearing PDF export, Bill time-entry-to-invoice wizard, Brief real embeddings/Tiptap mention data, Board MinIO thumbnails).
- **B3-FRNDO launch notes** (`B3-FRNDO_LAUNCH_NOTES.md`, uncommitted at repo root) — a raw field-feedback punch list, not a spec: invitation/password-reset email gaps, and a request to make subtask↔parent associations visible (parent/subtask fields, many-to-many dependencies, and blocking Done until subtasks are Done). **Untriaged backlog.**
```

## 20. Planned but Not Yet Implemented (Designed vs As-Built)

This section inventories the gap between what BigBlueBam's docs and specs describe and what the code actually does, as of this audit. Every row was confirmed against the repository (schema, routes, workers, compose, nginx), not just against the prose. Two patterns dominate: (a) ambitious *new-app* design docs in `docs/plans/` that have no corresponding `apps/` directory or schema yet, and (b) cross-cutting safety/realtime features that are coded but ship disabled-by-default or with the real logic stubbed. Note one inversion: the Banter Feed design doc reads as a forward-looking plan, but its schema (`0201_banter_feed.sql`), fan-in worker (`banter-feed-fanin.job.ts`), and UI (`feed.tsx`, `feed-settings.tsx`) all landed - so it is built, not pending; only the doc framing is stale.

| Capability | Status | What exists today | Specified in |
|---|---|---|---|
| **Bay** (media review/approval app) | Design-only | No `apps/bay-api`, no `bay_*` tables/routes/tools. Doc is a "Draft Design Document" with provisional ports. | `docs/plans/BigBlueBam_Bay_Design_Document.md` |
| **Bin** (storage providers / DAM) | Design-only | No `apps/bin-api`, no `packages/storage`, no `storage_providers`/`bin_assets`/`backup_policies` migrations. | `docs/plans/Bin_Storage_Providers_Design_Document.md` |
| **Backup / WAL archiving / PITR / Recovery Kit / keybundle** | Design-only | No recovery-kit/keybundle artifact, no `verify-integrity`/`restore` CLI, no WAL-archive config anywhere in the tree. | `Bin_Storage_Providers_Design_Document.md` |
| **Virus scanning of attachments** | Stub / placeholder | `attachments.scan_status` column exists (default `'pending'`, migration 0131); `signCleanDeepLink()` issues a presigned URL only when status is `'clean'` - but **nothing in the codebase ever writes `'clean'`**, and no ClamAV/scanner worker job exists. Federated `attachment_get`/`attachment_list` therefore return `deep_link: null` for every row. | `apps/api/src/services/attachment-meta.service.ts:41,134,263` |
| **Per-action permissions enforcement** | Partial / behind a flag | `packages/permissions` ships `off`/`warn`/`on` modes; compose default is `BBB_PERMISSIONS_ENFORCE=warn` (dual-read + divergence log; the legacy gate stays canonical). `'on'` is not the live posture. | `packages/permissions/src/index.ts:55-64`; `docker-compose.yml` (`:-warn`) |
| **Row-Level Security (RLS)** | Partial / behind a flag | Policies authored (migration 0116) and plugins wired, but bind only when `BBB_RLS_ENFORCE=1`. That var is **not set in `docker-compose.yml` or `.env.example`**, so the role stays BYPASSRLS by default. | `apps/api/src/boot/rls-boot.ts:24`; `apps/api/src/plugins/rls.ts:31` |
| **Brief synchronous editing (Yjs CRDT)** | Partial | Full CRDT stack is built (Y.Doc + awareness + Redis fan-out + debounced persistence in `apps/brief-api/src/ws/handler.ts`; client `use-collaboration.ts`). Plan: Phase 1 transport repair "implemented same-day; later phases awaiting review." | `docs/plans/full-suite-synchronous-editing-plan.md:4` |
| **Blueprint live multiplayer** | Partial | Only T1: every mutation broadcasts over `/blueprint/ws` and clients debounce-invalidate (Redis SUBSCRIBE relay). No Yjs, no cursor/selection presence ("viewport never crosses this wire"). T3 awareness is "next." | `full-suite-synchronous-editing-plan.md:94,125`; `apps/blueprint-api/src/routes/ws.routes.ts` |
| **`@bigbluebam/collab-client` shared package** | Design-only | No `packages/collab-client`; Phase 2 of the sync plan not started. | `full-suite-synchronous-editing-plan.md:136` |
| **Bench/Bond realtime co-editing** | Design-only | Bench T0 (silent LWW), Bond T1; no `/ws` or collab hooks in either SPA. | `full-suite-synchronous-editing-plan.md:100,130` |
| **Voice agent (STT→LLM→TTS)** | Partial / degrades | Real FastAPI service with LiveKit pipeline code, but every path "gracefully degrades when provider API keys or the LiveKit SDK are not available"; default deploy ships no keys, so agents run "log-only / degraded." | `apps/voice-agent/src/api.py`, `pipeline.py`; CLAUDE.md ("placeholder") |
| **Configurable task priorities + Part-B config surfaces** | Design-only | Priorities remain a hardcoded enum: per the plan, "it does not exist on the API … no table, no routes." | `docs/plans/configurable-elements-plan.md:8` |
| **`banter_search_transcripts` MCP tool** | Stub | Documented as "placeholder - returns available transcripts." | `docs/reference/mcp-server.md:302` |
| **Helm chart (k8s deploy tier)** | Design-only | `infra/helm/` does not exist; the Dockerfile `COPY` of migrations is the only k8s-oriented fallback. | `docs/plans/remaining-work-2026-04-16.md` |
| **Bolt advanced control-flow nodes** | Design-only | "Design exploration. No code changes proposed yet." Form + graph builders exist, but branch/for-each/try-catch/delay nodes do not. | `docs/plans/bolt-advanced-ui-strategy.md` |

**New apps (Bay & Bin).** Both are complete new-service proposals - own API, schema, tables, nginx routes - with zero implementing code: no `apps/bay-api`, `apps/bin-api`, `packages/storage`, or any `bay_*`/`bin_*`/`storage_*` migration. Treat the entire Bin storage/backup/PITR/Recovery-Kit story as design-only; it is also the doc that introduces the AV-worker concept the suite never built.

**Synchronous editing.** The most nuanced area. Board is genuinely live (cursors + scene reconcile). Brief has a complete Yjs CRDT engine that was transport-broken and repaired in "Phase 1," but the cross-suite generalization (the `collab-client` package, 409 stale-guards, Blueprint/Bond awareness, Beacon co-editing) is unbuilt. Blueprint's `/blueprint/ws` is a mutation-event relay, not CRDT co-editing, and deliberately omits cursors and viewport. "Live multiplayer everywhere" is partial, not done.

**Virus scanning.** The sharpest spec-vs-reality gap, with a security flavor: the `scan_status='clean'` gate is enforced in code, attachments insert as `'pending'`, and nothing ever promotes them - so the federated attachment MCP surface withholds deep links universally while no actual scanning happens. The column is decorative until a scanner is wired.

**Enforcement posture (permissions + RLS).** Both the per-action permissions resolver and PostgreSQL RLS are coded but not authoritative by default: permissions run in `warn` (observe-and-log) and RLS stays in BYPASS because `BBB_RLS_ENFORCE` is unset across compose and `.env.example`. A reader should not assume either gates production traffic today.

## 21. Documentation Map - What Exists and What Is Missing

This section inventories the written documentation as it actually stands in the repository, so a reader knows which document to trust for a given question, how current it is, and where there is simply nothing written yet. Every path below is relative to the repo root and was verified against the tree; line counts are exact at time of writing and stand in for "altitude" (how much ground a doc covers).

### 20.1 The corpus at a glance

Documentation lives in three places: a handful of top-level `*.md` files, the `docs/` tree (organized into `reference/`, `guides/`, `apps/`, `plans/`, plus loose notes and `deploy/`/`history/`), and `CLAUDE.md`. `docs/README.md` (77 lines) is the directory's own self-description and the closest thing to a table of contents.

#### Reference (evergreen specs - `docs/reference/`)

| Path | Lines | Authoritatively covers | Known staleness |
|---|---|---|---|
| `BigBlueBam_Design_Document.md` | 2878 | The original Bam (Kanban/sprint) data model, API contracts, animation specs, UI layouts; phases 1-7 plan in §26 | **Bam-era.** Predates the 16-app suite: zero "suite"/"sixteen" framing, no Banter/Bond/Beacon/etc. sections (last numbered section is §25 Billing). Still cited as authoritative by `CLAUDE.md`. |
| `BigBlueBam_Design_Document_v1_Addendum.md` | 420 | Post-v1 additions §28-§36 (imports, multi-org, PWA, security, §36 Pervasive Presence) | Confusingly titled "v2 Addendum" internally; still Bam-centric, suite apps not modeled here either. |
| `architecture.md` | 682 | System topology, the nginx/compose service graph, data services, scaling posture | Current; mermaid graph enumerates the multi-SPA layout. |
| `api-reference.md` | 1951 | REST contracts; self-flags the `/v1`-prefix inconsistency on `/auth/*`, `/superuser/*`, `/helpdesk/*` | Mostly current; notes its own known gap. |
| `database.md` | 815 | PostgreSQL schema, ERD, RLS, partitioning, FTS | Current at the level it covers; not exhaustive over all 16 apps' schemas. |
| `mcp-server.md` | 965 | MCP transport model, what MCP is, per-module tool listing | **Stale counts:** claims "340 tools across 43 modules" vs. `CLAUDE.md`'s 733 across 46; **omits Bureau** entirely. |
| `mcp-endpoint-mapping.md` | 1770 | The canonical REST↔MCP↔CLI↔UI surface map; self-checked, "no bare ` - `" rule | Best-maintained large doc; last full survey dated 2026-06-17 in-file. |
| `agent-conventions.md` | 168 | The `can_access` preflight contract, entity vocabulary, HITL rules for agent runners | Points to `AGENTIC_TODO.md` for context - **that file does not exist in the repo** (dangling ref, also dangling from `mcp-server.md`, `apps/bam/*`, `CLAUDE.md`). |
| `permissions.md` | 522 | Role hierarchy (SuperUser→Org→Project), enforcement | Current. |
| `cli.md` | 225 | The 11 `apps/api/src/cli.ts` break-glass commands | Current. |

#### Guides (how-to - `docs/guides/`)

`getting-started.md` (636), `development.md` (734), `deployment.md` (882), `operations.md` (476), `railway-runbook.md` (339), `seeding-smoke-test.md` (53). Operator- and developer-facing; deployment/operations pair with the Railway notes under `deploy/`.

#### Per-app (`docs/apps/<app>/`)

One folder per app for all sixteen apps **plus** `introduction/` and `helpdesk/` (18 folders total), each with the same six files: `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md`. `help.md` is the source consumed by the in-app Help Center; `introduction/_narrative.md` is the only doc that opens with the full "sixteen applications that behave like one product" framing.

#### Plans (in-flight - `docs/plans/`)

Nine files including unshipped designs: `BigBlueBam_Bay_Design_Document.md` (635, an as-yet-unbuilt app), `Bin_Storage_Providers_Design_Document.md` (1293), `bolt-advanced-ui-strategy.md` (1107), `banter-feed-design-document.md` (518), `full-suite-synchronous-editing-plan.md` (207), and dated remnants (`remaining-work-2026-04-16.md`). Per `docs/README.md`, shipped plans are deleted, so presence here implies "not done."

#### Notes & top-level

Loose notes: `livekit-networking-notes.md` (208), `marketing-voice.md` (383), `docs-book-style-guide.md` (202), `banter-feed-notes.md`, `help-system-notes.md`, `permissions-notes.md`, `docs-refresh-findings.md` (47, a self-audit of doc staleness). Top-level: `README.md` (795), `CLAUDE.md` (423, agent instructions), `AGENT_DEVELOPMENT.md` (572), and the transient `B3-FRNDO_LAUNCH_NOTES.md` (14).

### 20.2 Gaps & overlaps

- **No prior single overview.** Before this document, nothing read top-to-bottom as a whole-system narrative; the design doc, `architecture.md`, and `CLAUDE.md` each cover a slice.
- **The Design Document predates the suite.** It and its addendum describe Bam alone; the other fifteen apps have no equivalent authoritative spec - only per-app `guide.md`/`help.md` and scattered `plans/` files.
- **`CLAUDE.md` is instruction-shaped, not narrative.** It is the densest accurate inventory (service map, tool counts, migration rules) but written as imperative rules for an agent, not as explanation.
- **Tool/module counts diverge.** `mcp-server.md` (340/43, no Bureau) lags `CLAUDE.md` (733/46); trust the mapping doc and the catalog code, not `mcp-server.md`, for current numbers.
- **Dangling `AGENTIC_TODO.md`.** Five files cite it as the source of agentic-platform context; it is absent, so that context lives only in `CLAUDE.md`'s agentic-capabilities bullets and the migrations themselves.
- **Overlapping deploy guidance** across `guides/deployment.md`, `guides/railway-runbook.md`, and `deploy/railway-var-decisions.md` with no single owner of the canonical sequence.

## 22. Bibliography - Referenced & Further Reading

This section enumerates every Markdown document under `docs/` plus the top-level `*.md` files in the repo root. It is exhaustive against a recursive `find docs -name '*.md'` and `find . -maxdepth 1 -name '*.md'` (node_modules and the `agents/` runner specs are excluded; the latter are agent-runner definitions, not platform documentation). Paths are repo-relative.

One stale note up front: `AGENT_DEVELOPMENT.md` declares itself "working draft, not committed (see `.gitignore`)" yet it is tracked in the repo - treat the self-description as out of date, not the file as absent.

### Top-level (repo root)

- `README.md` - Project landing page (logo banner, suite overview, quickstart). Start here for the one-paragraph pitch and the first `docker compose up` path before diving into `docs/`.
- `CLAUDE.md` - Canonical engineering conventions and operational guardrails: monorepo layout, migration immutability rules, branch model, response/style rules, MCP/surface-map upkeep, and the "how to see it in action" requirement. Consult before making any change; it overrides default behavior.
- `AGENT_DEVELOPMENT.md` - Guide for engineers designing AI agents that operate inside the suite. Companion to `CLAUDE.md` and the design document; read when building agent runners or reasoning about agent-facing surfaces. (Self-labeled a draft; actually committed.)
- `B3-FRNDO_LAUNCH_NOTES.md` - Punch-list of pre-launch defects and gaps captured for the "Frndo" launch (user-management/invitation/password-reset issues and more). Consult for current launch-blocking bugs; it is a working notes file, not a spec.

### Reference (`docs/reference/`) - evergreen specs and contracts

- `docs/reference/BigBlueBam_Design_Document.md` - The authoritative v1.0 design spec (Big Blue Ceiling Prototyping & Fabrication, LLC; dated April 2, 2026): data models, API contracts, MCP tool schemas, animation specs, UI layouts, and the 7-phase plan. The single source of truth for intended design; consult for any "what was this supposed to do" question.
- `docs/reference/BigBlueBam_Design_Document_v1_Addendum.md` - Post-v1 "v2 Addendum" capturing features identified via gap analysis against Linear/Jira/Asana. Read alongside the main design document for anything added after v1.0.
- `docs/reference/architecture.md` - System architecture overview: stateless application services vs. stateful data services, Docker-native monorepo separation, scaling posture. Consult for the high-level component map.
- `docs/reference/api-reference.md` - Complete REST API reference (request/response shapes per endpoint). Pairs with `permissions.md` for who may call each endpoint; consult when integrating against or changing the HTTP surface.
- `docs/reference/database.md` - PostgreSQL 16 data layer: RLS, JSONB custom fields, monthly-partitioned activity logs, `pg_trgm`/`tsvector` full-text search. Consult for schema/storage mechanics.
- `docs/reference/mcp-server.md` - MCP server documentation with a module-by-module tool listing. Note a count discrepancy: this doc states "340 tools across 43 modules," while `CLAUDE.md` states 733 tools across 46 modules - the doc's totals are stale relative to `CLAUDE.md`; trust the live catalog (`apps/mcp-server/`) over either when it matters.
- `docs/reference/mcp-endpoint-mapping.md` - Authoritative REST ↔ MCP ↔ CLI ↔ UI surface map, grouped by app and platform surface, with a coverage summary. Must be updated in the same change as any endpoint/tool/CLI/UI-call-site change; consult to find the tool backing an endpoint (or why none exists).
- `docs/reference/permissions.md` - Permission/authorization model: role hierarchy, rank rules, cross-org rules, and enforcement across Bam, Banter, and Helpdesk. Consult for "who can do X."
- `docs/reference/cli.md` - Reference for the B3 CLI (`apps/api/src/cli.ts`) that runs inside the `api` container: bootstrap, operator identity, service-account minting, access recovery. Consult for `docker compose exec api node dist/cli.js ...` commands.
- `docs/reference/agent-conventions.md` - Living (Wave 2) conventions for agent runners talking to the MCP server: visibility preflight (`can_access`), `asker_user_id` selection, HITL routing, mention syntax. Consult when writing any cross-app agent behavior.

### Guides (`docs/guides/`) - how-to and operations

- `docs/guides/getting-started.md` - Fresh-clone-to-running walkthrough. The first hands-on guide for a new contributor.
- `docs/guides/development.md` - Contributor guide: environment setup and code-style conventions. Consult before writing code.
- `docs/guides/deployment.md` - Deployment guide covering Tier 1 (single-machine Docker Compose) and Railway (automated managed cloud), with scaling notes; Tier 4 Kubernetes/Helm is planned, not authored. Read top-to-bottom on a first deploy.
- `docs/guides/operations.md` - Production operations: updates without data loss, backups, routine maintenance. Consult for day-2 ops.
- `docs/guides/railway-runbook.md` - Operator runbook for the Railway deploy orchestrator (`scripts/deploy/platforms/railway.mjs`). Consult when standing up or troubleshooting Railway.
- `docs/guides/seeding-smoke-test.md` - 14-URL click-through checklist to verify demo seed data is visible across surfaces after `seed-all.mjs`. Run after seeding to confirm coverage.

### Per-app help, guide, marketing, and tool docs (`docs/apps/<app>/`)

Each of the 17 app directories - `bam`, `banter`, `beacon`, `bearing`, `bench`, `bill`, `blank`, `blast`, `blueprint`, `board`, `bolt`, `bond`, `book`, `brief`, `bureau`, `helpdesk`, and the suite-level `introduction` - contains the same six files with identical roles. To avoid repeating 102 near-identical lines, the file roles are defined once and then every file is listed.

#### File roles (per app `<app>`)

- `docs/apps/<app>/help.md` - In-app Help Center source: TOC, task-oriented how-tos, and the canonical "(?)" help content surfaced inside the app's top bar. Consult/edit when changing the in-app help for that app.
- `docs/apps/<app>/guide.md` - Generated long-form user guide (YAML front matter with `app` and `generated` timestamp). Consult for the comprehensive end-user walkthrough; it is built from the same content as the web docs.
- `docs/apps/<app>/marketing.md` - Generated marketing-page copy for the app (front-mattered). Consult when editing the marketing site's per-app section.
- `docs/apps/<app>/mcp-tools.md` - Table of the app's MCP tools (Tool / Description / Parameters). Consult for the per-app agent tool surface.
- `docs/apps/<app>/_narrative.md` - Source narrative blurb describing what the app is and who it is for; an input that feeds the guide/marketing generation. Consult for the canonical short description.
- `docs/apps/<app>/_marketing_hook.md` - Short marketing hook (headline + bullet selling points) used as a generation input. Consult for the app's one-liner positioning.

#### Full file list (all six roles per app)

- `docs/apps/bam/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (flagship sprint-based Kanban project/task management).
- `docs/apps/banter/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (team messaging / feed).
- `docs/apps/beacon/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (knowledge base, search, graph).
- `docs/apps/bearing/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (goals / OKRs).
- `docs/apps/bench/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (analytics dashboards / reports).
- `docs/apps/bill/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (invoicing / expenses / billing).
- `docs/apps/blank/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (forms / submissions).
- `docs/apps/blast/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (email campaigns).
- `docs/apps/blueprint/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (structured diagrams / typed graph).
- `docs/apps/board/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (whiteboard / infinite canvas / conferencing).
- `docs/apps/bolt/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (workflow automation engine).
- `docs/apps/bond/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (CRM: contacts/companies/deals/pipeline).
- `docs/apps/book/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (scheduling / public booking pages).
- `docs/apps/brief/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (collaborative document editor).
- `docs/apps/bureau/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (virtual office / pervasive presence layer).
- `docs/apps/helpdesk/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (support portal / tickets).
- `docs/apps/introduction/` - `_marketing_hook.md`, `_narrative.md`, `guide.md`, `help.md`, `marketing.md`, `mcp-tools.md` (suite-level introduction, not a single app; the umbrella overview that the in-app help and marketing surfaces use as their entry point).

### Plans (`docs/plans/`) - designs and in-flight/future work

- `docs/plans/BigBlueBam_Bay_Design_Document.md` - Product proposal for "Bay." Carries an explicit AGENTS guard comment instructing tools not to delete/move/modify it; treat as an intentional future-consideration spec, not stray output.
- `docs/plans/Bin_Storage_Providers_Design_Document.md` - Design (Wave 2 candidate) for "Bin": storage substrate, backup engine, and provider-migration flow. Consult when building storage providers or backups.
- `docs/plans/audit-activity-viewer-plan.md` - HIGH-priority plan spec (written 2026-06-10) for an audit/activity viewer, scheduled after Bam CSV import lands.
- `docs/plans/banter-feed-design-document.md` - DRAFT design (2026-06-18) for the Banter feed, proposed branch `banter-feed`. Pairs with `docs/banter-feed-notes.md`.
- `docs/plans/bolt-advanced-ui-strategy.md` - Design exploration for Bolt's advanced UI; intended to drive the next round of Bolt UI work (no code proposed yet).
- `docs/plans/configurable-elements-plan.md` - Plan for Bam configurable elements (priorities + exposing existing config); implementation to branch off `main` after CSV import lands.
- `docs/plans/full-suite-synchronous-editing-plan.md` - Plan (2026-06-12) for suite-wide synchronous/collaborative editing; Phase 1 (Brief repair) implemented same-day, later phases pending review.
- `docs/plans/phase-3-workstreams.md` - Frndo Phase 3 (Jun 1 → Oct 31, 2026) workstreams, scheduled as the 44 top-level epics/user-story tasks in the Bam `Frndo` project. Consult for Phase 3 scope and scheduling.
- `docs/plans/remaining-work-2026-04-16.md` - Remaining-work tracker (rev 2) after the P0/P1/P2 + deferrals passes; lists genuine follow-ups and infra items still open.

### Notes (`docs/` root, `docs/deploy/`, `docs/history/`) - living notes, decisions, and dated audits

- `docs/README.md` - Index/intent statement for the `docs/` directory: what it holds (evergreen specs, guides, per-app help inputs, in-flight plans/notes) and what it deliberately omits (completed plans, dated audits live in git history).
- `docs/banter-feed-notes.md` - Implementation notes and sharp edges for the Banter feed; companion to the feed design document, recording decisions, deferrals, and gotchas.
- `docs/deploy/railway-var-decisions.md` - Code-verified record of every variable the Railway deploy sets, decided against the actual consuming code (written after a 2026-06-12 incident from an assumed `LIVEKIT_WS_URL` value). Consult before changing deploy-time env values.
- `docs/docs-book-style-guide.md` - Design system / style guide for the printable downloadable manual (DOCX/PDF offered from `/docs`). Consult when authoring or extending the book.
- `docs/docs-refresh-findings.md` - Findings (2026-06-17) from re-authoring `docs/apps/*` from code across all 16 apps: a batch of pre-existing code defects and stale catalog counts surfaced by the help-doc writers.
- `docs/help-system-notes.md` - Notes and sharp edges for the unified in-app help system ("(?)" Help Center + right-click "Help: <element>"). Authoritative standard lives in the `suite-help-system` skill; this records the landmines.
- `docs/livekit-networking-notes.md` - Operator + engineer notes for the calling stack (Bureau/Banter/Board on the shared LiveKit SFU): what is auto-detected, how calls connect, what the Log reports. Consult after any network change to the calling stack.
- `docs/marketing-voice.md` - House style/voice guide for the marketing site under `site/`. Read before writing or editing marketing copy.
- `docs/permissions-notes.md` - Living notes for the Wave E permission-matrix rollout: deliberately-deferred permission landmines. Add to it whenever a permission issue is found but not fixed in-pass.
- `docs/history/2026-04-15-seeding/seeding-recovery-plan.md` - Dated (approved 2026-04-15) plan to wipe the postgres volume and restore the dev stack; its second half is the authoritative seeding-gap analysis and human-tester checklist that shaped the current seed set.
