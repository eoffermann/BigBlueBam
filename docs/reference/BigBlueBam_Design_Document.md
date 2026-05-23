# BigBlueBam — Project Planning Tool

## Design Document v1.0

**Author:** Big Blue Ceiling Prototyping & Fabrication, LLC
**Date:** April 2, 2026
**Status:** Draft

---

## 1. Executive Summary

BigBlueBam is a web-based, multi-user project planning tool built on a Kanban-inspired workflow with sprint-based task management. It supports multiple concurrent projects, each with arbitrarily configurable phases (columns), per-sprint task scoping, and full carry-forward mechanics for incomplete work. The UI is built with React and Motion (formerly Framer Motion) to deliver a tactile, responsive, and visually lively experience — drag interactions feel physical, transitions are smooth, and state changes are animated with purpose.

BigBlueBam differentiates itself from commodity tools by treating **configurability as a first-class citizen**: task states, phase definitions, sprint cadences, role permissions, and card field schemas are all user-defined per-project, not hard-coded. The system is designed for small-to-medium teams (2–50 users) managing multiple concurrent projects with varying methodologies.

---

## 2. Guiding Principles

1. **Motion with meaning.** Every animation communicates state change. Drag-and-drop feels weighted. Cards settle into place. Nothing moves without a reason.
2. **Configuration over convention.** Projects define their own phases, states, fields, and cadences. No baked-in assumptions about workflow.
3. **Sprints are containers, not cages.** Tasks live in sprints for planning purposes but can be freely carried forward, deferred, or re-scoped without friction.
4. **Real-time by default.** Multi-user edits, card moves, and status changes propagate instantly across all connected clients.
5. **Keyboard-first, mouse-friendly.** Every action is reachable via keyboard shortcuts. Drag-and-drop is the delightful layer on top.

---

## 3. Core Concepts & Glossary

| Term | Definition |
|---|---|
| **Organization** | Top-level tenant. Owns users, projects, and billing. Maps to a company or team. |
| **Project** | A discrete body of work with its own board, phases, sprints, and configuration. |
| **Phase** | A named column on the board representing a workflow stage (e.g., "Backlog", "In Progress", "QA", "Done"). Fully configurable per project. |
| **Sprint** | A time-boxed iteration within a project. Tasks are scoped to sprints. Sprints have start/end dates, goals, and velocity tracking. |
| **Task** | The atomic unit of work. Represented as a "sticky" card on the board. Contains all tracking metadata. |
| **Task State** | A configurable status label (e.g., "Not Started", "Blocked", "In Review"). Orthogonal to phase — a task in the "In Progress" phase might have a state of "Blocked". |
| **Subtask** | A child task nested under a parent. Inherits project/sprint context. Has its own state and assignee. |
| **Label** | A color-coded tag for cross-cutting categorization (e.g., "Bug", "Feature", "Tech Debt", "UX"). |
| **Epic** | An optional grouping of related tasks that may span multiple sprints. |
| **Swimlane** | An optional horizontal grouping on the board (by assignee, epic, label, priority, or custom field). |
| **Carry-Forward** | The action of moving an incomplete task from a closing sprint into the next (or a future) sprint. |
| **Role** | A named permission set within an organization or project (e.g., "Admin", "Member", "Viewer"). |

---

## 4. Architecture Overview

### 4.1 High-Level Stack

```
┌─────────────────────────────────────────────────────────────┐
│                   Client (SPA)                               │
│  React 19 · Motion · TanStack Query · Zustand               │
│  TailwindCSS · Radix Primitives · dnd-kit                   │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTPS / WSS
┌──────────────────────▼──────────────────────────────────────┐
│              Docker Container: frontend (nginx)              │
│              Reverse proxy + static SPA assets               │
└──────────┬───────────────────────┬──────────────────────────┘
           │ REST / WS             │
┌──────────▼──────────┐  ┌────────▼─────────────┐  ┌────────────────────┐
│ Container: api      │  │ Container: worker    │  │ Container:         │
│ Fastify REST +      │  │ BullMQ background    │  │ mcp-server         │
│ WebSocket server    │  │ job processor        │  │ MCP SDK            │
│ :4000               │  │ (no exposed port)    │  │ SSE + Streamable   │
└──────────┬──────────┘  └────────┬─────────────┘  │ HTTP :3001         │
           │                      │                 └────────┬───────────┘
┌──────────▼──────────────────────▼──────────────────────────▼───────────┐
│                    Internal Docker Network                              │
└──────────┬──────────────────────┬──────────────────────────┬───────────┘
           │                      │                          │
┌──────────▼───────┐  ┌──────────▼───────┐  ┌───────────────▼───────────┐
│ Container:       │  │ Container:       │  │ Container:                │
│ postgres         │  │ redis            │  │ minio                     │
│ PostgreSQL 16    │  │ Redis 7          │  │ S3-compatible storage     │
│ :5432            │  │ :6379            │  │ :9000                     │
│ Vol: pgdata      │  │ Vol: redisdata   │  │ Vol: miniodata            │
└──────────────────┘  └──────────────────┘  └───────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   MCP Clients                                │
│  Claude Desktop · Claude Code · Custom AI Agents · IDEs     │
│  Connect via SSE/Streamable HTTP to mcp-server :3001        │
└─────────────────────────────────────────────────────────────┘
```

**Deployment model:** The entire stack runs in a single `docker compose up`. Each box above is a container. Data services (PostgreSQL, Redis, MinIO) can be swapped for managed cloud equivalents by changing environment variables — no code changes. Application containers (api, mcp-server, worker, frontend) scale horizontally behind a load balancer. See Section 20 for the full scaling path.

### 4.2 Client Architecture

| Layer | Technology | Rationale |
|---|---|---|
| **Framework** | React 19 | Server components, concurrent rendering, transitions API |
| **Animation** | Motion (v11+) | Layout animations, drag gestures, shared layout transitions, spring physics |
| **State (client)** | Zustand | Lightweight, no boilerplate, supports slices and middleware |
| **State (server)** | TanStack Query v5 | Cache invalidation, optimistic updates, background refetching |
| **Drag & Drop** | dnd-kit | Accessible, composable, supports sortable lists and multi-container DnD |
| **Styling** | TailwindCSS v4 + Radix Colors | Utility-first, design token support, accessible color palettes |
| **UI Primitives** | Radix UI | Unstyled, accessible components (dialogs, dropdowns, tooltips, popovers) |
| **Routing** | TanStack Router or React Router v7 | Type-safe routing, nested layouts, loader patterns |
| **Forms** | React Hook Form + Zod | Performant forms, schema-based validation shared with API |
| **Date/Time** | date-fns v3 or Temporal (if available) | Immutable, tree-shakeable date utilities |
| **Rich Text** | Tiptap (ProseMirror) | Extensible, collaborative-ready rich text for task descriptions |
| **Charts** | Recharts or Victory | Sprint velocity, burndown, cumulative flow diagrams |

### 4.3 API Architecture

| Layer | Technology | Rationale |
|---|---|---|
| **Runtime** | Node.js 22 LTS | Ecosystem, hiring pool, TypeScript native support |
| **Framework** | Fastify v5 | High performance, schema-based validation, plugin architecture |
| **API Style** | REST with optional GraphQL gateway | REST for CRUD, GraphQL for complex dashboard queries |
| **Validation** | Zod (shared with client) | Single source of truth for request/response schemas |
| **Auth** | Lucia Auth or Auth.js v5 | Session-based with OAuth2 providers, RBAC middleware |
| **ORM** | Drizzle ORM | Type-safe, SQL-first, excellent migration tooling |
| **Realtime** | Socket.IO or native WebSocket with Redis PubSub | Room-based broadcasting per project board |
| **Queue** | BullMQ (Redis-backed) | Background jobs: email, notifications, sprint auto-close, analytics rollups |
| **Search** | PostgreSQL full-text search (pg_trgm + tsvector) | Avoids external dependency; upgrade path to Meilisearch if needed |

### 4.4 Data Layer

| Component | Technology | Configuration |
|---|---|---|
| **Primary DB** | PostgreSQL 16 | Row-level security, JSONB for custom fields, partitioning for activity logs |
| **Cache** | Redis 7 (Valkey) | Session store, rate limiting, pubsub backbone, ephemeral board state |
| **Object Storage** | S3 / R2 / MinIO | Attachments, avatars, exports. Presigned URLs for direct upload. |
| **CDN** | Cloudflare | Static assets, image transforms for avatars/thumbnails |

---

## 5. Data Model

### 5.1 Entity-Relationship Summary

```
Organization ──< Project ──< Phase
                    │  ──< Sprint ──< SprintTask (join)
                    │                      │
                    └──< Task ─────────────┘
                          │  ──< Subtask
                          │  ──< Comment
                          │  ──< Attachment
                          │  ──< ActivityLog
                          │  ──< TaskCustomFieldValue
                          │
Organization ──< User ──< ProjectMembership ──> Project
                    │
                    └──< Role
```

### 5.2 Core Tables

#### `organizations`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `name` | VARCHAR(255) | NOT NULL | Display name |
| `slug` | VARCHAR(100) | UNIQUE, NOT NULL | URL-safe identifier |
| `logo_url` | TEXT | NULLABLE | S3 path |
| `plan` | VARCHAR(50) | DEFAULT 'free' | Billing tier |
| `settings` | JSONB | DEFAULT '{}' | Org-wide defaults (timezone, date format, etc.) |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT now() | Auto-updated via trigger |

#### `users`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `org_id` | UUID | FK → organizations.id | |
| `email` | VARCHAR(320) | UNIQUE, NOT NULL | RFC 5321 max length |
| `display_name` | VARCHAR(100) | NOT NULL | |
| `avatar_url` | TEXT | NULLABLE | |
| `role` | VARCHAR(50) | DEFAULT 'member' | Org-level role: owner, admin, member |
| `timezone` | VARCHAR(50) | DEFAULT 'UTC' | IANA timezone |
| `notification_prefs` | JSONB | DEFAULT '{}' | Per-channel preferences |
| `is_active` | BOOLEAN | DEFAULT true | Soft-disable |
| `last_seen_at` | TIMESTAMPTZ | NULLABLE | Presence tracking |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT now() | |

#### `projects`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `org_id` | UUID | FK → organizations.id | |
| `name` | VARCHAR(255) | NOT NULL | |
| `slug` | VARCHAR(100) | NOT NULL | Unique within org |
| `description` | TEXT | NULLABLE | Markdown |
| `icon` | VARCHAR(10) | NULLABLE | Emoji or icon identifier |
| `color` | VARCHAR(7) | NULLABLE | Hex color for sidebar/headers |
| `default_sprint_duration_days` | INT | DEFAULT 14 | |
| `task_id_prefix` | VARCHAR(10) | NOT NULL | e.g., "BBB", "FRND" — used for human-readable task IDs |
| `task_id_sequence` | INT | DEFAULT 0 | Auto-incrementing per project |
| `settings` | JSONB | DEFAULT '{}' | Project-specific config blob |
| `is_archived` | BOOLEAN | DEFAULT false | |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique constraint:** `(org_id, slug)`

