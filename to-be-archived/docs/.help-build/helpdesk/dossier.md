# Helpdesk — App Dossier

Research dossier for the BigBlueBam **Helpdesk** app. Everything below is grounded in
code; file paths are absolute. Where docs/marketing diverge from code, it is flagged in
**Discrepancies**.

---

## 1. App identity

- **App key:** `helpdesk`
- **Display name:** Helpdesk (docs subtitle: "Support Portal")
- **Category:** Support tickets & portal
- **SPA path:** `/helpdesk/` (served by nginx; `infra/nginx/nginx.conf` lines 79-81)
- **API path:** `/helpdesk/api/` → nginx rewrites to `/helpdesk/` on upstream `helpdesk-api:4001`
  (`infra/nginx/nginx.conf` lines 85-86). WebSocket at `/helpdesk/ws` (lines 95-96).
- **Backend dir:** `apps/helpdesk-api/src` (internal port 4001)
- **Frontend dir:** `apps/helpdesk/src`
- **MCP tools file:** `apps/mcp-server/src/tools/helpdesk-tools.ts` (plus cross-cutting tools
  in `dedupe-tools.ts` and `phrase-count-tools.ts`)
- **Docs dir:** `docs/apps/helpdesk` (docs_exists = true)
- **Prerequisites / role model:**
  - Helpdesk is the PUBLIC-facing support portal. nginx `location = /` returns an HTML
    shim that fetches `/b3/api/root-redirect` and falls back to `/helpdesk/`
    (`infra/nginx/nginx.conf` lines 22-25). So bare `/` lands customers on the portal.
  - **Customers (end users)** are `helpdesk_users` rows — a SEPARATE identity scope from Bam
    `users`. They authenticate with an org-scoped email+password and a `helpdesk_session`
    cookie (`apps/helpdesk-api/src/plugins/auth.ts`).
  - **Agents (support staff)** are Bam `users`. They do NOT use the helpdesk SPA; they act
    through the agent REST surface (`/helpdesk/api/agents/*`) authenticated by a Bam
    `session` cookie OR a per-agent `hdag_*` API key (`X-Agent-Key` header), and through
    Bam's own ticket views / MCP tools.
  - **Admins** (org admin/owner via Bam session, or an `hdag_*` agent key) configure helpdesk
    settings.
  - **Multi-tenant:** every org with a `helpdesk_settings` row gets its own portal at
    `/helpdesk/<org-slug>/` and optionally per-project portals at
    `/helpdesk/<org-slug>/<project-slug>/`. The SPA sends `X-Org-Slug` / `X-Project-Slug`
    headers, resolved by `apps/helpdesk-api/src/middleware/resolve-tenant.ts`.

---

## 2. Key concepts and vocabulary

- **Ticket** (`tickets` table, `apps/helpdesk-api/src/db/schema/tickets.ts`): a customer
  support request. Carries `ticket_number` (human-readable serial, shown as `#123`),
  `subject`, `description`, `status`, `priority`, `category`, plus SLA/duplicate columns.
  Owned by a `helpdesk_user_id`; optionally linked to a Bam `task_id` and `project_id`.
- **Ticket status** (canonical enum, per badge + schema + customer/agent routes):
  `open`, `in_progress`, `waiting_on_customer`, `resolved`, `closed`. Labels rendered by
  `apps/helpdesk/src/components/common/badge.tsx`: "Open", "In Progress",
  "Waiting on Customer", "Resolved", "Closed". (See Discrepancies for the `waiting_on_client`
  / `awaiting_customer` mismatches in MCP tools and the list-filter UI.)
- **Priority:** customer-settable enum `low` | `medium` | `high`
  (`createTicketSchema`, `update-priority` route). Agents can additionally set `critical`
  (`updateTicketSchema` in `agent.routes.ts`). Badge supports all four
  (low/medium/high/critical).
- **Message** (`ticket_messages`): a post on a ticket. `author_type` ∈ {`client`, `agent`,
  `system`}. `is_internal` flag hides agent notes from customers (customer GET excludes
  `is_internal=true`; agent GET includes them).
- **Internal note:** an agent message with `is_internal=true`. Not broadcast to customers,
  not mirrored to the Bam task.
