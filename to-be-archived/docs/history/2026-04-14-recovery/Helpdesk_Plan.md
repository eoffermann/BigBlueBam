# Helpdesk Implementation Plan (2026-04-14)

## Scope

Helpdesk is 85-90% complete at `f5fb079` with robust auth, bidirectional Bam status sync, WebSocket realtime, and comprehensive test coverage. This plan closes 2 P0 gaps (email notification worker job, multi-tenant `org_id` isolation on `helpdesk_users`) and 5 P1 gaps (Bolt event emission, SLA tracking framework, full-text search, MinIO attachment storage, email verification token hashing).

**In scope (P0):** BullMQ email worker job for verification/reset/reply/status-change notifications; `helpdesk_users.org_id` column with backfill and per-org unique email constraint.

**In scope (P1):** Bolt event emission for ticket lifecycle; SLA tracking (`first_response_at`, breach detection job, per-org SLA config); full-text search on tickets and messages via tsvector GIN; MinIO attachment storage integration; email verification token SHA-256 hashing.

**Out of scope:** virus scanning (placeholder only), SMTP provider production hardening, admin-editable email templates, SLA dashboard widgets, ticket merge, activity log partitioning.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §Email notifications | BullMQ worker job for email verification, password reset, ticket reply, status change notifications |
| G2 | P0 | audit §Multi-tenant isolation HB-5 | `helpdesk_users.org_id` with backfill and per-org email unique constraint |
| G3 | P1 | audit §Bolt integration | Emit `ticket.created`, `ticket.status_changed`, `ticket.message_posted`, `ticket.closed`, `ticket.reopened`, `ticket.sla_breached` events |
| G4 | P1 | audit §SLA framework | `first_response_at`, `sla_breached_at`, `helpdesk_sla_breaches` audit table, breach detection job |
| G5 | P1 | audit §Full-text search | tsvector GIN indexes on tickets and ticket_messages, ranked search endpoint |
| G6 | P1 | audit §File attachment storage | MinIO integration, `helpdesk_ticket_attachments` metadata, signed URLs, scan placeholder |
| G7 | P1 | audit §HB-44 token hashing | SHA-256 hashing of email verification tokens |

## Migrations

**Reserved slots: 0109, 0110, 0111, 0112, 0113, 0114, 0115.**

### 0109_helpdesk_users_org_id.sql

**Body:**
```sql
-- 0109_helpdesk_users_org_id.sql
-- Why: HB-5 multi-tenant isolation. Helpdesk currently shares a single global user pool. Adding org_id allows customers to register with different BBB orgs using the same email.
-- Client impact: expand-contract step 1 of 2. New nullable column; backfill attempted from existing ticket linkage; contract step enforces NOT NULL in 0110.

ALTER TABLE helpdesk_users ADD COLUMN IF NOT EXISTS org_id UUID;

CREATE INDEX IF NOT EXISTS idx_helpdesk_users_org_id ON helpdesk_users (org_id);

UPDATE helpdesk_users hu
SET org_id = (
  SELECT p.org_id
  FROM tickets t
  JOIN projects p ON p.id = t.project_id
  WHERE t.helpdesk_user_id = hu.id
  LIMIT 1
)
WHERE hu.org_id IS NULL
  AND EXISTS (SELECT 1 FROM tickets t WHERE t.helpdesk_user_id = hu.id);
```

### 0110_helpdesk_users_org_id_constraint.sql

**Body:**
```sql
-- 0110_helpdesk_users_org_id_constraint.sql
-- Why: Contract phase of org_id rollout. Add FK and replace global UNIQUE(email) with per-org UNIQUE(org_id, email).
-- Client impact: expand-contract step 2 of 2. Rows with NULL org_id remain; application prompts re-registration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'helpdesk_users_org_id_fk') THEN
    ALTER TABLE helpdesk_users
      ADD CONSTRAINT helpdesk_users_org_id_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE helpdesk_users DROP CONSTRAINT IF EXISTS helpdesk_users_email_key;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'helpdesk_users_org_id_email_unique') THEN
    ALTER TABLE helpdesk_users
      ADD CONSTRAINT helpdesk_users_org_id_email_unique UNIQUE (org_id, email);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_helpdesk_users_org_id_email ON helpdesk_users (org_id, email);
```