#### `project_memberships`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `project_id` | UUID | FK → projects.id | |
| `user_id` | UUID | FK → users.id | |
| `role` | VARCHAR(50) | DEFAULT 'member' | Project-level: admin, member, viewer |
| `joined_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique constraint:** `(project_id, user_id)`

#### `phases`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `project_id` | UUID | FK → projects.id | |
| `name` | VARCHAR(100) | NOT NULL | e.g., "Backlog", "In Progress" |
| `description` | TEXT | NULLABLE | |
| `color` | VARCHAR(7) | NULLABLE | Column header color |
| `position` | INT | NOT NULL | Sort order (0-indexed) |
| `wip_limit` | INT | NULLABLE | Max tasks allowed in this phase (null = unlimited) |
| `is_start` | BOOLEAN | DEFAULT false | Tasks enter here by default |
| `is_terminal` | BOOLEAN | DEFAULT false | Tasks here are considered "done" |
| `auto_state_on_enter` | UUID | FK → task_states.id, NULLABLE | Automatically set task state when entering this phase |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

**Unique constraint:** `(project_id, position)`

#### `task_states`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `project_id` | UUID | FK → projects.id | |
| `name` | VARCHAR(100) | NOT NULL | e.g., "Not Started", "In Progress", "Blocked", "Done" |
| `color` | VARCHAR(7) | NOT NULL | Badge color |
| `icon` | VARCHAR(10) | NULLABLE | Emoji or icon |
| `category` | VARCHAR(20) | NOT NULL | One of: 'todo', 'active', 'blocked', 'review', 'done', 'cancelled' — used for reporting |
| `position` | INT | NOT NULL | Sort order in dropdowns/filters |
| `is_default` | BOOLEAN | DEFAULT false | Assigned to new tasks |
| `is_closed` | BOOLEAN | DEFAULT false | Treated as resolved for metrics |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

#### `sprints`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `project_id` | UUID | FK → projects.id | |
| `name` | VARCHAR(100) | NOT NULL | e.g., "Sprint 12" or custom name |
| `goal` | TEXT | NULLABLE | Sprint goal statement |
| `start_date` | DATE | NOT NULL | |
| `end_date` | DATE | NOT NULL | |
| `status` | VARCHAR(20) | DEFAULT 'planned' | planned, active, completed, cancelled |
| `velocity` | INT | NULLABLE | Computed on close: sum of story points completed |
| `notes` | TEXT | NULLABLE | Retrospective notes |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |
| `closed_at` | TIMESTAMPTZ | NULLABLE | |

**Constraint:** Only one sprint per project may have `status = 'active'` at a time.

#### `tasks`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | Internal ID |
| `project_id` | UUID | FK → projects.id | |
| `human_id` | VARCHAR(20) | NOT NULL | e.g., "BBB-142". Generated from prefix + sequence. |
| `parent_task_id` | UUID | FK → tasks.id, NULLABLE | Non-null = subtask |
| `title` | VARCHAR(500) | NOT NULL | |
| `description` | TEXT | NULLABLE | Rich text (HTML from Tiptap) |
| `description_plain` | TEXT | NULLABLE | Plaintext extraction for search indexing |
| `phase_id` | UUID | FK → phases.id | Current board column |
| `state_id` | UUID | FK → task_states.id | Current status |
| `sprint_id` | UUID | FK → sprints.id, NULLABLE | Current sprint assignment (null = backlog) |
| `epic_id` | UUID | FK → epics.id, NULLABLE | Optional epic grouping |
| `assignee_id` | UUID | FK → users.id, NULLABLE | Primary assignee |
| `reporter_id` | UUID | FK → users.id | Creator |
| `priority` | VARCHAR(20) | DEFAULT 'medium' | critical, high, medium, low, none |
| `story_points` | INT | NULLABLE | Estimation (Fibonacci: 1,2,3,5,8,13,21) |
| `time_estimate_minutes` | INT | NULLABLE | Time-based estimation alternative |
| `time_logged_minutes` | INT | DEFAULT 0 | Accumulated time tracking |
| `start_date` | DATE | NULLABLE | Planned or actual start |
| `due_date` | DATE | NULLABLE | Deadline |
| `completed_at` | TIMESTAMPTZ | NULLABLE | When state became 'closed' |
| `position` | FLOAT | NOT NULL | Sort order within phase column (float for cheap reordering) |
| `labels` | UUID[] | DEFAULT '{}' | Array of label IDs |
| `watchers` | UUID[] | DEFAULT '{}' | Array of user IDs receiving notifications |
| `is_blocked` | BOOLEAN | DEFAULT false | Derived flag, set when blocking_tasks is non-empty |
| `blocking_task_ids` | UUID[] | DEFAULT '{}' | Tasks that block this one |
| `blocked_by_task_ids` | UUID[] | DEFAULT '{}' | Tasks this one blocks |
| `custom_fields` | JSONB | DEFAULT '{}' | Values for project-defined custom fields |
| `attachment_count` | INT | DEFAULT 0 | Denormalized for card display |
| `comment_count` | INT | DEFAULT 0 | Denormalized for card display |
| `subtask_count` | INT | DEFAULT 0 | Denormalized |
| `subtask_done_count` | INT | DEFAULT 0 | Denormalized |
| `carry_forward_count` | INT | DEFAULT 0 | How many times this task has been carried forward |
| `original_sprint_id` | UUID | FK → sprints.id, NULLABLE | The sprint this task was first assigned to |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT now() | |

**Indexes:**
- `(project_id, sprint_id, phase_id, position)` — board rendering
- `(project_id, human_id)` — unique, lookup by readable ID
- `(assignee_id, state_id)` — "my tasks" queries
- `(project_id, due_date)` — deadline views
- GIN index on `labels` for array containment queries
- GIN index on `description_plain` using `to_tsvector('english', ...)` for full-text search

#### `labels`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `project_id` | UUID | FK → projects.id | |
| `name` | VARCHAR(50) | NOT NULL | |
| `color` | VARCHAR(7) | NOT NULL | |
| `description` | TEXT | NULLABLE | |
| `position` | INT | NOT NULL | |

#### `epics`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `project_id` | UUID | FK → projects.id | |
| `name` | VARCHAR(255) | NOT NULL | |
| `description` | TEXT | NULLABLE | |
| `color` | VARCHAR(7) | NULLABLE | |
| `start_date` | DATE | NULLABLE | |
| `target_date` | DATE | NULLABLE | |
| `status` | VARCHAR(20) | DEFAULT 'open' | open, in_progress, closed |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

#### `comments`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `task_id` | UUID | FK → tasks.id | |
| `author_id` | UUID | FK → users.id | |
| `body` | TEXT | NOT NULL | Rich text (HTML) |
| `body_plain` | TEXT | NOT NULL | For search |
| `is_system` | BOOLEAN | DEFAULT false | Auto-generated comments (e.g., "moved to Sprint 13") |
| `edited_at` | TIMESTAMPTZ | NULLABLE | |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

#### `attachments`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `task_id` | UUID | FK → tasks.id | |
| `uploader_id` | UUID | FK → users.id | |
| `filename` | VARCHAR(255) | NOT NULL | Original filename |
| `content_type` | VARCHAR(100) | NOT NULL | MIME type |
| `size_bytes` | BIGINT | NOT NULL | |
| `storage_key` | TEXT | NOT NULL | S3 object key |
| `thumbnail_key` | TEXT | NULLABLE | For images |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

#### `activity_log`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `project_id` | UUID | FK → projects.id | |
| `task_id` | UUID | FK → tasks.id, NULLABLE | |
| `actor_id` | UUID | FK → users.id | |
| `action` | VARCHAR(50) | NOT NULL | e.g., 'task.created', 'task.moved', 'task.state_changed', 'comment.added' |
| `details` | JSONB | NOT NULL | Structured diff: `{ field: "phase_id", from: "...", to: "..." }` |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

**Partitioned** by `created_at` (monthly range partitions) for query performance and easy archival.

#### `custom_field_definitions`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `project_id` | UUID | FK → projects.id | |
| `name` | VARCHAR(100) | NOT NULL | |
| `field_type` | VARCHAR(20) | NOT NULL | text, number, date, select, multi_select, url, checkbox, user |
| `options` | JSONB | NULLABLE | For select/multi_select: `[{ "value": "ios", "label": "iOS", "color": "#..." }]` |
| `is_required` | BOOLEAN | DEFAULT false | |
| `is_visible_on_card` | BOOLEAN | DEFAULT false | Show on board card face |
| `position` | INT | NOT NULL | |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

#### `sprint_tasks` (Join / History)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `sprint_id` | UUID | FK → sprints.id | |
| `task_id` | UUID | FK → tasks.id | |
| `added_at` | TIMESTAMPTZ | DEFAULT now() | When the task was assigned to this sprint |
| `removed_at` | TIMESTAMPTZ | NULLABLE | When the task left this sprint (carry-forward or descoped) |
| `removal_reason` | VARCHAR(20) | NULLABLE | 'completed', 'carried_forward', 'descoped', 'cancelled' |
| `story_points_at_add` | INT | NULLABLE | Snapshot for velocity accuracy |

**Unique constraint:** `(sprint_id, task_id)` — a task appears in a sprint at most once.

---

## 6. Authentication & Authorization

### 6.1 Authentication

| Method | Details |
|---|---|
| **Email/Password** | Argon2id hashing. Email verification required. |
| **OAuth2 / OIDC** | Google, GitHub, Microsoft. Automatic account linking by verified email. |
| **Magic Link** | Passwordless email login as fallback. |
| **Sessions** | HTTP-only, Secure, SameSite=Lax cookies. Redis-backed session store. 30-day sliding expiry. |
| **2FA** | TOTP (Google Authenticator, Authy). Optional per user, enforceable per org. |

### 6.2 Authorization (RBAC)

Permissions are evaluated at two levels: **organization** and **project**.

#### Organization Roles

| Role | Capabilities |
|---|---|
| **Owner** | Full control. Billing, delete org, manage all projects, promote admins. Irrevocable unless transferred. |
| **Admin** | Create/archive projects, manage members, configure org settings. Cannot delete org or manage billing. |
| **Member** | Join projects (if open) or be invited. No org-level management. |

#### Project Roles

| Role | Capabilities |
|---|---|
| **Project Admin** | Full project configuration: phases, states, sprints, custom fields, member management. |
| **Member** | Create/edit/move tasks, comment, attach files. Cannot modify project configuration. |
| **Viewer** | Read-only access. Can add comments but cannot create or move tasks. |

#### Permission Matrix (Project-Level)

| Action | Admin | Member | Viewer |
|---|---|---|---|
| View board | Yes | Yes | Yes |
| Create task | Yes | Yes | No |
| Edit any task | Yes | Own + assigned | No |
| Move task (drag) | Yes | Yes | No |
| Delete task | Yes | Own only | No |
| Manage phases | Yes | No | No |
| Manage sprints | Yes | No | No |
| Configure states | Yes | No | No |
| Manage members | Yes | No | No |
| Add comment | Yes | Yes | Yes |
| Upload attachment | Yes | Yes | No |
| View activity log | Yes | Yes | Yes |
| Export data | Yes | Yes | No |

---

## 7. Sprint Lifecycle & Carry-Forward

### 7.1 Sprint States

```
planned ──▶ active ──▶ completed
                 │
                 └──▶ cancelled
