# Helpdesk Design Audit (2026-04-14)

## Summary

The BigBlueBam Helpdesk app at commit a8fb19a implements a customer support ticketing portal tightly integrated with the core Bam platform. The implementation spans two primary codebases (helpdesk-api and helpdesk frontend) with 33 API source files, 6 frontend pages, supporting schemas and migrations, and comprehensive test coverage. The design document specifies a cleanly separated authentication tier for external customers, automatic BigBlueBam task linkage, bidirectional status synchronization, and email notifications. The audit finds the implementation substantially aligned with the specification at approximately 85-90%, with key features present and most identified security issues from the preliminary audit (HB-1 through HB-57) now resolved.

## Design sources consulted

- `docs/early-design-documents/BigBlueBam_Helpdesk_Design_Document.md` (primary spec, rated adequate at 499 lines)
- `docs/helpdesk-bbb-audit-findings.md` (supplemental audit findings, HB-1 through HB-57)
- `docs/design-audits/2026-04-09/` if a prior audit exists
- `CLAUDE.md`

## Built and working

### Authentication and authorization

Helpdesk users (external customers) maintain separate identity from BigBlueBam org members via `helpdesk_users` and `helpdesk_sessions` tables. Session TTL configurable per env (default 7 days). Agent authentication uses per-agent Argon2id-hashed API keys (`hdag_*` prefixed tokens) stored in `helpdesk_agent_api_keys` table, resolving HB-28's shared-key vulnerability. Session cookie auth for Bam users coexists but does not grant access alone; `X-Agent-Key` header is authoritative per HB-12 guidance.

### Ticket lifecycle

Matches spec. Customers submit tickets via `POST /helpdesk/tickets` (subject, description, category, priority). Automatic BigBlueBam task creation via internal `bbbClient` rather than direct SQL (HB-7 resolution), with back-linking on success or async worker retry on transient failure (HB-23 infrastructure). Ticket schema includes status enum (open, in_progress, waiting_on_customer, resolved, closed) and linked task_id. Reopen, close, and priority update endpoints present.

### Bidirectional status sync

Partially implemented. Task move in Bam triggers ticket status update via `task.service.ts` using phase-to-status mapping. Customer reply no longer stays trapped in `waiting_on_customer` (HB-15 resolved). Ticket closure now mirrors to task as system comment (`mirrorTicketClosedToTask`). Reverse sync (customer action updating task) present for close and reopen.

### Realtime infrastructure

Operational. helpdesk-api registers `@fastify/websocket` plugin. WebSocket handler at `apps/helpdesk-api/src/ws/handler.ts` (13KB) manages ticket subscriptions via room-based broadcasting. Nginx routes `/helpdesk/ws` to helpdesk-api:4001/helpdesk/ws with proper upgrade headers. Frontend hooks (`useRealtimeTicket`, `useRealtimeTickets`) establish connections and invalidate queries on `ticket.message.created`, `ticket.status.changed`, and `ticket.updated` events. Event durability via `helpdeskTicketEvents` table (HB-47 resolved).

### Data model

Follows specification. `helpdesk_settings` table (org-scoped via org_id) includes verification, domain restrictions, default project/phase, categories (JSONB array), auto-close days, notification toggles. Dual Drizzle schema risk documented (HB-21) with comment marking `apps/api/src/db/schema/tickets.ts` as minimal view. Both files describe the same physical table; column mismatch would surface at runtime.

### Security hardening

Substantial progress since preliminary audit:
- HTML sanitization (`stripHtml`) on ticket subject/description (HB-19)
- CSRF token issuance on auth routes (csrf.js plugin)
- Login/register rate limits (3 attempts per 15 min per IP on register)
- Rate limiting keyed by `helpdeskUser.id` when available, else IP (HB-25)
- Email verification tokens expire after 24 hours; password reset 1 hour
- Argon2id password hashing with timing-safe login feedback (dummy hash on non-existent user)
- Authorization bypass on ticket reopen fixed (HB-4)
- Internal `ticket_messages` marked `is_internal` and filtered on read (HB-18)
- Agent auth via shared session fragile guard removed (HB-12)

### Frontend implementation

All 6 core pages present: login, register, verify-email, tickets-list, new-ticket, ticket-detail. Realtime UX components: typing indicator, online status detection, browser notification support, offline banner. Query client: staleTime 60s, retry 1, refetchOnWindowFocus false. With realtime invalidation, staleTime dependency addressed (HB-2).

### API route coverage