### 0111_helpdesk_sla_tracking.sql

**Body:**
```sql
-- 0111_helpdesk_sla_tracking.sql
-- Why: SLA tracking framework. Add first_response_at and sla_breached_at to tickets, SLA config columns to helpdesk_settings, audit table for breach events.
-- Client impact: additive only. Defaults set; no existing row disturbed.

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tickets_first_response_at ON tickets (first_response_at);
CREATE INDEX IF NOT EXISTS idx_tickets_sla_breached_at ON tickets (sla_breached_at);

ALTER TABLE helpdesk_settings
  ADD COLUMN IF NOT EXISTS sla_first_response_minutes INTEGER NOT NULL DEFAULT 480,
  ADD COLUMN IF NOT EXISTS sla_resolution_minutes INTEGER NOT NULL DEFAULT 2880;

CREATE TABLE IF NOT EXISTS helpdesk_sla_breaches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sla_type VARCHAR(50) NOT NULL,
  breached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_emitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_helpdesk_sla_breaches_ticket_id ON helpdesk_sla_breaches (ticket_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_sla_breaches_sla_type ON helpdesk_sla_breaches (sla_type);
```

### 0112_helpdesk_ticket_fulltext.sql

**Body:**
```sql
-- 0112_helpdesk_ticket_fulltext.sql
-- Why: Full-text search on tickets and ticket_messages. Generated tsvector columns + GIN indexes for fast ranked queries.
-- Client impact: additive only. No query behavior change until search.service.ts is wired.

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(subject, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(description, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_tickets_search_vector ON tickets USING GIN (search_vector);

ALTER TABLE ticket_messages
  ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(body, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_ticket_messages_search_vector ON ticket_messages USING GIN (search_vector);
```

### 0113_helpdesk_email_verification_hashing.sql

**Body:**
```sql
-- 0113_helpdesk_email_verification_hashing.sql
-- Why: HB-44 security fix. Hash email verification tokens with SHA-256 to prevent offline brute-force if DB is compromised.
-- Client impact: expand-contract step 1. Hashed column added; application hashes on insert going forward. In-flight plaintext tokens expire naturally within 24 hours.

ALTER TABLE helpdesk_users
  ADD COLUMN IF NOT EXISTS email_verification_token_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_helpdesk_users_email_verification_token_hash
  ON helpdesk_users (email_verification_token_hash);
```

### 0114_helpdesk_ticket_attachments.sql

**Body:**
```sql
-- 0114_helpdesk_ticket_attachments.sql
-- Why: MinIO-backed file attachment metadata. Tracks storage_key, content_type, size, virus scan status.
-- Client impact: additive only. New table.

CREATE TABLE IF NOT EXISTS helpdesk_ticket_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES helpdesk_users(id) ON DELETE CASCADE,
  filename VARCHAR(512) NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  size_bytes BIGINT NOT NULL,
  storage_key VARCHAR(1024) NOT NULL,
  scan_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  scan_error TEXT,
  scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_helpdesk_ticket_attachments_ticket_id ON helpdesk_ticket_attachments (ticket_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_ticket_attachments_scan_status ON helpdesk_ticket_attachments (scan_status);
```

### 0115_helpdesk_ticket_events_bolt.sql

**Body:**
```sql
-- 0115_helpdesk_ticket_events_bolt.sql
-- Why: Track Bolt event emission on helpdesk_ticket_events so retry logic can find unpublished rows.
-- Client impact: additive only. New columns default NULL.

ALTER TABLE helpdesk_ticket_events
  ADD COLUMN IF NOT EXISTS bolt_event_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS bolt_event_emitted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_helpdesk_ticket_events_bolt_event_id
  ON helpdesk_ticket_events (bolt_event_id);
```

## Schemas and shared types