```

- Only **one sprint** per project can be `active` at any time.
- Starting a sprint transitions it from `planned` to `active` and sets `start_date` if not already set.
- Completing a sprint triggers the **carry-forward ceremony** (see 7.3).

### 7.2 Sprint Planning

When a sprint is `planned`, the project admin (or members, if permitted) can:

1. **Pull tasks from the backlog** (tasks with `sprint_id = NULL`) into the sprint.
2. **Scope tasks from a previous sprint's carry-forward queue.**
3. **Create new tasks** directly within the sprint.
4. **Set a sprint goal** — a short textual objective displayed on the board header.
5. **Review capacity** — the system shows total story points / estimated hours vs. team historical velocity.

### 7.3 Sprint Close & Carry-Forward Ceremony

When the active sprint is completed:

1. **Snapshot velocity.** Sum of `story_points` for all tasks whose state `is_closed = true` in this sprint.
2. **Identify incomplete tasks.** All tasks in the sprint whose state `is_closed = false`.
3. **Present carry-forward dialog:**
   - Each incomplete task is listed with its current phase, state, assignee, and points.
   - For each task, the user selects one of:
     - **Carry forward to next sprint** — task's `sprint_id` is updated, `carry_forward_count` increments, a `sprint_tasks` record is created in the new sprint, and the old `sprint_tasks` record gets `removed_at` and `removal_reason = 'carried_forward'`.
     - **Move to backlog** — `sprint_id` set to NULL, `removal_reason = 'descoped'`.
     - **Cancel** — state set to the project's "Cancelled" state, `removal_reason = 'cancelled'`.
   - Bulk actions: "Carry all forward", "Move all to backlog".
4. **Generate sprint report** (see Section 12).
5. **Lock the sprint.** Completed sprints become read-only. Historical data is preserved.

### 7.4 Carry-Forward Tracking

Every task tracks:
- `carry_forward_count`: incremented each time it survives a sprint close without completion.
- `original_sprint_id`: the sprint it was first assigned to, never changes.

Board cards with `carry_forward_count > 0` display a small badge (e.g., "↻ 2") indicating the task has rolled over twice. This is a visual signal for stale or chronically underscoped work.

---

## 8. Task Model — Exhaustive Field Reference

### 8.1 Card Face (Visible on Board)

The card surface on the board displays a dense but scannable subset of task data:

```
┌──────────────────────────────────────┐
│ ● BBB-142                   ⚑ High  │
│                                      │
│ Implement OAuth2 login flow          │
│                                      │
│ 🏷 Feature  🏷 Auth                 │
│                                      │
│ ⏱ 5 pts     📅 Apr 15     ↻ 1      │
│ 👤 Eddie O.  💬 3  📎 1  ☐ 2/4     │
└──────────────────────────────────────┘
```

| Element | Source | Notes |
|---|---|---|
| State dot | `task_states.color` | Colored circle top-left |
| Human ID | `tasks.human_id` | Clickable, opens detail |
| Priority flag | `tasks.priority` | Color-coded icon |
| Title | `tasks.title` | Truncated at ~80 chars on card |
| Labels | `tasks.labels` → `labels` | Color pills with name |
| Story points | `tasks.story_points` | Small badge |
| Due date | `tasks.due_date` | Red if overdue, amber if within 2 days |
| Carry-forward badge | `tasks.carry_forward_count` | Only shown if > 0 |
| Assignee avatar | `tasks.assignee_id` → `users.avatar_url` | Small circular avatar |
| Comment count | `tasks.comment_count` | Icon + number |
| Attachment count | `tasks.attachment_count` | Icon + number |
| Subtask progress | `subtask_done_count / subtask_count` | Checkbox icon + fraction |
| Custom fields | `custom_field_definitions` where `is_visible_on_card = true` | Rendered per field type |

### 8.2 Task Detail Panel

Opens as a **slide-over drawer** from the right (animated with Motion `AnimatePresence` + `layoutId` for shared element transitions from the card). Full-width on mobile.

#### Header Section
- Human ID (copyable)
- Title (inline editable, auto-save on blur)
- State dropdown (configurable states)
- Priority dropdown
- Phase indicator (current column)

#### Description Section
- Tiptap rich text editor
- Supports: headings, bold, italic, code, lists, checkboxes, links, images, mentions (@user), task references (#BBB-xxx)
- Autosaves with debounce (1s after last keystroke)
- Markdown import/export

#### Metadata Sidebar (Right Column on Desktop)

| Field | Type | Behavior |
|---|---|---|
| Assignee | User picker | Single user. Searchable dropdown with avatars. |
| Reporter | User (auto) | Set on creation. Editable by admins. |
| Sprint | Sprint picker | Dropdown of planned/active sprints + "Backlog". |
| Phase | Phase picker | Moves card on board. |
| State | State picker | Configurable per project. |
| Priority | Select | critical / high / medium / low / none |
| Story Points | Number input | Fibonacci suggestions: 1, 2, 3, 5, 8, 13, 21 |
| Time Estimate | Duration input | Hours:minutes |
| Time Logged | Duration + log button | Opens time entry modal |
| Start Date | Date picker | |
| Due Date | Date picker | Highlights overdue |
| Labels | Multi-select | Color-coded, searchable |
| Epic | Select | Optional grouping |
| Watchers | Multi-select | Users notified on changes |
| Blocking | Task multi-select | Tasks that must complete before this one |
| Blocked By | Task multi-select | Tasks this one is waiting on |
| Custom Fields | Dynamic | Rendered per `custom_field_definitions` |

#### Subtasks Section
- Inline list of child tasks
- Each has: checkbox (toggle done), title (editable), assignee avatar, state dot
- "Add subtask" inline input
- Drag to reorder
- Click to open subtask detail (nested drawer or modal)
- Progress bar showing completion percentage

#### Activity & Comments Section (Tabbed)

**Comments tab:**
- Threaded comments with rich text (Tiptap, same config as description)
- @mentions trigger notifications
- Edit / delete own comments
- System comments (auto-generated) styled differently (muted, smaller font)

**Activity tab:**
- Chronological feed of all changes
- Each entry: timestamp, actor avatar, action description
- Examples: "Eddie moved this to In Progress", "Teeny changed priority from Medium to High", "Carried forward from Sprint 11 → Sprint 12"
- Filterable by change type

#### Attachments Section
- Drag-and-drop upload zone
- File list with: name, size, uploader, date, thumbnail (for images)
- Image attachments show inline preview
- Click to download or open in new tab
- Delete button (uploader or admin)

---

## 9. Board UI — Interaction Design

### 9.1 Layout

```
┌─────────────────────────────────────────────────────────────┐
│ [Project Nav]  Sprint 12 ▼  │  🎯 "Ship OAuth + profile"  │
│ [Filter Bar]  Assignee ▼  Label ▼  Priority ▼  Search 🔍  │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│ Backlog  │ To Do    │ In Prog  │ Review   │ Done            │
│ (12)     │ (5/8)    │ (3/4)    │ (2)      │ (18)           │
├──────────┼──────────┼──────────┼──────────┼─────────────────┤
│ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │ ┌──────┐       │
│ │ Card │ │ │ Card │ │ │ Card │ │ │ Card │ │ │ Card │       │
│ └──────┘ │ └──────┘ │ └──────┘ │ └──────┘ │ └──────┘       │
│ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │          │ ┌──────┐       │
│ │ Card │ │ │ Card │ │ │ Card │ │          │ │ Card │       │
│ └──────┘ │ └──────┘ │ └──────┘ │          │ └──────┘       │
│ ...      │ ...      │          │          │ (collapsed)     │
│          │          │          │          │                 │
│ [+ Add]  │ [+ Add]  │ [+ Add]  │ [+ Add]  │                 │
└──────────┴──────────┴──────────┴──────────┴─────────────────┘
```

### 9.2 Phase Columns

- **Header:** Phase name, task count, WIP indicator (count/limit, turns red when exceeded).
- **Scrollable:** Each column scrolls independently. Virtual scrolling for phases with 50+ tasks.
- **Collapsible:** Double-click header to collapse to a thin strip showing only the count. Useful for "Done" columns.
- **Add button:** Bottom of each column. Opens inline card creation (title + Enter to create, Escape to cancel).
- **Resizable:** Drag column borders to adjust width. Minimum 250px, maximum 500px. Persisted per user.

### 9.3 Drag & Drop (dnd-kit + Motion)

**Interactions:**
- **Card drag within column:** Reorders. Float animation as card lifts. Drop shadow. Other cards smoothly reflow using Motion `layout` prop.
- **Card drag between columns:** Moves task to new phase. Phase column highlights on hover (glow border). Card animates to new position on drop. If the phase has `auto_state_on_enter`, the task state updates immediately.
- **Multi-select drag:** Hold Shift+Click or Cmd+Click to select multiple cards. Drag the group. Count badge on cursor during drag.
- **Touch support:** Long-press to initiate drag on mobile. Haptic feedback (if available via navigator.vibrate).
- **Accessibility:** Keyboard drag via Space (grab) + Arrow keys (move) + Space (drop). Screen reader announcements for all state changes.

**Animation Specs (Motion):**

| Animation | Config | Duration |
|---|---|---|
| Card lift on drag start | `scale: 1.03, boxShadow: "0 12px 24px rgba(0,0,0,0.15)"` | 150ms spring |
| Card drop settle | `scale: 1.0, boxShadow: "none"` | 200ms spring (damping: 25, stiffness: 300) |
| Sibling reflow | `layout` prop with `transition: { type: "spring", damping: 20, stiffness: 250 }` | ~300ms |
| Column highlight on drag hover | `borderColor` transition + subtle `scale: 1.005` on column | 100ms ease |
| Card creation | `initial: { opacity: 0, y: -10 }` → `animate: { opacity: 1, y: 0 }` | 200ms spring |
| Card deletion | `exit: { opacity: 0, scale: 0.95, y: 10 }` | 150ms ease-out |
| Detail drawer open | `x: "100%"` → `x: 0` with spring physics | 300ms spring (damping: 30) |
| Detail drawer close | `x: 0` → `x: "100%"` | 250ms ease-in |
| Sprint transition | Staggered fade-out of old cards, staggered fade-in of new cards | 50ms stagger, 200ms each |

### 9.4 Swimlanes (Optional)

When enabled (toggle in filter bar), the board adds horizontal grouping:

- **By Assignee:** One row per team member + "Unassigned" row.
- **By Epic:** One row per epic + "No Epic" row.
- **By Priority:** Rows for Critical, High, Medium, Low, None.
- **By Label:** One row per label (tasks with multiple labels appear in each).
- **By Custom Field:** For select-type custom fields.

Each swimlane row is collapsible with an animated height transition. Row headers show: group name, task count, aggregate story points.

### 9.5 Filters & Search

**Filter bar** (persistent, below sprint selector):
- Assignee (multi-select user picker)
- Label (multi-select)
- Priority (multi-select)
- State (multi-select)
- Epic (multi-select)
- Due date (preset ranges: overdue, today, this week, this sprint, custom range)
- Custom fields (dynamic filters based on field type)

**Quick search:** Type-ahead input that filters cards by title, human ID, or description keywords. Highlights matching text on cards. Debounced at 200ms.

**Saved filters:** Users can save filter combinations as named views (e.g., "My critical tasks", "Unassigned bugs"). Saved per user per project.

**Filter state in URL:** All active filters are reflected in the URL query string for shareability and browser history.

---

## 10. Views

### 10.1 Board View (Primary)

The Kanban board described in Section 9. Default view for all projects.

### 10.2 List View

A dense table-style view showing all tasks in the current sprint (or backlog):

| Column | Sortable | Filterable |
|---|---|---|
| Human ID | Yes | Yes (text) |
| Title | Yes | Yes (text) |
| State | Yes | Yes (multi-select) |
| Phase | Yes | Yes (multi-select) |
| Assignee | Yes | Yes (multi-select) |
| Priority | Yes | Yes (multi-select) |
| Story Points | Yes | Yes (range) |
| Due Date | Yes | Yes (date range) |
| Labels | No | Yes (multi-select) |
| Created | Yes | No |
| Updated | Yes | No |

- Inline editing for: state, assignee, priority, story points, due date.
- Bulk selection (checkboxes) for batch operations: move to sprint, change state, change assignee, delete.
- Row click opens task detail.

### 10.3 Timeline / Gantt View

Horizontal timeline showing tasks as bars spanning `start_date` to `due_date`:

- Grouped by: epic, assignee, or phase.
- Drag bar edges to adjust dates.
- Drag whole bar to shift both dates.
- Dependency arrows (blocking/blocked-by relationships).
- Today marker (vertical red line).
- Zoom: day, week, month granularity.
- Powered by a lightweight custom renderer (no heavy Gantt library; render with SVG + Motion for animation).

### 10.4 Calendar View

Monthly calendar showing tasks on their due dates:

- Color-coded by priority or label.
- Drag tasks between dates to reschedule.
- Click date to create new task with that due date.
- Mini-dot indicators for days with many tasks.

### 10.5 My Work View

Personal dashboard showing cross-project task aggregation for the logged-in user:

- **Assigned to me:** Grouped by project, sorted by due date.
- **Watching:** Tasks I'm a watcher on, recent activity.
- **Overdue:** Red-flagged tasks past due date.
- **Coming up:** Tasks due within the next 7 days.
- **Activity feed:** Recent changes on my tasks across all projects.

---

## 11. Realtime Collaboration

### 11.1 WebSocket Architecture

Each user maintains a WebSocket connection. On connect:
1. Authenticate via session cookie or token.
2. Subscribe to rooms: `org:{org_id}`, `project:{project_id}` (for each project the user has access to), `user:{user_id}` (personal notifications).

### 11.2 Event Types

| Event | Payload | Broadcast Room |
|---|---|---|
| `task.created` | Full task object | `project:{id}` |
| `task.updated` | Task ID + changed fields (delta) | `project:{id}` |
| `task.moved` | Task ID, old phase, new phase, new position | `project:{id}` |
| `task.deleted` | Task ID | `project:{id}` |
| `task.reordered` | Phase ID + ordered task IDs | `project:{id}` |
| `comment.added` | Comment object | `project:{id}` + `user:{watcher_ids}` |
| `sprint.status_changed` | Sprint ID + new status | `project:{id}` |
| `phase.updated` | Phase object | `project:{id}` |
| `user.presence` | User ID + project ID + online/idle/offline | `project:{id}` |
| `notification` | Notification object | `user:{id}` |

### 11.3 Optimistic Updates

All mutations use optimistic updates via TanStack Query:

1. User drags card to new column.
2. Client immediately updates local state (card moves visually).
3. API request fires in background.
4. On success: cache is updated with server-confirmed data.
5. On failure: local state rolls back (card snaps back with Motion spring animation), toast error shown.

### 11.4 Conflict Resolution

- **Last-write-wins** for simple field updates (title, description, assignee, etc.). `updated_at` timestamp is sent with every update; server rejects if stale (HTTP 409). Client refetches and re-applies.
- **Board position conflicts**: If two users move cards simultaneously, the server determines final position order and broadcasts the authoritative `task.reordered` event. Both clients reconcile with an animated reflow.
- **Presence indicators**: User avatars appear on task cards that are currently being edited by another user. Small colored ring around the avatar, tooltip: "Eddie is editing this task."

---

## 12. Reporting & Analytics

### 12.1 Sprint Report (Generated on Sprint Close)

- **Velocity:** Story points completed vs. committed.
- **Completion rate:** Tasks completed / tasks in sprint at start.
- **Carry-forward list:** Tasks that rolled over, with their ages.
- **Scope change:** Tasks added mid-sprint vs. removed.
- **Burndown chart:** Daily remaining story points (ideal line vs. actual).

### 12.2 Cumulative Flow Diagram (CFD)

Time-series area chart showing daily task count per phase. Reveals bottlenecks (widening bands indicate accumulation).

### 12.3 Velocity Chart

Bar chart of story points completed per sprint over the last N sprints. Rolling average trendline.

### 12.4 Burndown / Burnup Charts

- **Burndown:** Remaining work (points or count) vs. time within a sprint.
- **Burnup:** Cumulative completed work vs. total scope, showing both scope growth and progress.

### 12.5 Cycle Time & Lead Time

- **Lead time:** Created → Done (calendar days).
- **Cycle time:** First "active" state → Done.
- Histogram distribution and per-task tracking. Computed from `activity_log` state transitions.

### 12.6 Custom Dashboards (Future)

Widget-based dashboard builder. Users compose dashboards from chart widgets, number tiles, and task lists. Persisted per user or shared with project.

---

## 13. Notifications

### 13.1 Channels

| Channel | Implementation |
|---|---|
| **In-app** | Real-time via WebSocket. Bell icon with unread count. Notification drawer with infinite scroll. |
| **Email** | BullMQ job → email service (Resend, SES, or Postmark). Batched digest option (hourly/daily). |
| **Slack** (integration) | Webhook-based. Per-project channel mapping. |
| **Browser push** | Web Push API with service worker. |

### 13.2 Notification Triggers

| Event | Notified Users |
|---|---|
| Assigned to task | Assignee |
| Mentioned in comment | Mentioned user(s) |
| Task state changed | Watchers + assignee |
| Task moved to new phase | Watchers + assignee |
| Comment on watched task | Watchers |
| Due date approaching (1 day) | Assignee |
| Task overdue | Assignee + reporter |
| Sprint started/completed | All project members |
| Carry-forward (task rolled over) | Assignee |
| Blocked/unblocked | Assignee of blocked task |

### 13.3 User Preferences

Per-user, per-channel granularity:
- Enable/disable each notification type per channel.
- "Do not disturb" schedule (e.g., no notifications before 9am or after 6pm in user's timezone).
- Email digest frequency: immediate, hourly, daily, weekly.
- Mute specific projects or tasks.

---

## 14. REST API — Complete Reference

### 14.1 Conventions

**Base URL:** `https://api.bigbluebam.io/v1` (cloud) or `https://<your-host>/api/v1` (self-hosted Docker)

**Content-Type:** `application/json` for all request/response bodies unless otherwise noted.

**Authentication:** Every request must include one of:
- `Authorization: Bearer <api_key>` — for automation, CI/CD, MCP server, and third-party integrations.
- Session cookie — set automatically by the browser after login. CSRF token required for mutating requests (`X-CSRF-Token` header).

**API Keys:** Generated per-user in Settings → API Keys. Each key has a configurable scope (read-only, read-write, admin) and optional project restriction. Keys are prefixed `bbam_` followed by 48 hex characters. Keys are stored as Argon2id hashes; the plaintext is shown exactly once at creation.

**Rate Limiting:** Enforced via Redis sliding window.

| Scope | Limit | Burst |
|---|---|---|
| Per API key | 100 req/min | 20 req/s |
| Per organization | 1,000 req/min | 100 req/s |
| Per IP (unauthenticated) | 20 req/min | 5 req/s |

Rate limit headers returned on every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix epoch seconds).

**Pagination:** Cursor-based for all list endpoints. Response includes:
```json
{
  "data": [...],
  "pagination": {
    "next_cursor": "eyJpZCI6Ij...",
    "prev_cursor": "eyJpZCI6Ij...",
    "has_more": true,
    "total_count": 342
  }
}
```
Query params: `?cursor=<string>&limit=<int>` (default 50, max 200).

**Filtering:** List endpoints accept query-string filters using the pattern `?filter[field]=value`. Multiple values: `?filter[priority]=high,critical`. Ranges: `?filter[due_date][gte]=2026-04-01&filter[due_date][lte]=2026-04-30`.

