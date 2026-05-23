# BigBlueBam Helpdesk — Design Document v1.0

**Author:** Big Blue Ceiling Prototyping & Fabrication, LLC
**Date:** April 3, 2026
**Status:** Draft — Awaiting Approval

---

## 1. Overview

BigBlueBam Helpdesk is a user-facing ticketing portal that runs alongside BigBlueBam. External users (customers, clients, end-users) submit support tickets through a clean, simple interface. Each ticket automatically creates a corresponding Task in BigBlueBam, giving engineering teams a unified view of both internal work and customer issues.

The two systems share a database but maintain separate authentication — helpdesk users have their own accounts, distinct from BigBlueBam org members. Communication flows bidirectionally: clients see status updates and public replies, while developers see internal comments that remain private.

---

## 2. Key Principles

1. **Separate but connected.** Helpdesk users never see BigBlueBam internals. Engineers see everything in one place.
2. **Simple for clients.** Minimal UI, no project management concepts exposed. Submit ticket, track status, reply.
3. **Automatic task linkage.** Every ticket creates a BBB Task. Moving the task updates the ticket. No manual sync.
4. **Configurable trust level.** Admins choose whether to require email verification, allow anonymous submissions, or restrict to approved domains.
5. **Shared infrastructure.** Same PostgreSQL, Redis, and Docker network. No separate databases.

---

## 3. Architecture

```
┌───────────────────────────────────────────┐
│          Helpdesk Portal (SPA)            │
│  React 19 · TailwindCSS v4 · Radix UI    │
│  Served by nginx at /helpdesk/ on :80                 │
└──────────────────┬────────────────────────┘
                   │ HTTPS
┌──────────────────▼────────────────────────┐
│    Single nginx container (port 80)       │
│    /b3/          → BigBlueBam SPA         │
│    /helpdesk/    → Helpdesk SPA           │
│    /helpdesk/api/→ helpdesk-api :4001     │
│    /b3/api/      → BBB API :4000          │
│    /mcp/         → MCP server :3001       │
│    /files/       → MinIO :9000            │
└──────────┬────────────────────────────────┘
           │ REST
┌──────────▼────────────────────────────────┐
│     Docker Container: helpdesk-api        │
│     Fastify REST server :4001 (internal)  │
│     Shares DB with BigBlueBam API         │
└──────────┬────────────────────────────────┘
           │
┌──────────▼──────────┬─────────────────────┐
│   PostgreSQL :5432  │   Redis :6379       │
│   (shared)          │   (shared)          │
└─────────────────────┴─────────────────────┘
```

### 3.1 Deployment Options

| Deployment | Helpdesk Frontend | Helpdesk API | Notes |
|---|---|---|---|
| **Docker Compose** | nginx serves at /helpdesk/ (shared port 80) | Fastify on :4001 (internal) | Default. Added to existing docker-compose.yml |
| **Dev mode** | Vite on :5174 | tsx watch on :4001 | Via docker-compose.dev.yml override |
| **Standalone** | Any static host | Any Node.js host | Point `HELPDESK_API_URL` and `DATABASE_URL` to BigBlueBam's DB |

---

## 4. Data Model

### 4.1 New Tables

#### `helpdesk_users`

Separate from BigBlueBam users. These are external clients/customers.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `email` | VARCHAR(320) | UNIQUE, NOT NULL | |
| `display_name` | VARCHAR(100) | NOT NULL | |
| `password_hash` | TEXT | NOT NULL | Argon2id |
| `email_verified` | BOOLEAN | DEFAULT false | |
| `email_verification_token` | TEXT | NULLABLE | Random token sent via email |
| `email_verification_sent_at` | TIMESTAMPTZ | NULLABLE | |
| `is_active` | BOOLEAN | DEFAULT true | Admin can disable |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT now() | |

#### `helpdesk_sessions`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | TEXT | PK | nanoid |
| `user_id` | UUID | FK → helpdesk_users.id | |
| `expires_at` | TIMESTAMPTZ | NOT NULL | |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

#### `tickets`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `ticket_number` | SERIAL | UNIQUE | Auto-incrementing, e.g., #1042 |
| `helpdesk_user_id` | UUID | FK → helpdesk_users.id | The client who submitted |
| `task_id` | UUID | FK → tasks.id, NULLABLE | Linked BigBlueBam task (created automatically) |
| `project_id` | UUID | FK → projects.id | Which BBB project receives the task |
| `subject` | VARCHAR(500) | NOT NULL | Ticket title (becomes task title) |
| `description` | TEXT | NOT NULL | Initial description (becomes task description) |
| `status` | VARCHAR(50) | DEFAULT 'open' | open, in_progress, waiting_on_customer, resolved, closed |
| `priority` | VARCHAR(20) | DEFAULT 'medium' | low, medium, high, critical (set by engineers) |
| `category` | VARCHAR(100) | NULLABLE | e.g., "Bug Report", "Feature Request", "Account Issue" |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT now() | |
| `resolved_at` | TIMESTAMPTZ | NULLABLE | |
| `closed_at` | TIMESTAMPTZ | NULLABLE | |