- **Ticket → Bam task link:** on create, the ticket spawns a Bam `task` in the org's default
  (or per-portal) project. `tickets.task_id` back-links it. Customer/agent messages and
  closures are mirrored onto the task so the trail survives ticket deletion.
- **Duplicate / merge** (HB-55): `duplicate_of` (self-FK), `merged_at`, `merged_by`.
  Customer-side "mark as duplicate" is annotative only; agent-side "merge" actually moves
  messages onto the primary and closes the source.
- **SLA:** `helpdesk_settings.sla_first_response_minutes` (default 480 / 8h) and
  `sla_resolution_minutes` (default 2880 / 48h). `tickets.first_response_at` and
  `sla_breached_at` track compliance; breaches recorded in `helpdesk_sla_breaches`.
- **Activity log** (`ticket_activity_log`): append-only audit trail per ticket.
  `actor_type` ∈ {`customer`, `agent`, `system`}.
- **Ticket events** (`helpdesk_ticket_events`): durable event log (bigserial id) for
  WebSocket replay/resume after reconnect.
- **Helpdesk settings** (`helpdesk_settings`, one row per org): default project/phase/priority,
  categories, welcome message, allowed email domains, email-verification toggle, auto-close
  days, notify toggles, SLA minutes.
- **Tenant context:** org/project resolved from URL path → `X-Org-Slug`/`X-Project-Slug`.
- **Agent API key** (`helpdesk_agent_api_keys`): `hdag_`-prefixed, Argon2id-hashed,
  per-agent, rotatable. Distinct from Bam `bbam_` keys.

---

## 3. Feature inventory

### 3.1 Customer-facing SPA features (apps/helpdesk/src)

The SPA is a hand-rolled router (apps/helpdesk/src/app.tsx) over these routes (all under
/helpdesk[/<org>[/<project>]]): org-picker, login, register, verify, tickets, tickets/new,
tickets/:id, help. The frontend API client base is /helpdesk/api (apps/helpdesk/src/lib/api.ts),
so a frontend call to /tickets hits /helpdesk/api/tickets then upstream /helpdesk/tickets.

Chrome (distinct from the internal-app launchpad):
- Header apps/helpdesk/src/components/layout/header.tsx: left logo "B" + org name (or
  "BigBlueBam") + LifeBuoy icon + "{Project} support" or "Helpdesk"; center nav button
  "My Tickets"; right UserMenu. Logo and "My Tickets" navigate to /tickets.
- Offline banner apps/helpdesk/src/components/offline-banner.tsx.
- Browser-push notification prompt apps/helpdesk/src/components/notification-prompt.tsx:
  banner "Get notified when agents respond to your tickets." with "Enable notifications"
  and a dismiss (X). Shown on the tickets list when Notification.permission === default.
- The ? keyboard shortcut opens in-app Help (HelpViewer, app slug helpdesk); back returns
  to /tickets (app.tsx lines 207-219, 251-253).

#### Feature: Choose support portal (Org Picker)
- File: apps/helpdesk/src/pages/org-picker.tsx. Shown at /helpdesk/ with no org slug.
- Labels: heading "Choose your support portal"; subtext "Each organization has its own
  helpdesk. Pick the one you want to contact."; each row shows org name + /helpdesk/<slug>/
  + ArrowRight. Empty state: "No helpdesk portals are configured yet..."
- Steps: load page, click an org row, hard-navigates to /helpdesk/<slug>/.
- Route: GET /helpdesk/public/orgs (public-tenant.routes.ts).

#### Feature: Register (customer self-signup)
- File: apps/helpdesk/src/pages/register.tsx.
- Labels: heading "Create your account"; subtext "Get support through BigBlueBam Helpdesk";
  fields Email, Display Name, Password (placeholder "Min. 12 characters"); submit
  "Create Account"; footer "Sign in". Verification-required path shows a "Check your email"
  notice.
- Steps: fill email/name/password (>=12), "Create Account", sets helpdesk_session cookie,
  navigates to /tickets.