**Sorting:** `?sort=field` (ascending) or `?sort=-field` (descending). Multi-sort: `?sort=-priority,due_date`.

**Field Selection:** `?fields=id,title,assignee,state` to return only specified fields (reduces payload for mobile/low-bandwidth).

**Error Responses:** All errors return a consistent envelope:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "details": [
      { "field": "title", "issue": "required" }
    ],
    "request_id": "req_abc123"
  }
}
```

| HTTP Status | Error Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Request body or params failed schema validation |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication |
| 403 | `FORBIDDEN` | Authenticated but insufficient permissions |
| 404 | `NOT_FOUND` | Entity does not exist or not accessible |
| 409 | `CONFLICT` | Stale update (optimistic concurrency check failed) |
| 422 | `UNPROCESSABLE` | Semantically invalid (e.g., start sprint when one is already active) |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Server error (includes `request_id` for support) |

**Timestamps:** All timestamps are ISO 8601 in UTC (`2026-04-02T14:30:00Z`). Clients are responsible for local timezone display.

**ETags:** All GET responses include an `ETag` header. Conditional requests via `If-None-Match` return 304 when unchanged.

### 14.2 Authentication Endpoints

#### `POST /auth/register`
Create a new user account and organization.

**Request:**
```json
{
  "email": "eddie@bigblueceiling.com",
  "password": "min-12-chars-required",
  "display_name": "Eddie Offermann",
  "org_name": "Big Blue Ceiling"
}
```

**Response (201):**
```json
{
  "data": {
    "user": { "id": "uuid", "email": "...", "display_name": "...", "org_id": "uuid" },
    "organization": { "id": "uuid", "name": "Big Blue Ceiling", "slug": "big-blue-ceiling" },
    "session": { "token": "...", "expires_at": "..." }
  }
}
```

#### `POST /auth/login`
Authenticate with email/password.

**Request:**
```json
{
  "email": "eddie@bigblueceiling.com",
  "password": "...",
  "totp_code": "123456"  // Only if 2FA enabled
}
```

**Response (200):** Session cookie set + user object returned.

#### `POST /auth/login/oauth`
Initiate OAuth2 flow. Returns redirect URL.

**Request:** `{ "provider": "google" | "github" | "microsoft" }`

#### `POST /auth/logout`
Destroy session. Clears cookie.

#### `POST /auth/forgot-password`
Send password reset email. **Request:** `{ "email": "..." }`

#### `POST /auth/reset-password`
Complete password reset. **Request:** `{ "token": "...", "new_password": "..." }`

#### `POST /auth/magic-link`
Send passwordless login link. **Request:** `{ "email": "..." }`

#### `GET /auth/me`
Return the currently authenticated user with org context.

#### `PATCH /auth/me`
Update profile fields (display_name, avatar_url, timezone, notification_prefs).

#### `POST /auth/me/2fa/enable`
Begin TOTP setup. Returns QR code URI + secret.

#### `POST /auth/me/2fa/verify`
Confirm TOTP setup with a valid code.

#### `DELETE /auth/me/2fa`
Disable 2FA (requires current password).

### 14.3 API Key Management

#### `GET /auth/api-keys`
List all API keys for the current user (shows prefix + last 4 chars, never full key).

#### `POST /auth/api-keys`
Create new API key.
**Request:**
```json
{
  "name": "CI/CD Pipeline",
  "scope": "read_write",        // "read", "read_write", "admin"
  "project_ids": ["uuid"],      // null = all projects
  "expires_at": "2027-04-02T00:00:00Z"  // null = no expiry
}
```
**Response (201):** Returns the full key **once**. Not retrievable again.

#### `DELETE /auth/api-keys/:id`
Revoke an API key immediately.

### 14.4 Organization Endpoints

#### `GET /org`
Return the current user's organization.

#### `PATCH /org`
Update org settings (name, logo, plan settings, defaults).

#### `GET /org/members`
List all org members with roles.

**Query params:** `?filter[role]=admin&sort=-last_seen_at&limit=20`

#### `POST /org/members/invite`
Send email invitation.
**Request:**
```json
{
  "email": "teeny@bigblueceiling.com",
  "role": "member",
  "project_ids": ["uuid"]  // Optional: auto-add to projects on accept
}
```

#### `PATCH /org/members/:user_id`
Update member's org-level role.

#### `DELETE /org/members/:user_id`
Remove member from organization (cascades: removes from all projects, reassigns owned tasks to reporter).

### 14.5 Project Endpoints

#### `GET /projects`
List projects accessible to the current user.

**Query params:** `?filter[is_archived]=false&sort=-updated_at`

**Response (200):**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "BigBlueBam",
      "slug": "bigbluebam",
      "icon": "🔵",
      "color": "#3B82F6",
      "task_id_prefix": "BBB",
      "member_count": 5,
      "open_task_count": 42,
      "active_sprint": { "id": "uuid", "name": "Sprint 12", "end_date": "2026-04-15" },
      "my_role": "admin",
      "updated_at": "2026-04-02T10:00:00Z"
    }
  ],
  "pagination": { ... }
}
```

#### `POST /projects`
Create a new project.

**Request:**
```json
{
  "name": "BigBlueBam",
  "slug": "bigbluebam",              // Optional, auto-generated from name if omitted
  "description": "Project planning tool",
  "icon": "🔵",
  "color": "#3B82F6",
  "task_id_prefix": "BBB",
  "default_sprint_duration_days": 14,
  "template": "kanban_standard"       // Optional: pre-populate phases + states from template
}
```

**Templates available:** `kanban_standard` (Backlog → To Do → In Progress → Review → Done), `scrum` (Product Backlog → Sprint Backlog → In Progress → Testing → Done), `bug_tracking` (Triage → Confirmed → In Progress → Fixed → Verified → Closed), `minimal` (To Do → Doing → Done), `none` (empty — user configures from scratch).

#### `GET /projects/:id`
Full project details including settings, member count, active sprint summary.

#### `PATCH /projects/:id`
Update project fields. **Requires:** Project Admin role.

#### `DELETE /projects/:id`
Soft-delete (archive) a project. Recoverable for 30 days. **Requires:** Org Admin or Project Admin.

#### `POST /projects/:id/archive`
Archive project (hide from default views, read-only).

#### `POST /projects/:id/unarchive`
Restore archived project.

#### `GET /projects/:id/members`
List project members with project-level roles.

#### `POST /projects/:id/members`
Add a member to the project.
**Request:** `{ "user_id": "uuid", "role": "member" }`

#### `PATCH /projects/:id/members/:user_id`
Change a member's project role.

#### `DELETE /projects/:id/members/:user_id`
Remove member from project.

### 14.6 Phase Endpoints

#### `GET /projects/:id/phases`
List phases in position order with task counts and WIP status.

**Response (200):**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "In Progress",
      "color": "#F59E0B",
      "position": 2,
      "wip_limit": 4,
      "current_count": 3,
      "is_start": false,
      "is_terminal": false,
      "auto_state_on_enter": "uuid_or_null"
    }
  ]
}
```

#### `POST /projects/:id/phases`
Create a new phase.
**Request:**
```json
{
  "name": "QA Review",
  "color": "#8B5CF6",
  "position": 3,           // Existing phases at >= this position shift right
  "wip_limit": 5,
  "is_terminal": false,
  "auto_state_on_enter": "uuid"
}
```

#### `PATCH /phases/:id`
Update phase properties.

#### `DELETE /phases/:id`
Delete a phase. **Requires:** phase must be empty (no tasks), or request must include `?migrate_to=<phase_id>` to move all tasks to another phase before deletion.

#### `POST /projects/:id/phases/reorder`
Bulk reorder phases.
**Request:** `{ "phase_ids": ["uuid_a", "uuid_b", "uuid_c"] }` — array order becomes position order.

### 14.7 Task State Endpoints

#### `GET /projects/:id/states`
List configurable task states.

#### `POST /projects/:id/states`
Create a new task state.
**Request:**
```json
{
  "name": "Blocked",
  "color": "#EF4444",
  "icon": "🚫",
  "category": "blocked",
  "position": 3,
  "is_default": false,
  "is_closed": false
}
```

#### `PATCH /states/:id`
Update state properties.

#### `DELETE /states/:id`
Delete a state. Requires `?migrate_to=<state_id>` to reassign all tasks using this state.

#### `POST /projects/:id/states/reorder`
Bulk reorder states.

### 14.8 Sprint Endpoints

#### `GET /projects/:id/sprints`
List all sprints.

**Query params:** `?filter[status]=active,planned&sort=-start_date`

**Response (200):**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Sprint 12",
      "goal": "Ship OAuth + profile pages",
      "start_date": "2026-04-01",
      "end_date": "2026-04-15",
      "status": "active",
      "task_count": 18,
      "completed_count": 7,
      "total_points": 55,
      "completed_points": 21,
      "velocity": null
    }
  ]
}
```

#### `POST /projects/:id/sprints`
Create sprint.
**Request:**
```json
{
  "name": "Sprint 13",
  "goal": "Payment integration",
  "start_date": "2026-04-16",
  "end_date": "2026-04-30"
}
```

#### `GET /sprints/:id`
Sprint details including task breakdown by state.

#### `PATCH /sprints/:id`
Update sprint fields. Only `planned` sprints allow date changes.

#### `POST /sprints/:id/start`
Transition sprint from `planned` → `active`. Fails if another sprint is already active in the project (HTTP 422).

#### `POST /sprints/:id/complete`
Complete the active sprint. Requires carry-forward decisions for all incomplete tasks.

**Request:**
```json
{
  "carry_forward": {
    "target_sprint_id": "uuid",       // Sprint to receive carried-forward tasks
    "tasks": [
      { "task_id": "uuid", "action": "carry_forward" },
      { "task_id": "uuid", "action": "backlog" },
      { "task_id": "uuid", "action": "cancel" }
    ]
  },
  "retrospective_notes": "Velocity was lower due to unplanned OAuth bug..."
}
```

**Response (200):** Sprint report summary (velocity, completion rate, carry-forward list).

#### `POST /sprints/:id/cancel`
Cancel a planned or active sprint. All tasks move to backlog.

#### `GET /sprints/:id/report`
Retrieve the sprint report (generated on completion or on demand for active sprints).

**Response (200):**
```json
{
  "data": {
    "sprint_id": "uuid",
    "velocity": 34,
    "committed_points": 55,
    "completion_rate": 0.72,
    "tasks_completed": 13,
    "tasks_carried_forward": 4,
    "tasks_descoped": 1,
    "scope_changes": { "added_mid_sprint": 3, "removed_mid_sprint": 1 },
    "burndown": [
      { "date": "2026-04-01", "remaining_points": 55 },
      { "date": "2026-04-02", "remaining_points": 52 }
    ],
    "carry_forward_details": [
      { "task_id": "uuid", "human_id": "BBB-88", "title": "...", "carry_count": 2 }
    ]
  }
}
```

### 14.9 Task Endpoints

#### `GET /projects/:id/tasks`
List and search tasks with full filtering and sorting.

**Query params (all optional):**
- `?filter[sprint_id]=uuid` — tasks in a specific sprint (`null` for backlog)
- `?filter[phase_id]=uuid`
- `?filter[state_id]=uuid`
- `?filter[assignee_id]=uuid` (`unassigned` for null assignee)
- `?filter[priority]=high,critical`
- `?filter[label_ids]=uuid1,uuid2` (tasks with ANY of these labels)
- `?filter[epic_id]=uuid`
- `?filter[due_date][gte]=2026-04-01`
- `?filter[due_date][lte]=2026-04-15`
- `?filter[is_blocked]=true`
- `?filter[carry_forward_count][gte]=1` (tasks that have been carried forward)
- `?search=oauth+login` (full-text search on title + description)
- `?sort=-priority,due_date`
- `?fields=id,human_id,title,state,assignee,priority` (sparse fieldset)

#### `GET /projects/:id/board`
**The primary board-rendering endpoint.** Returns the full board state for the active sprint (or backlog if no sprint is active).

**Query params:** `?sprint_id=uuid` (override which sprint to display), `?swimlane=assignee|epic|priority|label|none`

**Response (200):**
```json
{
  "data": {
    "project": { "id": "...", "name": "...", "task_id_prefix": "BBB" },
    "sprint": { "id": "...", "name": "Sprint 12", "goal": "...", "end_date": "..." },
    "phases": [
      {
        "id": "uuid",
        "name": "In Progress",
        "color": "#F59E0B",
        "position": 2,
        "wip_limit": 4,
        "tasks": [
          {
            "id": "uuid",
            "human_id": "BBB-142",
            "title": "Implement OAuth2 login flow",
            "state": { "id": "uuid", "name": "Active", "color": "#22C55E" },
            "priority": "high",
            "story_points": 5,
            "due_date": "2026-04-15",
            "assignee": { "id": "uuid", "display_name": "Eddie O.", "avatar_url": "..." },
            "labels": [
              { "id": "uuid", "name": "Feature", "color": "#3B82F6" }
            ],
            "comment_count": 3,
            "attachment_count": 1,
            "subtask_count": 4,
            "subtask_done_count": 2,
            "carry_forward_count": 1,
            "is_blocked": false,
            "position": 1024.0,
            "custom_fields_visible": {
              "platform": "iOS"
            }
          }
        ]
      }
    ],
    "members_online": ["uuid_a", "uuid_b"]
  }
}
```

#### `POST /projects/:id/tasks`
Create a new task.

**Request:**
```json
{
  "title": "Implement OAuth2 login flow",
  "description": "<p>Support Google and GitHub OAuth providers...</p>",
  "phase_id": "uuid",
  "state_id": "uuid",           // Optional, uses project default if omitted
  "sprint_id": "uuid",          // Optional, null = backlog
  "assignee_id": "uuid",
  "priority": "high",
  "story_points": 5,
  "time_estimate_minutes": 480,
  "start_date": "2026-04-02",
  "due_date": "2026-04-15",
  "label_ids": ["uuid_a", "uuid_b"],
  "epic_id": "uuid",
  "parent_task_id": "uuid",     // Creates as subtask
  "custom_fields": {
    "field_uuid_a": "iOS",
    "field_uuid_b": true
  }
}
```