- `packages/shared/src/schemas/helpdesk.ts` (new, G3) — `HelpdeskTicketStatus`, `HelpdeskTicketPriority`, `EmailTemplate` enum, `SlaConfigSchema`, `TicketAttachmentSchema`, `BoltEventEmitSchema`.
- `apps/helpdesk-api/src/db/schema/helpdesk-users.ts` (update, G2) — add `org_id` column.
- `apps/helpdesk-api/src/db/schema/helpdesk-settings.ts` (update, G4) — add `sla_first_response_minutes`, `sla_resolution_minutes`.
- `apps/helpdesk-api/src/db/schema/tickets.ts` (update, G4, G5) — add `first_response_at`, `sla_breached_at`, `search_vector`.
- `apps/helpdesk-api/src/db/schema/ticket-messages.ts` (update, G5) — add `search_vector`.
- `apps/helpdesk-api/src/db/schema/helpdesk-sla-breaches.ts` (new, G4).
- `apps/helpdesk-api/src/db/schema/helpdesk-ticket-attachments.ts` (new, G6).

## API routes and services

### New routes

- `GET /search?q=...` (G5) — paginated FTS over tickets scoped to session user's accessible tickets.
- `GET /search/messages/:ticketId?q=...` (G5) — FTS within a single ticket.
- `GET /tickets/:id/attachments` (G6) — list attachments with signed URLs.
- `POST /tickets/:id/attachments` (G6) — multipart upload, 10 MB cap, enqueue scan job.
- `DELETE /tickets/:id/attachments/:attachmentId` (G6) — owner-only delete.

### Route updates

- `POST /auth/register` (G1, G7) — hash verification token with SHA-256 before insert, call `email.service.queueEmailVerification`.
- `POST /auth/forgot-password` (G1) — call `email.service.queuePasswordReset`.
- `POST /tickets` (G3) — publish `ticket.created` via canonical `publishBoltEvent`.
- `POST /tickets/:id/messages` (G1, G3, G4) — enqueue reply notification; publish `ticket.message_posted`; if first agent reply, set `first_response_at` and publish `ticket.first_response_sent`.
- `PATCH /tickets/:id` (G1, G3) — enqueue status change notification; publish `ticket.status_changed`.
- `POST /tickets/:id/close` (G3) — publish `ticket.closed`.
- `POST /tickets/:id/reopen` (G3) — publish `ticket.reopened`.
- `PATCH /settings` (G4) — allow admin to update SLA minutes.

### New services

- `apps/helpdesk-api/src/services/email.service.ts` (new, G1) — `queueEmailVerification`, `queuePasswordReset`, `queueTicketReply`, `queueTicketStatusChanged`, `queueTicketClosed`. All enqueue to BullMQ `helpdesk-email` queue with template name and variables. Fire-and-forget.
- `apps/helpdesk-api/src/services/sla.service.ts` (new, G4) — `checkSlaBreaches()` scans tickets past threshold and records breaches; `recordFirstResponse(ticket_id)`; `getSlaMetrics(org_id, days)`.
- `apps/helpdesk-api/src/services/search.service.ts` (new, G5) — `searchTickets(org_id, query, limit, offset)` using `ts_rank` and `plainto_tsquery`; `searchTicketMessages(ticket_id, query)`.
- `apps/helpdesk-api/src/services/attachment.service.ts` (new, G6) — `uploadAttachment` generates `helpdesk-attachments/{org_id}/{ticket_id}/{uuid}/{filename}` key, calls MinIO `putObject`, returns signed URL (24h expiry); `listAttachments`; `deleteAttachment`.

### Service updates

- `apps/helpdesk-api/src/services/auth.service.ts` (G7) — hash verification tokens with `crypto.createHash('sha256').update(token).digest('hex')` before store; compare-against-hash on verify.
- All services importing `publishBoltEvent` use the canonical `@bigbluebam/shared` export (Cross_Product_Plan G1).

## Frontend pages and components

- `apps/helpdesk/src/pages/search.tsx` (new, G5) — search box, results list with snippet highlighting, pagination.
- `apps/helpdesk/src/components/AttachmentUpload.tsx` (new, G6) — drag-and-drop zone, file list, progress indicators.
- `apps/helpdesk/src/hooks/use-search-tickets.ts` (new, G5) — TanStack Query hook with debouncing.
- `apps/helpdesk/src/hooks/use-attachments.ts` (new, G6) — CRUD hooks for attachments.
- `apps/helpdesk/src/pages/tickets-list.tsx` (update, G5) — integrate search box.
- `apps/helpdesk/src/pages/ticket-detail.tsx` (update, G6) — attachment upload + list below message box.
- `apps/helpdesk/src/pages/settings.tsx` (update, G4) — SLA config form for admins.