- Route: POST /helpdesk/auth/register (auth.routes.ts). Rate-limited 3/15min/IP. Honors
  helpdesk_signup_disabled (403 SIGNUP_DISABLED), allowed_email_domains (403
  DOMAIN_NOT_ALLOWED), per-org unique email (409 EMAIL_TAKEN). With require_email_verification
  on, stores a SHA-256 token hash (email send is a TODO).

#### Feature: Login
- File: apps/helpdesk/src/pages/login.tsx.
- Labels: heading "Welcome back"; subtext "Sign in to BigBlueBam Helpdesk"; fields Email,
  Password; submit "Sign In"; footer "Dont have an account? Create one".
- Steps: enter credentials, "Sign In", navigate to /tickets. When helpdesk_signup_disabled,
  "Create one" redirects to /b3/beta-gate.
- Route: POST /helpdesk/auth/login. Rate-limited 5/15min/IP. Redis lockout (429 ACCOUNT_LOCKED,
  lib/login-lockout.ts). Email-enumeration defenses. 403 ACCOUNT_DISABLED; optional 403
  EMAIL_NOT_VERIFIED. Reads GET /helpdesk/public/config.

#### Feature: Verify email
- File: apps/helpdesk/src/pages/verify-email.tsx (route /verify, no auth). Reads ?token=.
- Labels: "Email Verification"; states "Verifying your email...", "Your email has been
  verified!", "Verification Failed"; button "Go to Login".
- Route: POST /helpdesk/auth/verify-email. SHA-256 hash lookup + legacy plaintext fallback;
  24h expiry. Codes INVALID_TOKEN, TOKEN_EXPIRED.

#### Feature: My Tickets list
- File: apps/helpdesk/src/pages/tickets-list.tsx.
- Labels: heading "My Tickets"; "New Ticket" (Plus). Search placeholder "Search subject,
  number, or category...". Filter chips: all, open, awaiting customer, in progress, awaiting
  internal, resolved, closed. Columns: #, Subject, Status, Priority, Category, Updated.
  Per-row "New" unread dot. Empty: "No tickets yet" / "Create your first one!". No-match:
  "No tickets match your search."
- Steps: view list (client search+filter), click a row, go to /tickets/:id (marks viewed).
- Route: GET /helpdesk/tickets. Realtime refresh on WS ticket.message.created /
  ticket.status.changed (use-tickets.ts useRealtimeTicketsList).
- NOTE: filter values awaiting_customer / awaiting_internal match no real status, so those
  two chips are dead filters (see Discrepancies).

#### Feature: New Ticket
- File: apps/helpdesk/src/pages/new-ticket.tsx.
- Labels: back link "Back to tickets"; heading "New Ticket". Fields Subject ("Brief summary
  of your issue"), Category (select, only if settings.categories exist, "Select a
  category..."), Priority (Low/Medium/High, default Medium), Description (rich-text,
  "Describe your issue in detail...", inline image upload). Buttons "Submit Ticket", "Cancel".
- Steps: fill subject+description (both required client-side), "Submit Ticket", go to
  /tickets/:id.