**Client routes (customer-facing, /helpdesk/* paths):** register, login, logout, me, verify-email, forgot-password, reset-password, public/config, public-settings, tickets (list/create/detail), messages (list/post), reopen, close, update-priority, mark-duplicate, activity, events, upload.

**Agent routes (BigBlueBam user-facing):** GET /tickets (all org), GET /tickets/:id, GET /tickets/by-number/:number, POST /tickets/:id/messages, PATCH /tickets/:id, POST /tickets/:id/close.

**Admin routes:** public-settings, settings get/patch with session or X-Agent-Key auth.

### MCP tools

`registerHelpdeskTools` in mcp-server implements: `list_tickets` (with status/assignee/client filters), `get_ticket` (full detail with messages), `reply_to_ticket` (public/internal), `update_ticket_status`, `get_helpdesk_stats` (open/resolved counts, avg response time). Tools use `helpdeskRequest` wrapper to call internal endpoints with bearer token forwarding.

### Integration with BigBlueBam

- Task linkage: `tickets.task_id` FK; custom fields on tasks store helpdesk_customer_id, helpdesk_customer_email, helpdesk_ticket_id, helpdesk_ticket_number
- Task creation via `bbbClient.createTaskFromTicket` (internal `/internal/helpdesk/tasks`)
- Status sync: task.service.ts `moveTask()` checks for helpdesk_ticket_id and maps phase to ticket status
- Message mirroring: customer messages mirror to tasks as system comments
- Broadcast: `broadcastTaskCreated` from ticket creation notifies Bam boards

## Partial or divergent

### Multi-tenant isolation

`helpdesk_users` table has no `org_id` column. All customers share a global user pool. Agent `/tickets` endpoint filters by org via resolved session identity, but underlying data model lacks hard isolation (HB-5 deferred). Design document mentions org_id as future work (Phase 5).

### Email notifications

Skeleton in place (settings flags, schema columns, env vars `SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS`). Job queueing via BullMQ deferred to later phase (routes contain TODO comments). Password reset and email verification flows functional but don't actually send emails in current commit.

### Dual schema fidelity

`tickets` table Drizzle schema split across `apps/helpdesk-api` and `apps/api`. Both must stay in sync manually. Migration 0078 at a8fb19a reconciles Bam schema; no additional helpdesk-specific migration added since 0014.

### Performance

Message list virtualization present (`useTicketMessages` pagination). No full-text search on ticket descriptions. No activity log partitioning (unlike main BBB activity log). Ticket-by-number resolution via loop query (could be indexed).

### Idempotency

Lightweight dedup via hash of (user_id + subject + description + hour-bucket) or explicit idempotency_key parameter. No schema column; detection is query-based within 1-hour window (HB-8 pragmatic mitigation).

## Missing

### P0

1. **Email notification job queueing via BullMQ.** Email verification, password reset, ticket reply notifications all have TODO comments but no worker job.
2. **Multi-tenant org_id column on helpdesk_users** (HB-5 deferred but blocks true multi-tenancy).

### P1

3. **Dedicated helpdesk migration** for any helpdesk-specific schema evolution after 0014.
4. **Full-text search** on ticket descriptions and messages.
5. **File attachment storage integration** with MinIO (upload route exists but storage path may be stub).
6. **Bolt event emission** for helpdesk lifecycle events (ticket.created, ticket.status_changed, ticket.sla_breach). Check if these are published currently.
7. **SLA tracking** - design mentions SLA timers but implementation may be incomplete.

### P2

8. **Skeleton loaders** on frontend for perceived performance (HB-53, marked P3).
9. **Activity log partitioning** by month to match main BBB pattern.
10. **Ticket category customization UI** in admin settings beyond the static JSONB array.

## Architectural guidance

### Email notification BullMQ integration

Create `apps/worker/src/jobs/helpdesk-email.job.ts` that accepts `{ template, to_email, variables }` payload. Use nodemailer with env-configured SMTP. Templates for: email_verification, password_reset, ticket_reply_notification, ticket_status_changed, ticket_closed. Enqueue from auth.routes.ts register (email verification), forgot-password (password reset), agent.routes.ts message post (reply notification). Keep fire-and-forget from routes perspective; retry logic in BullMQ.

### Multi-tenant org_id on helpdesk_users

Add `org_id UUID NOT NULL REFERENCES organizations(id)` column via new migration. Backfill existing rows from first-linked ticket's org or set to a default org. Update unique constraint on email to be per-org: `UNIQUE (org_id, email)`. This allows the same customer email to register with multiple BBB orgs independently. Update all helpdesk_user queries to filter by org. Session cookies should bind to a specific (user, org) pair.

### Bolt event emission

Add `apps/helpdesk-api/src/lib/bolt-events.ts` with fire-and-forget `publishBoltEvent()` following the pattern from other apps. Emit `ticket.created` from POST /tickets, `ticket.status_changed` from status update routes (both agent and customer), `ticket.message_posted` from POST /tickets/:id/messages, `ticket.closed` from close routes, `ticket.reopened` from reopen routes. Register these events in `apps/bolt-api/src/services/event-catalog.ts`.

## Dependencies

### Inbound

- Bolt subscribes to helpdesk events for automation.
- MCP tools expose 5 helpdesk operations to AI agents.
- Bench data source registry includes tickets for analytics.

### Outbound

- Bam API for task creation and status sync (internal :4000).
- SMTP (future) for email notifications.
- Bolt API (future) for event publishing.

## Open questions

1. **Multi-tenant rollout:** If org_id column is added to helpdesk_users, how to migrate existing global users? Assign to first org based on tickets, or require re-registration?
2. **SMTP provider:** Which SMTP service for production (Postmark, SES, SendGrid)? Affects reliability and costs.
3. **Email template storage:** Inline in worker job, in templates/ directory, or in database (admin-editable)?
4. **SLA timer implementation:** Real-time tracking via Redis TTL keys, or periodic cron sweep?
5. **File attachment virus scanning:** Is ClamAV or similar needed for customer uploads, or is trust-based acceptable for Phase 1?