## Worker jobs

### `apps/worker/src/jobs/helpdesk-email.job.ts` (new, G1)

Payload: `{ template, to_email, variables, org_id }`.

Nodemailer via env (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`). Templates: `email_verification`, `password_reset`, `ticket_reply_notification`, `ticket_status_changed`, `ticket_closed`. Retry 3x with exponential backoff; DLQ on exhaustion.

### `apps/worker/src/jobs/helpdesk-sla-check.job.ts` (new, G4)

Repeating job every 10 minutes. Calls `slaService.checkSlaBreaches()`. Publishes `ticket.sla_breached` events via canonical `publishBoltEvent`.

### `apps/worker/src/jobs/helpdesk-scan-attachment.job.ts` (new, G6 placeholder)

Enqueued on upload. Stub: marks `scan_status='clean'` after 1 second. Real ClamAV integration deferred.

Register all three jobs in `apps/worker/src/index.ts`.

## MCP tools

`apps/mcp-server/src/tools/helpdesk-tools.ts` (additions, G3, G5, G6):
- `search_tickets(query, org_id?, limit?)` — ranked FTS results with snippets.
- `search_ticket_messages(ticket_id, query)` — within-ticket search.
- `list_ticket_attachments(ticket_id)` — metadata with signed URLs.
- `upload_ticket_attachment(ticket_id, filename, base64_content)` — proxy to POST endpoint.

## Tests

- `apps/helpdesk-api/test/email.service.test.ts` (new, G1) — queues correct BullMQ job types; mock `queue.add`.
- `apps/helpdesk-api/test/sla.service.test.ts` (new, G4) — breach detection, `recordFirstResponse`, metrics aggregation.
- `apps/helpdesk-api/test/search.service.test.ts` (new, G5) — ranked FTS correctness, pagination, ILIKE injection prevention.
- `apps/helpdesk-api/test/attachment.service.test.ts` (new, G6) — mock MinIO, verify storage key format, signed URL generation, delete.
- `apps/helpdesk-api/test/bolt-events.test.ts` (new, G3) — each ticket lifecycle event publishes correctly.
- `apps/helpdesk-api/test/multi-tenancy.test.ts` (new, G2) — two orgs, same email, isolated users; cross-org access rejected.
- `apps/helpdesk-api/test/auth.test.ts` (update, G7) — token stored hashed, plaintext comparison fails.
- `apps/worker/test/helpdesk-email.job.test.ts` (new, G1) — mock nodemailer, verify template variables, retry on transient failure.
- `apps/helpdesk/test/search.test.tsx` (new, G5).
- `apps/helpdesk/test/attachment-upload.test.tsx` (new, G6).

## Verification steps

```bash
pnpm --filter @bigbluebam/helpdesk-api build
pnpm --filter @bigbluebam/helpdesk-api typecheck
pnpm --filter @bigbluebam/helpdesk-api test
pnpm --filter @bigbluebam/helpdesk typecheck
pnpm --filter @bigbluebam/helpdesk test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations

docker run --rm -d --name bbb-helpdesk-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55497:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55497/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55497/verify' pnpm db:check
docker rm -f bbb-helpdesk-verify
```

**Live smoke tests:** register helpdesk user in two orgs with same email, verify isolation; create ticket and verify `ticket.created` reaches Bolt; agent replies, verify `first_response_at` set and notification email enqueued; wait for SLA breach, verify `ticket.sla_breached` emitted; full-text search tickets, verify ranked results; upload attachment, verify storage_key format and signed URL; delete own attachment.

## Out of scope

Virus scanning implementation (placeholder only), SMTP production provider selection and hardening, admin-editable email template UI, SLA dashboard widgets, ticket merge/duplicate resolution, activity log partitioning.

## Dependencies

- BullMQ Redis queue (existing).
- Nodemailer + SMTP env vars (new).
- MinIO (existing) for attachments.
- Bolt API internal ingest endpoint for event publishing.
- Canonical `publishBoltEvent` from `@bigbluebam/shared` (Cross_Product_Plan G1).
- Bam API for task linkage (unchanged).

**Migration numbers claimed: 0109, 0110, 0111, 0112, 0113, 0114, 0115.**