- Routes: POST /helpdesk/tickets; image uploads to POST /helpdesk/upload (25MB, image/* +
  pdf/office/text). Categories from GET /helpdesk/settings.
- Create-route behavior (ticket.routes.ts): HTML-strips subject/description; 1-hour dedup
  (returns existing ticket, deduplicated:true, HTTP 200); resolves project via tenant header,
  then settings default_project_id, then oldest-project fallback (write-back); spawns Bam task
  via bbb-client.createTaskFromTicket; back-links task_id; logs ticket.created; emits Bolt
  ticket.created. Task-create failure is non-fatal (worker fallback, section 6).

#### Feature: Ticket Detail (conversation)
- File: apps/helpdesk/src/pages/ticket-detail.tsx.
- Header: "Back to tickets"; title "#{number} -- {subject}"; PresenceChipStrip (surfaceApp
  helpdesk). Status badge; Priority badge with a dropdown to change (Low/Medium/High);
  category chip; "Created on {date}". Actions: Share to Banter (MessageSquareShare icon);
  "Mark as duplicate" (Copy icon, only when not closed/resolved and not already a duplicate);
  "Close Ticket" (CheckCircle, with confirm dialog "Close this ticket?").
- Banners: duplicate-of "This ticket was marked as a duplicate of #N... Updates will be
  posted on that ticket." + "Unmark" (when not merged). "Duplicates of this ticket" callout.
  Resolved/Closed "This ticket has been resolved/closed." + "Reopen" (RotateCcw).
- Body: Description (markdown to sanitized HTML); Attachments block (Paperclip + count;
  filename/size/mime/scan status; "Download" or "Unavailable").
- Timeline: messages (customer right/blue as "You", agent/system left/grey) + status-change
  italics ("Status changed from X to Y -- {relative time}"); "Load older messages" when
  paginated; typing indicator; "No messages yet." empty.
- Reply box (hidden when closed/resolved): rich-text "Type your reply...", inline image
  upload, "Send Reply" (Send). Emits typing events.
- Mark-as-duplicate dialog: "Mark as duplicate"; numeric input ("e.g. #123"); Cancel /
  Confirm; maps PRIMARY_IS_DUPLICATE / PRIMARY_CLOSED / NOT_FOUND / VALIDATION_ERROR to copy.
- Share-to-Banter popover: "Share to Banter"; Channel select ("Select a channel..."); optional
  "Message" textarea ("Add a note..."); Cancel / "Share".
- Routes / hooks used (use-tickets.ts, use-ticket-messages.ts, use-attachments.ts,
  use-realtime-ticket.ts, use-typing.ts):
  - GET /helpdesk/tickets/:id ; GET /helpdesk/tickets/:id/messages?before=&limit=
  - POST /helpdesk/tickets/:id/messages (auto-flips waiting_on_customer to open)
  - POST /helpdesk/tickets/:id/update-priority ; POST /helpdesk/tickets/:id/close ;
    POST /helpdesk/tickets/:id/reopen
  - POST and DELETE /helpdesk/tickets/:id/mark-duplicate
  - GET/POST/DELETE /helpdesk/tickets/:id/attachments[/:attachmentId] (10MB, owner-only)
  - GET /helpdesk/tickets/:id/activity ; GET /helpdesk/tickets/:id/events ; GET /helpdesk/events
  - WS /helpdesk/ws (subscribe ticket:<id>, typing, resume)
  - Cross-app: GET /banter/api/v1/channels, POST /banter/api/v1/channels/:id/messages

#### Feature: In-app Help
- HelpViewer (@bigbluebam/ui), app slug helpdesk, opened by ? or /help; no own route.

### 3.2 Customer-facing REST routes (apps/helpdesk-api/src/routes)

Auth: helpdesk_session cookie via requireHelpdeskAuth (plugins/auth.ts). CSRF on mutations
(plugins/csrf.ts). Anti-enumeration: every ownership failure returns 404, never 403 (HB-51).

| Method | Path | Purpose |
|---|---|---|
| GET | /helpdesk/tickets/search?q=&limit=&offset=&status= | Full-text search across the caller OWN tickets (tsvector, ts_rank). |
| GET | /helpdesk/tickets | List caller tickets (newest-updated). |
| POST | /helpdesk/tickets | Create ticket + spawn Bam task. 1h dedup. |
| GET | /helpdesk/tickets/:id | Detail + non-internal messages + duplicate links. |
| GET | /helpdesk/tickets/:id/messages | Paginated newest-first non-internal messages. (60/min) |
| POST | /helpdesk/tickets/:id/messages | Customer reply; auto-flips waiting to open. |
| GET | /helpdesk/tickets/:id/activity | Audit trail (<=200, asc). (60/min) |
| POST | /helpdesk/tickets/:id/reopen | Reopen resolved/closed (400 INVALID_STATE otherwise). |
| POST | /helpdesk/tickets/:id/update-priority | Customer priority change (low/medium/high). |
| POST | /helpdesk/tickets/:id/close | Customer close; moves linked task to terminal. |
| GET | /helpdesk/tickets/:id/events | Durable event replay for one ticket. (120/min) |
| GET | /helpdesk/events | Durable event replay across all caller tickets. (60/min) |
| POST | /helpdesk/tickets/:id/mark-duplicate | Flag this ticket as dup of a primary (by number). |
| DELETE | /helpdesk/tickets/:id/mark-duplicate | Clear the dup flag (409 if agent-merged). |
| GET | /helpdesk/tickets/:id/attachments | List attachments (presigned URLs). |
| POST | /helpdesk/tickets/:id/attachments | Upload (10MB, mime allowlist). (20/min) |
| DELETE | /helpdesk/tickets/:id/attachments/:attachmentId | Owner delete. |
| POST | /helpdesk/upload | Generic upload (25MB) for rich-text images. |
| POST | /helpdesk/auth/register | Customer signup. (3/15min) |
| POST | /helpdesk/auth/login | Customer login. (5/15min) |
| POST | /helpdesk/auth/logout | Logout (clears cookies). |
| GET | /helpdesk/auth/me | Current customer. |
| POST | /helpdesk/auth/verify-email | Verify token. |
| GET | /helpdesk/public/config | { public_signup_disabled, helpdesk_signup_disabled }. |
| GET | /helpdesk/health | Health alias (plus shared /health, /health/ready, /metrics). |
| WS | /helpdesk/ws | Realtime: subscribe / typing / resume. |

### 3.3 Public tenant-discovery routes (no auth) -- public-tenant.routes.ts

| Method | Path | Purpose |
|---|---|---|
| GET | /helpdesk/public/orgs | Orgs with a helpdesk_settings row (slug, name, logo). |
| GET | /helpdesk/public/orgs/:slug | Org branding + settings + project list (404 UNKNOWN_ORG_SLUG / HELPDESK_NOT_CONFIGURED). |

### 3.4 Settings / admin routes -- settings.routes.ts

Auth: requireAdminAuth = Bam session cookie OR hdag_* X-Agent-Key.

| Method | Path | Purpose |
|---|---|---|
| GET | /helpdesk/public-settings | Public subset: require_email_verification, categories, welcome_message. |
| GET | /helpdesk/settings | Full org-scoped config (admin). |
| PATCH | /helpdesk/settings | Update config; creates the row if absent. |
| GET | /helpdesk/admin/projects | Org non-archived projects (id/slug/name) for the default-project picker. |

updateSettingsSchema fields: require_email_verification, allowed_email_domains[],
default_project_id, default_phase_id, default_priority (low/medium/high/critical),
categories[], welcome_message, auto_close_days, notify_on_status_change,
notify_on_agent_reply. (SLA minutes live in the table but are NOT in the PATCH schema --
admin-editable only via direct DB / future UI.)

### 3.5 Agent routes -- agent.routes.ts (mounted under /helpdesk/agents)

Auth: requireAgentAuth = valid hdag_* X-Agent-Key (Argon2id-verified against
helpdesk_agent_api_keys); a Bam session cookie ALONE is NOT sufficient (HB-12/HB-49). Every
route is org-scoped (403 ORG_CONTEXT_REQUIRED when no org resolvable). External paths after
the nginx rewrite: /helpdesk/api/agents/...

| Method | Path | Purpose |
|---|---|---|
| GET | /agents/tickets?status=&project_id= | Org-scoped ticket list (excludes unlinked tickets). |
| GET | /agents/tickets/by-number/:number | Resolve by #number; enriched with requester + task assignee. |
| GET | /agents/tickets/search?q=&status=&assignee_id= | Fuzzy ILIKE search over subject/description (<=20). |
| GET | /agents/tickets/:id | Full detail INCLUDING internal messages. |
| POST | /agents/tickets/:id/messages | Agent reply or internal note; stamps first_response_at. (30/min) |
| PATCH | /agents/tickets/:id | Update status/priority/category; audits per field. (60/min) |
| POST | /agents/tickets/:id/close | Close. (20/min) |
| POST | /agents/tickets/:id/merge | TRUE merge: move messages to primary, close source. (10/min) |
| GET | /agents/queue?assignee_id=&status=&sla_state=&limit=&offset= | Agent queue with SLA badges (breached/imminent/ok). |
| GET | /agents/tickets/:id/similar | Ranked similar tickets (dedupe; in dedupe.routes.ts). (30/min) |

Agent updateTicketSchema status enum: open|in_progress|waiting_on_customer|resolved|closed;
priority adds critical. Agent queue SLA target is hardcoded 4h for first response with a 0.75
imminent threshold (agent.routes.ts ~line 1396), independent of the per-org
sla_first_response_minutes used by the worker sweeper -- see Discrepancies.

### 3.6 Admin upsert / analytics / dedupe routes

- users.routes.ts -- POST /v1/helpdesk-users/upsert (admin auth). Idempotent create/update by
  (org_id, email). Update path NEVER writes password_hash. Emits Bolt user.upserted. Requires
  X-Org-Slug (400 ORG_REQUIRED).
- analytics.routes.ts -- GET /v1/tickets/analytics/count-by-phrase?phrase=&buckets=&since=&until=&status=
  (admin auth). Time-bucketed phrase counts over tickets, 5s statement_timeout
  (504 PHRASE_COUNT_TIMEOUT).
- dedupe.routes.ts -- GET /helpdesk/agents/tickets/:id/similar (agent auth). pg_trgm
  similarity + requester/category/duplicate boosts; attaches prior dedupe_decisions.

---

## 4. Candidate User Stories

1. Customer files a ticket. Visit /helpdesk/, pick org, register/login, "New Ticket", fill
   Subject + Priority + (Category) + Description, "Submit Ticket", land on the ticket detail.
   (Backend spawns a Bam task in the default project.)
2. Customer tracks and replies. "My Tickets", open a ticket, read agent replies in the
   timeline, type a reply, "Send Reply". If the ticket was "Waiting on Customer", replying
   auto-flips it back to Open.
3. Customer attaches a file / inline image. On a ticket, add an attachment (or paste an image
   into the rich-text editor); it appears in the Attachments block with a Download link once
   scanned.
4. Customer closes or reopens. "Close Ticket" (confirm) when resolved on their end; later
   "Reopen" from the resolved/closed banner.
5. Customer changes priority. Open the priority dropdown on the ticket header, pick
   Low/Medium/High.
6. Customer marks a duplicate. "Mark as duplicate", enter the primary ticket number, Confirm;
   duplicate-of banner appears; "Unmark" to undo (if not agent-merged).
7. Customer shares a ticket to Banter. Share-to-Banter popover, pick channel, optional note,
   "Share" (cross-app handoff to Banter).
8. Customer enables notifications. Click "Enable notifications" on the prompt banner to get
   browser push when agents respond.
9. Agent works the queue. Via agent key/Bam session: GET /agents/queue filtered by
   assignee/status/SLA, open a ticket (GET /agents/tickets/:id, sees internal notes), reply or
   add internal note, PATCH status to in_progress/resolved, close.
10. Agent merges duplicates. GET /agents/tickets/:id/similar to find candidates, POST
    /agents/tickets/:id/merge with the primary id; messages move, source closes.
11. Admin onboards a portal. Set default_project_id (via helpdesk_set_default_project MCP tool
    or PATCH /helpdesk/settings), categories, welcome message, allowed domains, email-
    verification toggle.
12. Admin/agent runs ticket trend analytics. Count tickets matching a phrase over
    hour/day/week buckets (helpdesk_ticket_count_by_phrase).
13. Webhook intake reconciles a user. External system upserts a helpdesk end-user via
    helpdesk_upsert_user (idempotent, never overwrites password).

---

## 5. Agent flows (which features agents/automation drive, and via which tools)

MCP tools live in apps/mcp-server/src/tools/helpdesk-tools.ts unless noted. They proxy to
helpdesk-api, forwarding the caller bearer token.

| MCP tool | Human feature | Backing route |
|---|---|---|
| list_tickets | Agent ticket list | GET /helpdesk/tickets (agent surface) |
| get_ticket | Open ticket w/ messages | GET /helpdesk/tickets/:id |
| helpdesk_get_ticket_by_number | Resolve #number to record/UUID | GET /helpdesk/tickets/by-number/:number |
| helpdesk_search_tickets | Fuzzy find tickets | GET /helpdesk/tickets/search |
| reply_to_ticket | Agent public reply or internal note | POST /helpdesk/tickets/:id/messages (resolves number to UUID first) |
| update_ticket_status | Change ticket status | PATCH /helpdesk/tickets/:id |
| helpdesk_get_public_settings | Public settings | GET /helpdesk/public-settings |
| helpdesk_get_settings | Full settings (admin) | GET /helpdesk/settings |
| helpdesk_update_settings | Edit settings (admin) | PATCH /helpdesk/settings |
| helpdesk_set_default_project | Set default project for incoming tickets (admin) | discovery + GET /helpdesk/admin/projects + PATCH /helpdesk/settings |
| helpdesk_upsert_user | Idempotent customer upsert (admin) | POST /v1/helpdesk-users/upsert |
| helpdesk_find_similar_tickets (dedupe-tools.ts) | Dedupe / find related | GET /helpdesk/agents/tickets/:id/similar |
| helpdesk_ticket_count_by_phrase (phrase-count-tools.ts) | Ticket trend analytics | GET /v1/tickets/analytics/count-by-phrase |

Cross-cutting platform tools also reach helpdesk: search_everything / cross-app search,
resolve_references, the unified activity view (v_activity_unified UNIONs ticket_activity_log;
helpdesk actor_type=agent is remapped to section 10 human kind), entity_links,
attachment_get/attachment_list, and dedupe primitives (dedupe_record_decision /
dedupe_list_pending for helpdesk.ticket pairs).

Bolt events emitted by helpdesk (source helpdesk, via apps/helpdesk-api/src/lib/bolt-events.ts
and the worker): ticket.created, ticket.message_posted, ticket.status_changed, ticket.closed,
ticket.reopened, user.upserted, and ticket.sla_breached (SLA monitor worker). These let Bolt
automations react to ticket lifecycle.

Note on tool overlap: The orchestrator note says some helpdesk tools also exist in the Bam api.
In code, get_ticket / list_tickets / reply_to_ticket / update_ticket_status are defined ONLY in
helpdesk-tools.ts (verified by grep). They proxy to helpdesk-api, not to Bam-api. No duplicate
definition exists inside the Bam api MCP module set.

---

## 6. Background jobs (worker)

apps/worker/src/jobs/:
- helpdesk-task-create.job.ts -- async fallback (HB-23) for ticket-to-Bam-task creation when
  inline creation fails. Idempotent (skips if task_id already set). Inserts the task +
  back-links it, stamping helpdesk custom fields (helpdesk_ticket_id, helpdesk_ticket_number,
  helpdesk_customer_email/id). Enqueued via apps/helpdesk-api/src/services/task-queue.ts
  (enqueueTaskCreation, queue helpdesk-task-create).
- helpdesk-sla-monitor.job.ts -- every ~5 min; finds first-response and resolution SLA
  breaches per org SLA minutes, records helpdesk_sla_breaches, stamps sla_breached_at, emits
  ticket.sla_breached.
- helpdesk-email-notify.job.ts -- transactional emails (verification, password_reset,
  reply_notification, status_change) via nodemailer; logs instead of sends when SMTP unset.

---

## 7. Screenshots available

Both light/ and dark/ variants under docs/apps/helpdesk/screenshots/:

| Filename (light & dark) | meta.json label | Depicts | Illustrates step |
|---|---|---|---|
| 01-portal.png | "Support portal" | Portal / org landing | Story 1 (choose portal / landing) |
| 02-login.png | "Login screen" | Login page | Login feature |
| 02-ticket-list.png | (not in meta.json) | Ticket list | "My Tickets" / Story 2 |
| 03-new-ticket.png | (not in meta.json) | New ticket form | New Ticket / Story 1 |
| 03-ticket-list.png | "Ticket list" | Ticket list | "My Tickets" |
| 04-ticket-detail.png | "Ticket detail" | Ticket conversation | Stories 2/3/4 |
| 05-knowledge-base.png | (not in meta.json) | "Knowledge Base" (per guide) | NOT a real feature -- see Discrepancies |
| 05-new-ticket.png | "New ticket form" | New ticket form | New Ticket |

Notes: meta.json registers 5 light + 5 dark entries (01-portal, 02-login, 03-ticket-list,
04-ticket-detail, 05-new-ticket), but the directory ALSO contains 02-ticket-list.png,
03-new-ticket.png, and 05-knowledge-base.png that are NOT in meta.json. Several meta.json
sha256 values are identical across distinct ids (e.g. 01-portal == 02-login in light;
03-ticket-list == 04-ticket-detail == 05-new-ticket in light), suggesting some captures are
duplicate/placeholder images. Treat screenshot fidelity as unverified.

---

## 8. Discrepancies (docs/marketing vs. code)

1. "Knowledge Base" does not exist. docs/apps/helpdesk/guide.md has a "Knowledge Base"
   walkthrough section and a screenshots/.../05-knowledge-base.png. There is NO knowledge-base
   code anywhere in apps/helpdesk (grep for knowledge/KB returns nothing). Beacon is the
   separate knowledge-base app. Do not document a Helpdesk KB.
2. Ticket-status enum drift across three places:
   - Canonical (badge, schema, customer + agent routes):
     open | in_progress | waiting_on_customer | resolved | closed.
   - MCP tools list_tickets / update_ticket_status / reply_to_ticket use waiting_on_client
     (and helpdesk_search_tickets lists BOTH waiting_on_client and waiting_on_customer).
     Passing waiting_on_client to update_ticket_status (PATCH /helpdesk/tickets/:id) would be
     rejected by the agent route Zod enum (updateTicketSchema only allows waiting_on_customer).
     The MCP enum is wrong.
   - The list-filter chips in tickets-list.tsx (STATUS_FILTERS) use awaiting_customer and
     awaiting_internal, which match NO real status, so those two filters are dead (always
     empty). The other chips (open/in_progress/resolved/closed) work.
3. Agent-queue SLA target is hardcoded 4h in agent.routes.ts for the sla_state badge, but the
   worker breach sweeper uses the per-org sla_first_response_minutes (default 480 = 8h) /
   sla_resolution_minutes. So the queue imminent/breached badge and the actual breach events
   can disagree.
4. Guide claims "agents use their existing credentials" -- true for org-admin Bam-session
   auth, but the primary documented agent auth is a per-agent hdag_* API key. A plain Bam
   session alone is explicitly NOT accepted on /agents/* routes (HB-12/HB-49). Be precise in
   user docs.
5. Email verification / notification sends are stubbed. Registration creates a verify token
   hash but the email send is a TODO (auth.routes.ts); the worker email job logs instead of
   sending when SMTP is unconfigured. The "Check your email" UX and the notify toggles can
   appear functional without delivering mail in a stack with no SMTP.
6. Customer priority is capped at high. UI + customer route allow only low/medium/high;
   critical exists in the badge + agent route + settings default_priority but customers cannot
   select it.
7. mcp-tools.md table is truncated/garbled. Several descriptions are cut at an escaped quote
   (e.g. "the caller\", "ticket number (e.g. 1234 or #1234). Leading "). Cosmetic, but do not
   quote it verbatim.

---

## 9. Open questions

1. Is there any agent-facing SPA/UI for the helpdesk queue, or do agents work tickets solely
   from Bam ticket views + MCP tools? No agent SPA exists under apps/helpdesk/src; the queue is
   REST/MCP-only. (Likely surfaced inside the Bam frontend, not confirmed here.)
2. How are hdag_* agent API keys minted and rotated (no CLI/route found in
   apps/helpdesk-api/src)? The helpdesk_agent_api_keys table is consumed for verification but
   the creation path is elsewhere (presumably Bam-side or a script) -- not located in this app
   source.
3. The 1-hour create-time dedup computes a buildDedupHash that is explicitly discarded (void
   dedupHash) and instead does a (user, subject, description, <1h) equality query; the
   idempotency_key request field is accepted but unused. Intended behavior of idempotency_key?
4. auto_close_days and notify_on_status_change / notify_on_agent_reply settings exist but no
   auto-close worker job was found in apps/worker/src/jobs. Are these enforced anywhere, or
   aspirational config?
5. update_ticket_status MCP tool cannot set critical priority and its status enum omits
   waiting_on_customer while including the non-existent waiting_on_client -- is the canonical
   wire value waiting_on_customer (yes, per the route) and the tool simply stale?