#### `ticket_messages`

Bidirectional communication visible to the client. Distinct from BBB task comments (which are developer-only).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK, default gen_random_uuid() | |
| `ticket_id` | UUID | FK → tickets.id | |
| `author_type` | VARCHAR(20) | NOT NULL | 'client' or 'agent' |
| `author_id` | UUID | NOT NULL | helpdesk_user.id if client, users.id if agent |
| `author_name` | VARCHAR(100) | NOT NULL | Denormalized for display |
| `body` | TEXT | NOT NULL | Message content |
| `is_internal` | BOOLEAN | DEFAULT false | If true, only visible to agents (not shown in helpdesk portal) |
| `created_at` | TIMESTAMPTZ | DEFAULT now() | |

#### `helpdesk_settings`

Global configuration stored per-organization.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | UUID | PK | |
| `org_id` | UUID | FK → organizations.id, UNIQUE | |
| `require_email_verification` | BOOLEAN | DEFAULT false | |
| `allowed_email_domains` | TEXT[] | DEFAULT '{}' | If non-empty, only these domains can register |
| `default_project_id` | UUID | FK → projects.id, NULLABLE | Where tickets create tasks |
| `default_phase_id` | UUID | FK → phases.id, NULLABLE | Which phase new tasks land in (e.g., "Triage") |
| `default_priority` | VARCHAR(20) | DEFAULT 'medium' | |
| `categories` | JSONB | DEFAULT '[]' | Array of category strings for the submit form |
| `welcome_message` | TEXT | NULLABLE | Shown on the helpdesk portal landing page |
| `auto_close_days` | INT | DEFAULT 0 | Auto-close resolved tickets after N days (0 = disabled) |
| `notify_on_status_change` | BOOLEAN | DEFAULT true | Email client when ticket status changes |
| `notify_on_agent_reply` | BOOLEAN | DEFAULT true | Email client when an agent replies |

### 4.2 Relationship to BigBlueBam

```
helpdesk_users ──< tickets ──> tasks (BigBlueBam)
                      │
                      └──< ticket_messages
                      
organizations ──< helpdesk_settings
```

When a ticket is created:
1. A new Task is created in the configured default project
2. `tickets.task_id` links to the new task
3. Ticket subject → task title
4. Ticket description → task description
5. Ticket priority → task priority
6. A label "Support Ticket" is auto-applied (created if not exists)
7. The task's `custom_fields` stores `{ helpdesk_ticket_id: ticket.id, helpdesk_ticket_number: ticket.ticket_number }`

When a task moves between phases in BigBlueBam:
1. Check if the task has a linked ticket
2. Map the phase to a ticket status (configurable, with sensible defaults):
   - "Backlog" / "Triage" → `open`
   - "In Progress" → `in_progress`
   - "Review" / "QA" → `in_progress`
   - "Done" → `resolved`
3. Update ticket status
4. If `notify_on_status_change` is enabled, queue an email to the client

When an agent posts a ticket_message (non-internal):
1. If `notify_on_agent_reply` is enabled, queue an email to the client

---

## 5. Helpdesk Portal (Frontend)

### 5.1 Pages