**Response (201):** Full task object including generated `human_id`.

#### `GET /tasks/:id`
Full task detail including all fields, subtasks, recent comments, and activity.

**Response (200):**
```json
{
  "data": {
    "id": "uuid",
    "human_id": "BBB-142",
    "title": "Implement OAuth2 login flow",
    "description": "<p>Support Google and GitHub...</p>",
    "phase": { "id": "uuid", "name": "In Progress" },
    "state": { "id": "uuid", "name": "Active", "color": "#22C55E", "category": "active" },
    "sprint": { "id": "uuid", "name": "Sprint 12" },
    "epic": { "id": "uuid", "name": "Auth System" },
    "assignee": { "id": "uuid", "display_name": "Eddie O.", "avatar_url": "..." },
    "reporter": { "id": "uuid", "display_name": "Teeny" },
    "priority": "high",
    "story_points": 5,
    "time_estimate_minutes": 480,
    "time_logged_minutes": 120,
    "start_date": "2026-04-02",
    "due_date": "2026-04-15",
    "completed_at": null,
    "labels": [ ... ],
    "watchers": [ ... ],
    "blocking_tasks": [ { "id": "uuid", "human_id": "BBB-140", "title": "..." } ],
    "blocked_by_tasks": [],
    "is_blocked": false,
    "carry_forward_count": 1,
    "original_sprint": { "id": "uuid", "name": "Sprint 11" },
    "custom_fields": { ... },
    "subtasks": [
      { "id": "uuid", "human_id": "BBB-143", "title": "Google OAuth provider", "state": { ... }, "assignee": { ... } }
    ],
    "attachment_count": 1,
    "comment_count": 3,
    "created_at": "2026-03-28T09:00:00Z",
    "updated_at": "2026-04-02T14:30:00Z"
  }
}
```

#### `PATCH /tasks/:id`
Partial update. Only include fields to change. Supports optimistic concurrency via `If-Match` ETag header.

**Request:**
```json
{
  "title": "Implement OAuth2 login flow (Google + GitHub)",
  "priority": "critical",
  "assignee_id": "uuid"
}
```

**Response (200):** Updated task object.
**Response (409):** Conflict — another user modified the task since your last read. Client should refetch and retry.

#### `POST /tasks/:id/move`
Move a task to a different phase and/or position. Separated from PATCH because it involves position recalculation and may trigger `auto_state_on_enter`.

**Request:**
```json
{
  "phase_id": "uuid",
  "position": 2048.0,           // Float for fractional positioning
  "sprint_id": "uuid"           // Optional: also change sprint assignment
}
```

#### `DELETE /tasks/:id`
Soft-delete a task. Moves to a 30-day trash. **Requires:** task creator, assignee, or project admin.

#### `POST /tasks/:id/restore`
Restore a soft-deleted task from trash.

#### `POST /tasks/bulk`
Batch operations on multiple tasks.

**Request:**
```json
{
  "task_ids": ["uuid_a", "uuid_b", "uuid_c"],
  "operation": "update",          // "update", "move", "delete"
  "fields": {
    "assignee_id": "uuid",
    "sprint_id": "uuid",
    "priority": "high"
  }
}
```

### 14.10 Subtask Endpoints

#### `GET /tasks/:id/subtasks`
List subtasks of a parent task.

#### `POST /tasks/:id/subtasks`
Create a subtask (shorthand for `POST /projects/:id/tasks` with `parent_task_id`).

#### `POST /tasks/:id/subtasks/reorder`
Reorder subtasks. **Request:** `{ "subtask_ids": ["uuid_a", "uuid_b"] }`

### 14.11 Comment Endpoints

#### `GET /tasks/:id/comments`
List comments on a task, newest first.

**Query params:** `?filter[is_system]=false` (exclude auto-generated comments), `?cursor=...&limit=20`

#### `POST /tasks/:id/comments`
Add a comment.
**Request:**
```json
{
  "body": "<p>Looks good, but we should also handle the token refresh case. @eddie thoughts?</p>"
}
```

Mentions (`@display_name`) are resolved server-side to user IDs and trigger notifications.

#### `PATCH /comments/:id`
Edit a comment (own comments only). Sets `edited_at`.

#### `DELETE /comments/:id`
Delete a comment (own comments or project admin).

### 14.12 Attachment Endpoints

#### `POST /tasks/:id/attachments/presign`
Request a presigned S3 upload URL. Client uploads directly to S3, then confirms.

**Request:**
```json
{
  "filename": "screenshot.png",
  "content_type": "image/png",
  "size_bytes": 245000
}
```

**Response (200):**
```json
{
  "data": {
    "upload_url": "https://s3.amazonaws.com/...",
    "attachment_id": "uuid",
    "expires_at": "2026-04-02T15:00:00Z"
  }
}
```

#### `POST /tasks/:id/attachments/:attachment_id/confirm`
Confirm upload completion. Server verifies the object exists in S3, generates thumbnail if image, increments `attachment_count`.

#### `GET /tasks/:id/attachments`
List attachments with download URLs.

#### `DELETE /attachments/:id`
Delete an attachment (uploader or project admin). Removes from S3 asynchronously.

### 14.13 Activity & Notifications

#### `GET /projects/:id/activity`
Project-wide activity feed.

**Query params:** `?filter[task_id]=uuid`, `?filter[actor_id]=uuid`, `?filter[action]=task.moved,task.state_changed`, `?after=2026-04-01T00:00:00Z`

#### `GET /tasks/:id/activity`
Task-specific activity feed.

#### `GET /me/notifications`
Current user's notification list.

**Query params:** `?filter[is_read]=false`, `?limit=20`

#### `POST /me/notifications/mark-read`
Mark notifications as read.
**Request:** `{ "notification_ids": ["uuid_a", "uuid_b"] }` or `{ "all": true }`

### 14.14 Labels & Epics

#### `GET /projects/:id/labels`
List labels. `POST`, `PATCH`, `DELETE` follow standard patterns.

#### `GET /projects/:id/epics`
List epics with task counts and progress. `POST`, `PATCH`, `DELETE` follow standard patterns.

### 14.15 Custom Fields

#### `GET /projects/:id/custom-fields`
List custom field definitions.

#### `POST /projects/:id/custom-fields`
Create a custom field definition (see `custom_field_definitions` table in Section 5.2).

#### `PATCH /custom-fields/:id`
Update field definition. Changing `field_type` is disallowed if tasks have values (returns 422).

#### `DELETE /custom-fields/:id`
Delete field definition. Removes all stored values across tasks.

### 14.16 Time Tracking

#### `POST /tasks/:id/time-entries`
Log time against a task.
**Request:**
```json
{
  "minutes": 90,
  "date": "2026-04-02",
  "description": "Implemented Google OAuth callback handler"
}
```

#### `GET /tasks/:id/time-entries`
List time entries for a task.

#### `GET /me/time-entries`
Cross-project time entries for the current user.
**Query params:** `?filter[date][gte]=2026-04-01&filter[date][lte]=2026-04-07`

#### `DELETE /time-entries/:id`
Delete a time entry (own entries only).

### 14.17 Saved Views

#### `GET /projects/:id/views`
List saved filter/view configurations.

#### `POST /projects/:id/views`
Save a view.
**Request:**
```json
{
  "name": "My Critical Bugs",
  "filters": {
    "assignee_id": "me",
    "priority": ["critical", "high"],
    "label_ids": ["uuid_bug_label"]
  },
  "sort": "-due_date",
  "swimlane": "none",
  "is_shared": false
}
```

### 14.18 Reporting Endpoints

#### `GET /projects/:id/reports/velocity`
Sprint-over-sprint velocity data.
**Query params:** `?last_n_sprints=10`

#### `GET /projects/:id/reports/burndown`
Burndown chart data for a sprint.
**Query params:** `?sprint_id=uuid`

#### `GET /projects/:id/reports/cfd`
Cumulative flow diagram data.
**Query params:** `?from=2026-01-01&to=2026-04-02&granularity=day`

#### `GET /projects/:id/reports/cycle-time`
Cycle time distribution.
**Query params:** `?from=2026-01-01&to=2026-04-02`

### 14.19 Export Endpoints

#### `POST /projects/:id/export`
Trigger an async export job.
**Request:** `{ "format": "json" | "csv" | "pdf_sprint_report", "sprint_id": "uuid" }`
**Response (202):** `{ "job_id": "uuid", "status_url": "/jobs/uuid" }`

#### `GET /jobs/:id`
Poll export job status. When complete, includes `download_url`.

### 14.20 Webhooks (Outgoing)

#### `GET /projects/:id/webhooks`
List registered webhooks.

#### `POST /projects/:id/webhooks`
Register a new webhook.
**Request:**
```json
{
  "url": "https://your-service.com/webhook",
  "events": ["task.created", "task.updated", "task.moved", "sprint.completed", "comment.added"],
  "secret": "your-hmac-secret"
}
```

**Delivery:** POST to the URL with JSON body. Signed with `X-BigBlueBam-Signature: sha256=<hmac>`. Retries: 3 attempts with exponential backoff (10s, 60s, 300s). Dead letter queue after 3 failures; webhook auto-disabled after 10 consecutive failures.

#### `PATCH /webhooks/:id`
Update webhook URL, events, or secret.

#### `DELETE /webhooks/:id`
Remove webhook.

#### `GET /webhooks/:id/deliveries`
View recent delivery history (status code, response time, payload snapshot).

---

## 15. MCP Server

BigBlueBam exposes a **Model Context Protocol (MCP)** server, enabling any MCP-compatible AI client (Claude, Claude Code, custom agents, IDE integrations) to interact with project data through structured tool calls. The MCP server is a first-class citizen — not a bolt-on — meaning every REST endpoint has a corresponding MCP tool where appropriate.

### 15.1 Architecture

```
┌──────────────────────────┐
│   MCP Client             │
│  (Claude, IDE, Agent)    │
└───────────┬──────────────┘
            │ SSE (HTTP) or Streamable HTTP
┌───────────▼──────────────┐
│   BigBlueBam MCP Server  │
│   Node.js / TypeScript   │
│   @modelcontextprotocol  │
│        /sdk              │
├──────────────────────────┤
│   Auth Middleware         │
│   Rate Limiter           │
│   Audit Logger           │
├──────────────────────────┤
│   Tool Registry          │
│   Resource Registry      │
│   Prompt Registry        │
└───────────┬──────────────┘
            │ Internal calls (no network hop)
┌───────────▼──────────────┐
│   BigBlueBam Core API    │
│   (same process or       │
│    localhost loopback)    │
└──────────────────────────┘
```

**Transport:** Streamable HTTP (primary, recommended for remote/cloud deployments) and SSE (supported for backward compatibility). Stdio transport available for local CLI/IDE integrations.

**SDK:** Built with the official `@modelcontextprotocol/sdk` TypeScript package.

**Deployment:** Runs as a sidecar container in Docker, or as a route within the main API process (`/mcp/sse` and `/mcp/messages`) for minimal deployments.

### 15.2 Authentication & Security

| Layer | Mechanism |
|---|---|
| **Client auth** | Bearer token in the initial HTTP request. Reuses BigBlueBam API keys (`bbam_...`). API key scope determines which tools are available. |
| **OAuth2 (remote)** | For cloud-hosted MCP endpoints, supports OAuth 2.1 with PKCE per the MCP specification's authorization flow. Client registers, gets authorization URL, exchanges code for token, uses token for session. |
| **Session binding** | Each MCP session is bound to a single authenticated user. All tool calls execute with that user's permissions — no privilege escalation possible. |
| **Input validation** | Every tool input is validated against a Zod schema before execution. Malformed input returns a structured error, never reaches the database. |
| **Output sanitization** | Tool responses are stripped of internal IDs, stack traces, and infrastructure details. Only business data is returned. |
| **Rate limiting** | Shared rate limit pool with the REST API. MCP calls count against the same per-user and per-org limits. |
| **Audit logging** | Every MCP tool invocation is logged to `activity_log` with `actor_id` set to the authenticated user and `action` prefixed with `mcp.` (e.g., `mcp.task.created`). This provides full traceability of AI-initiated actions. |
| **Read vs. Write scoping** | API keys can be scoped to `read` (tools that only fetch data), `read_write` (create/update/move), or `admin` (configuration changes). The MCP server enforces this at the tool registration level — write tools are simply not registered for read-only sessions. |
| **Confirmation for destructive actions** | Tools that delete tasks, close sprints, or remove members return a confirmation prompt in the tool response rather than executing immediately. The AI client must call a `confirm_action` tool with the returned `action_token` to proceed. |

### 15.3 MCP Tools — Complete Registry

#### 15.3.1 Project Tools

**`list_projects`**
- **Description:** List all projects accessible to the authenticated user.
- **Input schema:**
  ```json
  {
    "include_archived": { "type": "boolean", "default": false }
  }
  ```
- **Output:** Array of project summaries (id, name, slug, active sprint, open task count).

**`get_project`**
- **Description:** Get full details for a specific project including phases, states, and active sprint.
- **Input schema:**
  ```json
  {
    "project_id": { "type": "string", "format": "uuid", "required": true }
  }
  ```

**`create_project`**
- **Description:** Create a new project with optional template.
- **Input schema:**
  ```json
  {
    "name": { "type": "string", "required": true },
    "description": { "type": "string" },
    "task_id_prefix": { "type": "string", "pattern": "^[A-Z]{2,6}$", "required": true },
    "template": { "type": "string", "enum": ["kanban_standard", "scrum", "bug_tracking", "minimal", "none"] },
    "default_sprint_duration_days": { "type": "integer", "default": 14 }
  }
  ```

#### 15.3.2 Board & Phase Tools