#### Landing / Login
- BigBlueBam Helpdesk branding (uses org's welcome_message if set)
- Login form (email + password)
- "Create Account" link
- "Forgot Password" link

#### Registration
- Email, display name, password (min 12 chars)
- If `require_email_verification` is on: after submit, show "Check your email for a verification link"
- If `allowed_email_domains` is configured, validate domain on submit

#### Email Verification
- `/verify?token=xxx` route
- Marks `email_verified = true`
- Redirects to login

#### My Tickets (Dashboard)
- Table of user's tickets sorted by updated_at desc
- Columns: Ticket #, Subject, Status, Priority, Category, Last Updated
- Status badges: green (open), blue (in progress), yellow (waiting on customer), purple (resolved), gray (closed)
- Click row → ticket detail
- "New Ticket" button prominent at top

#### New Ticket Form
- Subject (text input, required)
- Category (dropdown if categories configured, otherwise hidden)
- Priority (dropdown: Low, Medium, High — not Critical, that's engineer-only)
- Description (textarea, rich enough for pasting but no complex editor)
- "Attach Files" area (drag-drop, stored in MinIO)
- Submit → creates ticket + BBB task → redirects to ticket detail

#### Ticket Detail
- Header: ticket number, subject, status badge, priority badge, category
- Timeline of messages (newest at bottom, chat-style):
  - Client messages: right-aligned, blue bubble
  - Agent messages: left-aligned, gray bubble
  - Status change notices: centered, muted text ("Status changed to In Progress")
- Reply box at bottom (textarea + Send button)
- "This ticket is resolved" banner when status is resolved/closed, with "Reopen" button

### 5.2 Styling

Match BigBlueBam's design system:
- Same TailwindCSS v4 theme tokens (primary blue, zinc backgrounds)
- Same font stack, spacing, radius
- Simplified — no sidebar, no complex navigation
- Clean top nav: logo, "My Tickets", account dropdown (profile, logout)
- Responsive — works on mobile (many support users will be on phones)

---

## 6. Helpdesk API

### 6.1 Auth Endpoints

| Endpoint | Description |
|---|---|
| `POST /helpdesk/auth/register` | Create helpdesk user account |
| `POST /helpdesk/auth/login` | Login, set session cookie |
| `POST /helpdesk/auth/logout` | Destroy session |
| `GET /helpdesk/auth/me` | Current user info |
| `POST /helpdesk/auth/verify-email` | Verify email with token |
| `POST /helpdesk/auth/forgot-password` | Send password reset email |
| `POST /helpdesk/auth/reset-password` | Reset password with token |

### 6.2 Ticket Endpoints (Client-Facing)

| Endpoint | Description |
|---|---|
| `GET /helpdesk/tickets` | List current user's tickets |
| `POST /helpdesk/tickets` | Create new ticket (auto-creates BBB task) |
| `GET /helpdesk/tickets/:id` | Ticket detail with messages |
| `POST /helpdesk/tickets/:id/messages` | Post a reply |
| `POST /helpdesk/tickets/:id/reopen` | Reopen a resolved ticket |

### 6.3 Agent Endpoints (BBB User-Facing)

These are accessed from BigBlueBam, not the helpdesk portal. They allow engineers to manage helpdesk-linked tickets from within BBB.

| Endpoint | Description |
|---|---|
| `GET /tickets` | List all tickets (filterable by status, project, assignee) |
| `GET /tickets/:id` | Ticket detail with all messages (including internal) |
| `POST /tickets/:id/messages` | Post a reply (can be internal or public) |
| `PATCH /tickets/:id` | Update status, priority, category |
| `POST /tickets/:id/close` | Close ticket |

### 6.4 Admin Endpoints

| Endpoint | Description |
|---|---|
| `GET /helpdesk/settings` | Get helpdesk configuration |
| `PATCH /helpdesk/settings` | Update configuration (require verification, categories, default project, etc.) |
| `GET /helpdesk/users` | List helpdesk user accounts |
| `PATCH /helpdesk/users/:id` | Disable/enable a helpdesk user |

---

## 7. BigBlueBam Integration Points

### 7.1 Task Detail — Helpdesk Panel

When viewing a task that has a linked ticket, the task detail drawer shows a "Helpdesk" tab:
- Ticket number and status
- Client info (name, email)
- Client conversation (public ticket_messages only)
- "Reply to Client" textarea (creates a non-internal ticket_message)
- Link to full ticket in agent view

### 7.2 Task Move → Ticket Status Sync

In `task.service.ts` `moveTask()`:
- After updating the task phase, check if `custom_fields.helpdesk_ticket_id` exists
- If so, look up the ticket and update its status based on phase mapping
- Queue a notification email if configured

### 7.3 Board — Ticket Indicator

Task cards with linked tickets show a small headset/support icon badge, distinguishing support tasks from internal work.

### 7.4 Settings — Helpdesk Configuration

Add a "Helpdesk" tab to BigBlueBam Settings:
- Toggle email verification requirement
- Set allowed email domains
- Choose default project and phase for new tickets
- Configure ticket categories
- Set welcome message
- Toggle notification preferences
- Preview helpdesk portal URL

### 7.5 MCP Tools

Add tools for AI agents to manage tickets:
- `list_tickets`: Search/filter tickets
- `get_ticket`: Full ticket detail with messages
- `reply_to_ticket`: Post an agent reply
- `update_ticket_status`: Change ticket status
- `get_helpdesk_stats`: Open/resolved counts, avg response time

---

## 8. Email Notifications

### 8.1 Triggers

| Event | Recipient | Email Template |
|---|---|---|
| Ticket created | Client (confirmation) | "We received your ticket #1042" |
| Agent reply | Client | "New reply on ticket #1042" |
| Status changed to resolved | Client | "Ticket #1042 has been resolved" |
| Status changed to waiting_on_customer | Client | "We need more information on ticket #1042" |
| Ticket reopened | Assigned engineer | "Ticket #1042 was reopened by the client" |
| Email verification | Client | "Verify your email to access BigBlueBam Helpdesk" |
| Password reset | Client | "Reset your password" |

### 8.2 Worker Jobs

All emails dispatched through the existing BullMQ email worker queue. New job type: `helpdesk-email` with templates.

---

## 9. Docker Setup

### 9.1 Containers

The helpdesk no longer runs as a separate nginx container. Both the BigBlueBam SPA and Helpdesk SPA are served from a single `frontend` nginx container on port 80. The helpdesk-api remains its own container.

```yaml
# Added to docker-compose.yml
helpdesk-api:
  build:
    context: .
    dockerfile: apps/helpdesk-api/Dockerfile
    target: production
  depends_on:
    postgres: { condition: service_healthy }
    redis: { condition: service_healthy }
  environment:
    NODE_ENV: production
    PORT: 4001
    DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/bigbluebam
    REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
    SESSION_SECRET: ${SESSION_SECRET}
    HELPDESK_URL: ${HELPDESK_URL:-http://localhost/helpdesk/}
    SMTP_HOST: ${SMTP_HOST:-}
    SMTP_PORT: ${SMTP_PORT:-587}
    SMTP_USER: ${SMTP_USER:-}
    SMTP_PASS: ${SMTP_PASS:-}
    EMAIL_FROM: ${EMAIL_FROM:-noreply@bigbluebam.io}
  networks:
    - backend

# The frontend container serves both SPAs:
# /b3/       → BigBlueBam SPA
# /helpdesk/ → Helpdesk SPA
# No separate helpdesk container needed.
```

### 9.2 nginx Config (unified)

The single nginx config handles all routing:

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;

    location = / {
        return 302 /helpdesk/;
    }

    location /b3/ {
        alias /usr/share/nginx/html/b3/;
        try_files $uri $uri/ /b3/index.html;
    }

    location /b3/api/ {
        proxy_pass http://api:4000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_http_version 1.1;
    }

    location /b3/ws {
        proxy_pass http://api:4000/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /helpdesk/ {
        alias /usr/share/nginx/html/helpdesk/;
        try_files $uri $uri/ /helpdesk/index.html;
    }

    location /helpdesk/api/ {
        proxy_pass http://helpdesk-api:4001/helpdesk/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /files/ {
        proxy_pass http://minio:9000/;
    }

    location /mcp/ {
        proxy_pass http://mcp-server:3001/mcp/;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
    }
}
```

---

## 10. Monorepo Structure

```
apps/
  helpdesk-api/     — Fastify server for helpdesk endpoints (internal :4001, proxied at /helpdesk/api/)
  helpdesk/         — Helpdesk React SPA (built assets served by frontend nginx at /helpdesk/)
  api/              — (existing) BigBlueBam API — gains agent ticket endpoints (proxied at /b3/api/)
  frontend/         — (existing) Single nginx container serving both SPAs at /b3/ and /helpdesk/
  ...
```

---

## 11. Security Considerations

- Helpdesk users have **zero access** to BigBlueBam data beyond their own tickets
- Helpdesk sessions are in a separate table (`helpdesk_sessions`), isolated from BBB sessions
- Rate limiting on helpdesk registration (prevent spam accounts)
- Ticket creation rate limited (max 10/hour per user)
- File uploads validated (type + size) and stored with per-ticket prefixed keys
- Internal ticket_messages (`is_internal = true`) are **never** returned by helpdesk API endpoints
- Email verification tokens expire after 24 hours
- Password reset tokens expire after 1 hour

---

## 12. Implementation Phases

### Phase 1 — Core (1-2 days)
- Database tables (helpdesk_users, helpdesk_sessions, tickets, ticket_messages, helpdesk_settings)
- Helpdesk API: auth (register, login, logout, me), ticket CRUD, messages
- Auto-create BBB task on ticket creation
- Helpdesk frontend: login, register, my tickets, new ticket, ticket detail with messages
- Docker containers + nginx

### Phase 2 — Integration (0.5-1 day)
- Task move → ticket status sync
- Agent reply from BBB task drawer (Helpdesk tab)
- Ticket indicator badge on task cards
- Helpdesk settings tab in BBB Settings
- Email notifications via worker

### Phase 3 — Polish (0.5 day)
- Email verification flow
- Password reset flow
- MCP tools for ticket management
- Helpdesk portal responsive/mobile styling
- File attachments on tickets

---

*Awaiting approval to proceed with implementation.*