**`get_board`**
- **Description:** Retrieve the full board state for a project's active sprint. Returns phases with their tasks in position order — the primary view an AI needs to understand current project status.
- **Input schema:**
  ```json
  {
    "project_id": { "type": "string", "format": "uuid", "required": true },
    "sprint_id": { "type": "string", "format": "uuid", "description": "Override sprint. Omit for active sprint." }
  }
  ```

**`list_phases`**
- **Description:** List phases for a project with configuration details.
- **Input:** `{ "project_id": "uuid" }`

**`create_phase`**
- **Description:** Add a new phase (column) to a project's board.
- **Input:** `{ "project_id": "uuid", "name": "string", "position": "integer", "wip_limit": "integer|null", "is_terminal": "boolean" }`

**`reorder_phases`**
- **Description:** Set the display order of all phases.
- **Input:** `{ "project_id": "uuid", "phase_ids": ["uuid"] }`

#### 15.3.3 Sprint Tools

**`list_sprints`**
- **Description:** List sprints for a project with status and point totals.
- **Input:** `{ "project_id": "uuid", "status_filter": ["planned", "active", "completed"] }`

**`create_sprint`**
- **Description:** Create a new sprint.
- **Input:** `{ "project_id": "uuid", "name": "string", "goal": "string", "start_date": "date", "end_date": "date" }`

**`start_sprint`**
- **Description:** Activate a planned sprint. Fails if another sprint is active.
- **Input:** `{ "sprint_id": "uuid" }`

**`complete_sprint`**
- **Description:** Complete the active sprint with carry-forward decisions. This is a high-stakes operation — the MCP server returns a confirmation prompt with a summary of what will happen before executing.
- **Input:**
  ```json
  {
    "sprint_id": { "type": "string", "format": "uuid", "required": true },
    "carry_forward_target_sprint_id": { "type": "string", "format": "uuid" },
    "task_actions": {
      "type": "array",
      "items": {
        "task_id": "uuid",
        "action": { "enum": ["carry_forward", "backlog", "cancel"] }
      }
    },
    "retrospective_notes": { "type": "string" }
  }
  ```

**`get_sprint_report`**
- **Description:** Retrieve velocity, burndown, and completion data for a sprint.
- **Input:** `{ "sprint_id": "uuid" }`

#### 15.3.4 Task Tools

**`search_tasks`**
- **Description:** Search and filter tasks across a project. Supports full-text search, field filters, and sorting. The primary way for an AI to find specific tasks.
- **Input schema:**
  ```json
  {
    "project_id": { "type": "string", "format": "uuid", "required": true },
    "query": { "type": "string", "description": "Full-text search on title and description" },
    "sprint_id": { "type": "string", "description": "'backlog' for unassigned, UUID for specific sprint" },
    "assignee_id": { "type": "string", "description": "'unassigned' or UUID" },
    "phase_id": { "type": "string", "format": "uuid" },
    "state_id": { "type": "string", "format": "uuid" },
    "priority": { "type": "array", "items": { "enum": ["critical", "high", "medium", "low", "none"] } },
    "label_ids": { "type": "array", "items": "uuid" },
    "is_blocked": { "type": "boolean" },
    "due_date_before": { "type": "string", "format": "date" },
    "due_date_after": { "type": "string", "format": "date" },
    "sort": { "type": "string", "default": "-updated_at" },
    "limit": { "type": "integer", "default": 50, "maximum": 200 }
  }
  ```

**`get_task`**
- **Description:** Get full detail for a single task including subtasks, recent comments, and activity.
- **Input:** `{ "task_id": "uuid" }` or `{ "human_id": "BBB-142", "project_id": "uuid" }`

**`create_task`**
- **Description:** Create a new task. Supports all fields including custom fields, labels, blocking relationships, and subtask creation.
- **Input:** Full task creation schema (mirrors POST `/projects/:id/tasks` request body).

**`update_task`**
- **Description:** Update one or more fields on an existing task. Partial update — only include fields to change.
- **Input:** `{ "task_id": "uuid", ...fields_to_update }`

**`move_task`**
- **Description:** Move a task to a different phase and/or sprint. Triggers `auto_state_on_enter` if configured.
- **Input:** `{ "task_id": "uuid", "phase_id": "uuid", "sprint_id": "uuid|null" }`

**`delete_task`**
- **Description:** Soft-delete a task. Returns confirmation prompt before executing.
- **Input:** `{ "task_id": "uuid" }`
- **Requires:** `confirm_action` follow-up.

**`bulk_update_tasks`**
- **Description:** Apply the same field changes to multiple tasks at once.
- **Input:** `{ "task_ids": ["uuid"], "fields": { ... } }`

**`log_time`**
- **Description:** Log time spent on a task.
- **Input:** `{ "task_id": "uuid", "minutes": 90, "date": "2026-04-02", "description": "string" }`

#### 15.3.5 Comment Tools

**`list_comments`**
- **Description:** List comments on a task.
- **Input:** `{ "task_id": "uuid", "include_system": false, "limit": 20 }`

**`add_comment`**
- **Description:** Post a comment on a task. Supports plain text (auto-wrapped in `<p>` tags).
- **Input:** `{ "task_id": "uuid", "body": "string" }`

#### 15.3.6 Member Tools

**`list_members`**
- **Description:** List project or org members with roles and online status.
- **Input:** `{ "project_id": "uuid" }` or `{ "scope": "organization" }`

**`get_my_tasks`**
- **Description:** Get all tasks assigned to the authenticated user across all projects. Equivalent to the "My Work" view.
- **Input:** `{ "filter_overdue": false, "filter_due_soon_days": 7 }`

#### 15.3.7 Reporting Tools

**`get_velocity_report`**
- **Input:** `{ "project_id": "uuid", "last_n_sprints": 10 }`

**`get_burndown`**
- **Input:** `{ "sprint_id": "uuid" }`

**`get_cumulative_flow`**
- **Input:** `{ "project_id": "uuid", "from_date": "date", "to_date": "date" }`

#### 15.3.8 Utility Tools

**`confirm_action`**
- **Description:** Confirm a destructive action that was previously staged. Required after `delete_task`, `complete_sprint`, or `remove_member` returns a confirmation prompt.
- **Input:** `{ "action_token": "string" }`
- **Token validity:** 60 seconds. Single-use.

**`get_server_info`**
- **Description:** Returns BigBlueBam instance version, authenticated user, org, available projects, and current rate limit status. Useful for AI clients to orient themselves.
- **Input:** (none)

### 15.4 MCP Resources

Resources provide read-only data that AI clients can pull into their context window.

| URI Pattern | Description |
|---|---|
| `bigbluebam://projects` | List of all accessible projects |
| `bigbluebam://projects/{id}/board` | Current board state |
| `bigbluebam://projects/{id}/backlog` | All backlog tasks |
| `bigbluebam://sprints/{id}` | Sprint details + task list |
| `bigbluebam://tasks/{human_id}` | Full task detail (by human-readable ID) |
| `bigbluebam://me/tasks` | Current user's task list |
| `bigbluebam://me/notifications` | Unread notifications |

### 15.5 MCP Prompts

Pre-built prompt templates for common AI workflows:

**`sprint_planning`**
- **Description:** "Help me plan the next sprint. Here's the current backlog, team velocity, and capacity."
- **Arguments:** `{ "project_id": "uuid" }`
- **Behavior:** Fetches backlog tasks, last 3 sprint velocities, and team member list. Returns a structured prompt that guides the AI through prioritization and scoping.

**`daily_standup`**
- **Description:** "Summarize what happened yesterday and what's planned for today."
- **Arguments:** `{ "project_id": "uuid" }`
- **Behavior:** Fetches activity log for the last 24 hours and the active sprint's in-progress tasks.

**`sprint_retrospective`**
- **Description:** "Help me run a sprint retrospective."
- **Arguments:** `{ "sprint_id": "uuid" }`
- **Behavior:** Fetches sprint report, carry-forward history, and scope changes. Returns a structured prompt for "what went well / what could improve / action items."

**`task_breakdown`**
- **Description:** "Help me break this epic or large task into smaller subtasks with estimates."
- **Arguments:** `{ "task_id": "uuid" }`
- **Behavior:** Fetches task detail and similar historical tasks for estimation reference.

### 15.6 MCP Server Configuration

The MCP server is configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `MCP_ENABLED` | `true` | Enable/disable the MCP server |
| `MCP_TRANSPORT` | `streamable-http` | Transport: `streamable-http`, `sse`, `stdio` |
| `MCP_PORT` | `3001` | Port for MCP server (if running as sidecar) |
| `MCP_PATH` | `/mcp` | URL path prefix when running integrated with API |
| `MCP_AUTH_REQUIRED` | `true` | Require authentication (disable only for local dev) |
| `MCP_RATE_LIMIT_RPM` | `100` | Requests per minute per session |
| `MCP_CONFIRM_DESTRUCTIVE` | `true` | Require confirmation for destructive actions |
| `MCP_MAX_RESULT_SIZE` | `50000` | Max characters in a single tool response (prevents context window overflow) |
| `MCP_AUDIT_LOG` | `true` | Log all MCP tool invocations |

### 15.7 Client Configuration Examples

**Claude Desktop (`claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "bigbluebam": {
      "url": "https://app.bigbluebam.io/mcp/sse",
      "headers": {
        "Authorization": "Bearer bbam_your_api_key_here"
      }
    }
  }
}
```

**Claude Code (`.claude/settings.json`):**
```json
{
  "mcpServers": {
    "bigbluebam": {
      "command": "npx",
      "args": ["@bigbluebam/mcp-server", "--api-url", "http://localhost:4000", "--api-key", "bbam_dev_key"]
    }
  }
}
```

**Local Docker (stdio transport):**
```json
{
  "mcpServers": {
    "bigbluebam": {
      "command": "docker",
      "args": ["exec", "-i", "bigbluebam-mcp", "node", "dist/mcp-stdio.js"],
      "env": {
        "BIGBLUEBAM_API_KEY": "bbam_your_key"
      }
    }
  }
}
```

---

## 16. Integrations

### 16.1 Third-Party Integrations

| Integration | Method | Scope |
|---|---|---|
| **GitHub / GitLab** | OAuth app + webhooks | Link commits/PRs to tasks via `#BBB-xxx` in commit messages. Auto-transition tasks on PR merge. |
| **Slack** | Bot + slash commands | `/bigbluebam create [title]` to create tasks. Channel notifications for project events. |
| **Figma** | Embed plugin | Paste Figma URLs in task descriptions for live embeds. |
| **Google Calendar** | OAuth + API | Sync task due dates as calendar events. |
| **Zapier / Make** | REST API + webhooks | General-purpose automation glue. |
| **CSV Import/Export** | Built-in | Bulk task import from CSV. Full project export for migration. |

---

## 17. Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `N` | New task (in focused column or default) |
| `S` | Open search |
| `F` | Open filter panel |
| `/` | Focus quick search |
| `1-9` | Switch to phase column by position |
| `J / K` | Navigate cards (down / up) |
| `H / L` | Move focus between columns (left / right) |
| `Enter` | Open focused card detail |
| `Escape` | Close detail / cancel action |
| `Space` | Toggle card selection (multi-select) |
| `M` | Move selected card (opens phase picker) |
| `A` | Assign selected card (opens user picker) |
| `P` | Change priority of selected card |
| `D` | Set due date on selected card |
| `Cmd+K` | Command palette (fuzzy search for any action) |
| `Cmd+Shift+P` | Switch project |
| `?` | Show keyboard shortcuts overlay |

---

## 18. Performance Targets

| Metric | Target |
|---|---|
| Board initial render (50 tasks) | < 500ms |
| Board initial render (200 tasks) | < 1.5s (with virtualization) |
| Card drag-and-drop latency (visual) | < 16ms (60fps) |
| Optimistic update round-trip | < 200ms P95 |
| WebSocket event delivery | < 100ms P95 |
| Task detail open (drawer animation) | < 300ms |
| Full-text search results | < 500ms |
| Lighthouse Performance score | > 90 |
| Largest Contentful Paint | < 2.0s |
| Cumulative Layout Shift | < 0.05 |
| Time to Interactive | < 3.0s |

### Optimization Strategies

- **Virtual scrolling** for columns with > 30 cards (using `@tanstack/virtual`).
- **Pagination** of "Done" columns (load last 20, "Show more" trigger).
- **React.memo** on card components with stable keys.
- **Layout animation batching** — Motion `layout` props with `layoutDependency` to prevent unnecessary recalculations.
- **Image lazy loading** — avatars and attachment thumbnails use `loading="lazy"` and intersection observer.
- **Service worker** for offline card viewing and queued mutations.
- **Database query optimization** — composite indexes on all board-rendering queries; `EXPLAIN ANALYZE` budget for any query touching the hot path.
- **Redis caching** — board state cached with 10s TTL; invalidated on any write via pubsub.

---

## 19. Security

| Domain | Implementation |
|---|---|
| **Transport** | TLS 1.3 everywhere. HSTS headers. |
| **CSRF** | Double-submit cookie pattern or SameSite cookies. |
| **XSS** | CSP headers. Tiptap output sanitized with DOMPurify before render. |
| **SQL Injection** | Parameterized queries via Drizzle ORM. No raw SQL in application code. |
| **Rate Limiting** | Redis-backed sliding window. Per-user and per-IP. |
| **File Upload** | Content-type validation, max size (25MB), virus scanning (ClamAV or cloud service), storage in isolated S3 bucket with no public access. |
| **Row-Level Security** | PostgreSQL RLS policies ensure queries never leak cross-org data even if application logic fails. |
| **Audit Trail** | `activity_log` is append-only. No deletes. Retained for 2 years minimum. |
| **Secrets Management** | Environment variables via Doppler, Vault, or cloud-native secrets. Never in code or config files. |
| **Dependency Scanning** | Automated via GitHub Dependabot / Snyk. CI fails on critical CVEs. |

---

## 20. Deployment & Infrastructure

BigBlueBam is **Docker-native from day one.** The minimal deployment is a single `docker compose up` that runs the entire stack on one machine. The architecture is designed so that every service can be independently scaled out to a distributed cluster without changing application code — only infrastructure configuration changes.

### 20.1 Container Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Docker Compose Stack                             │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │   frontend    │  │     api      │  │  mcp-server  │  │   worker   │ │
│  │  nginx +      │  │  Fastify     │  │  MCP SDK     │  │  BullMQ    │ │
│  │  React SPA    │  │  + WebSocket │  │  (sidecar)   │  │  processor │ │
│  │  :80/:443     │  │  :4000       │  │  :3001       │  │  (no port) │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                  │                  │                │        │
│  ┌──────▼──────────────────▼──────────────────▼────────────────▼──────┐ │
│  │                    Internal Docker Network                         │ │
│  └──────┬──────────────────┬──────────────────────────────────┬──────┘ │
│         │                  │                                  │        │
│  ┌──────▼───────┐  ┌──────▼───────┐                  ┌───────▼──────┐ │
│  │  postgres     │  │    redis     │                  │    minio     │ │
│  │  PostgreSQL   │  │  Redis 7     │                  │  S3-compat   │ │
│  │  :5432        │  │  :6379       │                  │  :9000/:9001 │ │
│  │  Vol: pgdata  │  │  Vol: redis  │                  │  Vol: minio  │ │
│  └──────────────┘  └──────────────┘                  └──────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 20.2 Service Definitions

| Service | Image | Role | Resource Defaults | Scaling Unit |
|---|---|---|---|---|
| **frontend** | `bigbluebam/frontend` | nginx serving the React SPA + reverse proxy to API | 128MB RAM, 0.25 CPU | Horizontal (CDN offload in production) |
| **api** | `bigbluebam/api` | Fastify REST API + WebSocket server | 512MB RAM, 1 CPU | Horizontal (stateless; WebSocket via Redis pubsub) |
| **mcp-server** | `bigbluebam/mcp-server` | MCP protocol server (SSE + Streamable HTTP) | 256MB RAM, 0.5 CPU | Horizontal (stateless) |
| **worker** | `bigbluebam/worker` | BullMQ background job processor (email, notifications, exports, analytics rollups) | 512MB RAM, 1 CPU | Horizontal (BullMQ concurrency) |
| **postgres** | `postgres:16-alpine` | Primary database | 1GB RAM, 1 CPU | Vertical → managed service |
| **redis** | `redis:7-alpine` | Cache, sessions, pubsub, job queue | 256MB RAM, 0.25 CPU | Vertical → managed service |
| **minio** | `minio/minio` | S3-compatible object storage for attachments | 256MB RAM, 0.25 CPU | Replace with S3/R2 in cloud |

### 20.3 Docker Compose — Minimal Deployment

```yaml
# docker-compose.yml
version: "3.9"

x-common: &common
  restart: unless-stopped
  logging:
    driver: "json-file"
    options:
      max-size: "10m"
      max-file: "3"

services:
  # ─── Data Layer ───────────────────────────────────────────────
  postgres:
    <<: *common
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: bigbluebam
      POSTGRES_USER: ${DB_USER:-bigbluebam}
      POSTGRES_PASSWORD: ${DB_PASSWORD:?Set DB_PASSWORD in .env}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./infra/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    ports:
      - "${DB_PORT:-5432}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-bigbluebam}"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - backend

  redis:
    <<: *common
    image: redis:7-alpine
    command: >
      redis-server
      --requirepass ${REDIS_PASSWORD:?Set REDIS_PASSWORD in .env}
      --maxmemory 256mb
      --maxmemory-policy allkeys-lru
      --appendonly yes
    volumes:
      - redisdata:/data
    ports:
      - "${REDIS_PORT:-6379}:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - backend

  minio:
    <<: *common
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-bigbluebam}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?Set MINIO_ROOT_PASSWORD in .env}
    volumes:
      - miniodata:/data
    ports:
      - "${MINIO_API_PORT:-9000}:9000"
      - "${MINIO_CONSOLE_PORT:-9001}:9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks:
      - backend

  # ─── Application Layer ────────────────────────────────────────
  api:
    <<: *common
    build:
      context: .
      dockerfile: ./apps/api/Dockerfile
      target: production
    image: bigbluebam/api:${VERSION:-latest}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 4000
      DATABASE_URL: postgres://${DB_USER:-bigbluebam}:${DB_PASSWORD}@postgres:5432/bigbluebam?sslmode=disable
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/0
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: ${MINIO_ROOT_USER:-bigbluebam}
      S3_SECRET_KEY: ${MINIO_ROOT_PASSWORD}
      S3_BUCKET: bigbluebam-attachments
      S3_REGION: us-east-1
      SESSION_SECRET: ${SESSION_SECRET:?Set SESSION_SECRET in .env}
      CORS_ORIGIN: ${CORS_ORIGIN:-http://localhost}
      LOG_LEVEL: ${LOG_LEVEL:-info}
      # Auth providers (optional)
      OAUTH_GOOGLE_CLIENT_ID: ${OAUTH_GOOGLE_CLIENT_ID:-}
      OAUTH_GOOGLE_CLIENT_SECRET: ${OAUTH_GOOGLE_CLIENT_SECRET:-}
      OAUTH_GITHUB_CLIENT_ID: ${OAUTH_GITHUB_CLIENT_ID:-}
      OAUTH_GITHUB_CLIENT_SECRET: ${OAUTH_GITHUB_CLIENT_SECRET:-}
      # Email (optional — falls back to log-only if not set)
      SMTP_HOST: ${SMTP_HOST:-}
      SMTP_PORT: ${SMTP_PORT:-587}
      SMTP_USER: ${SMTP_USER:-}
      SMTP_PASSWORD: ${SMTP_PASSWORD:-}
      EMAIL_FROM: ${EMAIL_FROM:-noreply@bigbluebam.io}
    ports:
      - "${API_PORT:-4000}:4000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/health"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks:
      - backend
      - frontend

  mcp-server:
    <<: *common
    build:
      context: .
      dockerfile: ./apps/mcp-server/Dockerfile
      target: production
    image: bigbluebam/mcp-server:${VERSION:-latest}
    depends_on:
      api:
        condition: service_healthy
    environment:
      NODE_ENV: production
      MCP_PORT: 3001
      MCP_TRANSPORT: streamable-http
      MCP_AUTH_REQUIRED: "true"
      API_INTERNAL_URL: http://api:4000
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/1
      LOG_LEVEL: ${LOG_LEVEL:-info}
    ports:
      - "${MCP_PORT:-3001}:3001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks:
      - backend
      - frontend

  worker:
    <<: *common
    build:
      context: .
      dockerfile: ./apps/worker/Dockerfile
      target: production
    image: bigbluebam/worker:${VERSION:-latest}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://${DB_USER:-bigbluebam}:${DB_PASSWORD}@postgres:5432/bigbluebam?sslmode=disable
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/0
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: ${MINIO_ROOT_USER:-bigbluebam}
      S3_SECRET_KEY: ${MINIO_ROOT_PASSWORD}
      S3_BUCKET: bigbluebam-attachments
      SMTP_HOST: ${SMTP_HOST:-}
      SMTP_PORT: ${SMTP_PORT:-587}
      SMTP_USER: ${SMTP_USER:-}
      SMTP_PASSWORD: ${SMTP_PASSWORD:-}
      EMAIL_FROM: ${EMAIL_FROM:-noreply@bigbluebam.io}
      WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-5}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    # No ports — worker only consumes from Redis queue
    networks:
      - backend

  frontend:
    <<: *common
    build:
      context: .
      dockerfile: ./apps/frontend/Dockerfile
      target: production
    image: bigbluebam/frontend:${VERSION:-latest}
    depends_on:
      api:
        condition: service_healthy
    ports:
      - "${HTTP_PORT:-80}:80"
      - "${HTTPS_PORT:-443}:443"
    volumes:
      - ./infra/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./infra/nginx/certs:/etc/nginx/certs:ro      # Mount TLS certs for HTTPS
    networks:
      - frontend

  # ─── Database Migrations (run once) ──────────────────────────
  migrate:
    build:
      context: .
      dockerfile: ./apps/api/Dockerfile
      target: production
    image: bigbluebam/api:${VERSION:-latest}
    command: ["node", "dist/migrate.js"]
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://${DB_USER:-bigbluebam}:${DB_PASSWORD}@postgres:5432/bigbluebam?sslmode=disable
    restart: "no"
    networks:
      - backend

volumes:
  pgdata:
    driver: local
  redisdata:
    driver: local
  miniodata:
    driver: local

networks:
  backend:
    driver: bridge
  frontend:
    driver: bridge
```

### 20.4 Environment Configuration (`.env.example`)

```bash
# ─── Required ────────────────────────────────────────────────
DB_PASSWORD=change-me-in-production
REDIS_PASSWORD=change-me-in-production
MINIO_ROOT_PASSWORD=change-me-in-production
SESSION_SECRET=generate-with-openssl-rand-hex-32

# ─── Optional Overrides ─────────────────────────────────────
# DB_USER=bigbluebam
# DB_PORT=5432
# REDIS_PORT=6379
# API_PORT=4000
# MCP_PORT=3001
# HTTP_PORT=80
# HTTPS_PORT=443
# LOG_LEVEL=info
# WORKER_CONCURRENCY=5
# CORS_ORIGIN=https://your-domain.com
# VERSION=1.2.0

# ─── OAuth Providers (optional) ──────────────────────────────
# OAUTH_GOOGLE_CLIENT_ID=
# OAUTH_GOOGLE_CLIENT_SECRET=
# OAUTH_GITHUB_CLIENT_ID=
# OAUTH_GITHUB_CLIENT_SECRET=

# ─── Email / SMTP (optional — logs only if not set) ─────────
# SMTP_HOST=smtp.resend.com
# SMTP_PORT=587
# SMTP_USER=resend
# SMTP_PASSWORD=re_xxxxx
# EMAIL_FROM=noreply@bigbluebam.io
```

### 20.5 Dockerfile Strategy (Multi-Stage)

All application Dockerfiles use the same multi-stage pattern:

```dockerfile
# apps/api/Dockerfile
# ─── Stage 1: Dependencies ──────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN corepack enable && pnpm install --frozen-lockfile --prod=false

# ─── Stage 2: Build ─────────────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm --filter @bigbluebam/api build
RUN pnpm --filter @bigbluebam/shared build

# ─── Stage 3: Production ────────────────────────────────────
FROM node:22-alpine AS production
RUN apk add --no-cache tini curl
WORKDIR /app
ENV NODE_ENV=production

# Copy only production dependencies + built artifacts
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/packages/shared/dist ./node_modules/@bigbluebam/shared/dist

# Non-root user
RUN addgroup -S bbam && adduser -S bbam -G bbam
USER bbam

EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
```

**Key practices:**
- **Alpine base** for minimal image size (~150MB final).
- **Multi-stage** to exclude dev dependencies, source, and build tooling from production image.
- **`tini` init process** to handle PID 1 signal forwarding and zombie reaping.
- **Non-root user** (`bbam`) for security.
- **`curl` included** for healthcheck probes.
- **Frozen lockfile** to ensure reproducible builds.

### 20.6 Quick Start Commands

```bash
# First time setup
cp .env.example .env
# Edit .env with your secrets

# Start everything (builds images if needed)
docker compose up -d

# Run database migrations
docker compose run --rm migrate

# Create initial admin user
docker compose exec api node dist/cli.js create-admin \
  --email admin@example.com \
  --password your-password \
  --org "My Organization"

# View logs
docker compose logs -f api mcp-server worker

# Stop everything
docker compose down

# Stop and destroy all data (fresh start)
docker compose down -v
```

### 20.7 Scaling Path — Minimal to Distributed

The architecture is designed for incremental scale-out. Each step is independent and can be applied as bottlenecks appear.

#### Tier 1: Single Machine (Docker Compose)
- **Capacity:** 1–20 concurrent users, ~10k tasks.
- **Hardware:** 4 CPU, 8GB RAM, 50GB SSD.
- **What you get:** Everything in one `docker compose up`. All services on one host.
- **Scaling lever:** Increase `WORKER_CONCURRENCY`, add RAM for PostgreSQL.

#### Tier 2: Managed Data Layer
- **Trigger:** Database or Redis becoming the bottleneck; need for automated backups and HA.
- **Change:** Replace `postgres` and `redis` containers with managed services.
  - **PostgreSQL →** AWS RDS, GCP Cloud SQL, Supabase, Neon, or a dedicated PostgreSQL host.
  - **Redis →** AWS ElastiCache, GCP Memorystore, Upstash, or Redis Cloud.
  - **MinIO →** AWS S3, GCP Cloud Storage, or Cloudflare R2.
- **How:** Update `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT` in `.env`. Remove the `postgres`, `redis`, `minio` services from `docker-compose.yml`. No code changes.

#### Tier 3: Horizontal API Scaling
- **Trigger:** API response times increasing under load; WebSocket connection limits.
- **Change:** Run multiple `api` replicas behind a load balancer.

```yaml
# docker-compose.prod.yml (override file)
services:
  api:
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: "1.0"
          memory: 512M

  nginx-lb:
    image: nginx:alpine
    volumes:
      - ./infra/nginx/lb.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "443:443"
    depends_on:
      - api
```

- **WebSocket affinity:** nginx `ip_hash` or `sticky` sessions ensure WebSocket upgrades hit the same backend. Redis pubsub ensures events propagate across all API instances regardless.
- **MCP server** scales the same way — stateless, behind the same or separate LB.

#### Tier 4: Container Orchestration (Kubernetes / Docker Swarm)
- **Trigger:** Need for auto-scaling, rolling deployments, self-healing, multi-node cluster.
- **Change:** Migrate from Docker Compose to Kubernetes manifests or Docker Swarm stack files.

**Kubernetes deployment sketch:**
```
Namespace: bigbluebam
├── Deployment: api (3 replicas, HPA on CPU)
├── Deployment: mcp-server (2 replicas, HPA on connections)
├── Deployment: worker (2 replicas, scaled by queue depth)
├── Deployment: frontend (2 replicas, served via Ingress)
├── Service: api-svc (ClusterIP, headless for WebSocket)
├── Service: mcp-svc (ClusterIP)
├── Service: frontend-svc (ClusterIP)
├── Ingress: bigbluebam-ingress (nginx-ingress or Traefik)
│   ├── app.bigbluebam.io → frontend-svc
│   ├── app.bigbluebam.io/api/* → api-svc
│   ├── app.bigbluebam.io/ws → api-svc (WebSocket upgrade)
│   └── app.bigbluebam.io/mcp/* → mcp-svc
├── CronJob: analytics-rollup (daily)
├── ConfigMap: bigbluebam-config
├── Secret: bigbluebam-secrets
└── PersistentVolumeClaim: (only if self-hosting PostgreSQL)
```

**Helm chart** provided in `infra/helm/bigbluebam/` for templated deployments across environments.

#### Tier 5: Edge & CDN (Global Scale)
- **Trigger:** Global user base, latency requirements.
- **Change:** Static frontend assets served via CDN (Cloudflare, CloudFront). API and MCP remain centralized or deployed to multiple regions with a global load balancer. PostgreSQL read replicas for read-heavy reporting queries.

### 20.8 Backup & Disaster Recovery

| Component | Strategy | Frequency | Retention |
|---|---|---|---|
| **PostgreSQL** | `pg_dump` to S3 (or managed service snapshots) | Every 6 hours | 30 days |
| **Redis** | AOF persistence + RDB snapshots | Continuous AOF, hourly RDB | 7 days |
| **MinIO / S3** | Cross-region replication (if cloud) or rsync to backup host | Continuous | Indefinite |
| **Docker volumes** | Volume backup script (`docker run --rm -v pgdata:/data -v /backup:/backup alpine tar czf /backup/pgdata.tar.gz /data`) | Daily | 14 days |

**Recovery procedure documented in `infra/docs/disaster-recovery.md`:**
1. Restore PostgreSQL from latest dump.
2. Redis rebuilds cache on startup (session loss is acceptable; users re-login).
3. MinIO/S3 data restored from replica or backup.
4. `docker compose up -d` — services reconnect automatically.
5. Run `node dist/cli.js verify-integrity` to check data consistency.

**RTO (Recovery Time Objective):** < 1 hour for Tier 1–2; < 15 minutes for Tier 3+ with orchestration.
**RPO (Recovery Point Objective):** < 6 hours (backup interval).

### 20.9 Environments

| Environment | Method | URL Pattern |
|---|---|---|
| **Local dev** | `docker compose -f docker-compose.yml -f docker-compose.dev.yml up` | `localhost:3000` (Vite HMR) / `localhost:4000` (API) |
| **CI/Test** | Ephemeral Docker Compose in GitHub Actions | Internal only |
| **Preview** | Per-PR deploy via Render/Railway or `docker compose` on a preview server | `pr-{number}.preview.bigbluebam.io` |
| **Staging** | Docker Compose on dedicated server, or K8s staging namespace | `staging.bigbluebam.io` |
| **Production** | Docker Compose (Tier 1–2) or Kubernetes (Tier 3+) | `app.bigbluebam.io` |

### 20.10 CI/CD Pipeline

```
┌────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Push  │───▶│  Lint &   │───▶│  Unit &  │───▶│  Build   │───▶│  Deploy  │
│  / PR  │    │ Typecheck │    │ Int Test │    │  Images  │    │          │
└────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
                                    │                              │
                              Docker Compose                  PR: Preview
                              ephemeral stack                 main: Staging
                              for integration                 tag: Production
                              tests
```

- **Source control:** GitHub monorepo (Turborepo).
- **CI:** GitHub Actions.
  - On **every push:** lint (ESLint + Biome), typecheck (tsc --noEmit), unit tests (Vitest).
  - On **PR:** spin up ephemeral Docker Compose stack, run integration tests (API + DB), tear down.
  - On **merge to main:** build production Docker images, push to GHCR (`ghcr.io/bigblueceiling/bigbluebam/*`), deploy to staging.
  - On **tag (`v*`):** promote staging images to production, run migrations, deploy with zero-downtime rolling update.
- **Image registry:** GitHub Container Registry (GHCR). Images tagged with git SHA + semver.
- **Rollback:** `docker compose pull && docker compose up -d` with previous image tag. Migration rollback scripts in `apps/api/migrations/rollback/`.

### 20.11 Monitoring & Observability

| Layer | Tool | Notes |
|---|---|---|
| **Error tracking** | Sentry (client + API + worker) | Source maps uploaded in CI |
| **APM / Traces** | Grafana Cloud (OTLP) or Datadog | OpenTelemetry SDK in API + worker |
| **Metrics** | Prometheus (scraped from `/metrics` on each service) | Grafana dashboards |
| **Logging** | Structured JSON → Loki (via Docker log driver or Promtail) | Correlated via `request_id` |
| **Uptime** | Betterstack or Checkly | External pings to `/health` |
| **Analytics** | PostHog (self-hosted Docker or cloud) | Product analytics, feature flags |

**Health endpoints** on every service:
- `GET /health` — basic liveness (returns 200 if process is running).
- `GET /health/ready` — readiness (returns 200 only if DB and Redis connections are active).
- `GET /metrics` — Prometheus-format metrics (request count, latency histograms, active WebSocket connections, queue depth).

---

## 21. Accessibility (a11y)

| Requirement | Implementation |
|---|---|
| **WCAG 2.1 AA** | Minimum compliance target |
| **Keyboard navigation** | Full board navigation (see Section 17). Focus management for drawers, dialogs, dropdowns. |
| **Screen reader support** | ARIA live regions for real-time updates. Role attributes on board (list/listitem). Drag-and-drop announced via aria-live. |
| **Color contrast** | All text meets 4.5:1 contrast ratio. Status colors are never the sole indicator — always paired with icon or text. |
| **Motion sensitivity** | Respect `prefers-reduced-motion`. Disable springs, use instant transitions. Cards snap instead of animate. |
| **Focus indicators** | Visible focus rings on all interactive elements. Custom-styled to match design system. |
| **Zoom support** | UI functional at 200% zoom. No horizontal scrolling at 150%. |

---

## 22. Internationalization (i18n)

| Aspect | Implementation |
|---|---|
| **Framework** | react-intl or next-intl (ICU message format) |
| **Initial languages** | English (en-US). Structure supports any LTR/RTL language. |
| **Date/time** | Intl.DateTimeFormat with user's locale and timezone. All dates stored as UTC; displayed in user's `timezone` preference. |
| **Number formatting** | Intl.NumberFormat for story points, percentages, velocities. |
| **RTL support** | CSS logical properties (margin-inline-start instead of margin-left). Tailwind's RTL plugin. Board columns reverse for RTL. |
| **Pluralization** | ICU plural rules in message strings. |

---

## 23. Theming & Design System

### 21.1 Design Tokens

All visual properties are expressed as CSS custom properties / Tailwind theme tokens:

- **Colors:** Radix Colors for semantic scales (e.g., `--color-primary-9`, `--color-danger-11`). Each scale has 12 steps for automatic light/dark mode support.
- **Typography:** System font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ...`). Four weights (400, 500, 600, 700). Five sizes (xs, sm, base, lg, xl).
- **Spacing:** 4px base unit. Scale: 0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24.
- **Radius:** sm (4px), md (6px), lg (8px), xl (12px), full (9999px).
- **Shadows:** Three levels (sm, md, lg) for elevation. Used on cards, drawers, dropdowns.
- **Motion tokens:** `--duration-fast: 100ms`, `--duration-normal: 200ms`, `--duration-slow: 300ms`. Spring configs exported as JS constants for Motion.

### 21.2 Dark Mode

- Toggle: system preference (auto), light, dark. Persisted per user.
- Implementation: Radix Colors provide automatic dark variants. Tailwind's `dark:` variant for overrides.
- Cards: subtle surface elevation differences (slightly lighter in dark mode) to maintain visual hierarchy without heavy borders.

### 21.3 Compact Mode

A user preference that reduces card size and spacing for power users who want maximum density. Specifically: smaller font size on cards, reduced padding, hidden labels (show as colored dots only), single-line metadata row.

---

## 24. Data Export & Migration

| Format | Scope | Trigger |
|---|---|---|
| **CSV** | All tasks in project | Manual export from project settings |
| **JSON** | Full project (tasks, sprints, phases, config) | Manual export or API |
| **PDF** | Sprint report | Generated on sprint close or on demand |
| **Jira Import** | Projects, issues, sprints, comments, attachments | CSV + Jira REST API connector |
| **Trello Import** | Boards, lists, cards | Trello JSON export file |
| **Asana Import** | Projects, tasks, subtasks | Asana CSV export |

---

## 25. Billing & Plans (If SaaS)

| Plan | Price | Limits |
|---|---|---|
| **Free** | $0 | 3 projects, 5 users, 1,000 tasks, no custom fields |
| **Team** | $8/user/month | Unlimited projects, 50 users, custom fields, integrations, priority support |
| **Business** | $14/user/month | SAML SSO, advanced analytics, audit logs, custom roles, SLA |
| **Enterprise** | Custom | Self-hosted option, dedicated support, custom integrations, compliance certifications |

Payment processing: Stripe (subscriptions, invoicing, metered billing for overages).

---

## 26. Development Phases

### Phase 1 — Foundation (Weeks 1–6)
- Monorepo scaffolding (Turborepo, CI, linting, type-checking)
- Docker Compose stack: postgres, redis, minio, api, frontend, worker, migrate
- Multi-stage Dockerfiles for all services
- Health endpoints, structured logging, OpenTelemetry instrumentation
- Auth (email/password, OAuth, sessions)
- Organization + User CRUD
- API key management (create, revoke, scope)
- Project CRUD + membership
- Phase configuration
- Task CRUD (basic fields)
- Board view with drag-and-drop (single user)
- Task detail drawer

### Phase 2 — Sprint Engine (Weeks 7–10)
- Sprint CRUD + lifecycle (plan → active → complete)
- Carry-forward ceremony UI
- Sprint scoping (backlog → sprint assignment)
- Sprint selector on board
- Task state configuration
- List view

### Phase 3 — Collaboration & Realtime (Weeks 11–14)
- WebSocket infrastructure (Redis pubsub for multi-instance)
- Real-time board sync
- Presence indicators
- Comments (rich text)
- Attachments (presigned upload to MinIO/S3)
- Activity log
- Notifications (in-app via WebSocket)

### Phase 4 — MCP Server (Weeks 15–17)
- MCP server sidecar container with Streamable HTTP + SSE transports
- Auth middleware (API key validation, scope enforcement)
- Core tool registry: list_projects, get_board, search_tasks, create_task, update_task, move_task
- Sprint tools: list_sprints, create_sprint, start_sprint, complete_sprint
- Comment and member tools
- Destructive action confirmation flow (confirm_action + action tokens)
- MCP Resources (bigbluebam:// URI scheme)
- MCP Prompts (sprint_planning, daily_standup, sprint_retrospective, task_breakdown)
- Rate limiting, audit logging, output size capping
- Client configuration docs (Claude Desktop, Claude Code, stdio)
- Integration tests against the full Docker Compose stack

### Phase 5 — Power Features (Weeks 18–21)
- Labels, epics, subtasks
- Custom fields
- Swimlanes
- Filtering + saved views
- Keyboard shortcuts
- Command palette
- Dark mode + compact mode
- Time tracking endpoints + UI

### Phase 6 — Reporting & Integrations (Weeks 22–25)
- Sprint reports
- Burndown / velocity / CFD charts
- Email notifications + digest (worker jobs)
- GitHub integration (commit linking, PR auto-transitions)
- Slack integration (bot + slash commands)
- CSV/JSON import/export
- Webhook system (outgoing, HMAC-signed, with delivery history)
- Reporting tools in MCP server (velocity, burndown, CFD)

### Phase 7 — Scale & Polish (Weeks 26–30)
- Accessibility audit + fixes
- Performance optimization (virtualization, Redis caching, lazy loading)
- Timeline/Gantt view
- Calendar view
- My Work dashboard
- Onboarding flow (guided project setup)
- Docker Compose production hardening (resource limits, TLS, backup scripts)
- Kubernetes Helm chart (`infra/helm/bigbluebam/`)
- Horizontal scaling validation (multi-replica API + MCP with Redis pubsub)
- Disaster recovery runbook and testing
- Documentation site (API reference, MCP tool catalog, deployment guide)
- Public launch

---

## 27. Open Questions & Future Considerations

1. **AI features:** Auto-suggest story point estimates based on historical data? AI-generated sprint goal summaries? Natural language task creation ("create a high-priority bug for the login page crash, assign to Eddie, due Friday")?
2. **Mobile app:** React Native or responsive web only for v1?
3. **Offline support:** Service worker with IndexedDB for offline board viewing and queued mutations? Scope for v1 or later?
4. **Multi-tenancy model:** Shared database with RLS (v1) vs. database-per-tenant (scale trigger)?
5. **Plugin system:** Allow third-party extensions to add custom fields, views, or automations? API-first approach enables this later.
6. **Automations engine:** "When task moves to Done, assign reviewer" style rules? Could leverage a simple rule engine (event → condition → action) stored as JSON.
7. **Approval workflows:** Require sign-off before a task can move to certain phases? Gating mechanism on phase transitions.
8. **Resource planning:** Capacity allocation per user per sprint based on availability calendars? Integrates with the estimation system.

---

## See Also

- **[Design Document v2 Addendum](BigBlueBam_Design_Document_v2.md)** — Additional features added post-v1: data import (Jira/Trello/CSV/GitHub), enhanced reporting & dashboards, communication integrations (Slack/email/iCal), developer workflow (Git linking, branch suggestions), task templates & duplication, comment reactions, saved views, multi-org support, PWA, audit log viewer.

---

*End of Design Document*
