# Bill Implementation Plan (2026-04-14)

## Scope

Bill is 85-90% complete at `a5147ce`. All core invoice, client, payment, rate, expense, and financial reporting features are built and working. This plan covers the final integration work required for production readiness: async worker jobs, invoice number sequence locking, MinIO storage integration, frontend time-entry-to-invoice wizard, and Bond deal automation.

**In scope (P0):** worker jobs for async PDF generation and email delivery; Redis-based invoice number sequence locking. **In scope (P1):** MinIO integration for PDF and receipt storage; time-entry-to-invoice wizard; Bond deal auto-invoice automation; expense receipt multipart upload; overdue invoice reminder job.

**Out of scope:** multi-currency exchange rates, expense approval comment threads, invoice template library, tax calculation immutability, public token rotation, accounting system export.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §Missing P0 item 1 | Worker job `bill-pdf-generate` for async PDF generation |
| G2 | P0 | audit §Missing P0 item 1 | Worker job `bill-email-send` for async invoice email delivery with attachments |
| G3 | P0 | audit §Missing P0 item 3 | Invoice number sequence atomic locking via Redis |
| G4 | P1 | audit §Missing P1 item 1 | MinIO plugin + integration for PDF storage (bill_invoices.pdf_url) |
| G5 | P1 | audit §Missing P1 item 1 | MinIO integration for expense receipt storage |
| G6 | P1 | audit §Missing P1 item 2 | Frontend time-entry-to-invoice wizard with Bam API integration |
| G7 | P1 | audit §Missing P1 item 3 | Bond deal auto-invoice automation (Bolt trigger on deal.closed-won) |
| G8 | P1 | audit §Missing P1 item 4 | Expense receipt multipart upload handler |
| G9 | P1 | audit §Missing P1 item 5 | Overdue invoice reminder worker job (daily) |

## Migrations

**Reserved slots: 0086, 0087, 0088.**

### 0086_bill_pdf_storage_and_locks.sql

**Body:**
```sql
-- 0086_bill_pdf_storage_and_locks.sql
-- Why: Support async PDF generation tracking and overdue reminder idempotency. Add indexes for PDF pending and overdue scanning.
-- Client impact: additive only. New nullable columns and indexes.

ALTER TABLE bill_invoices
  ADD COLUMN IF NOT EXISTS pdf_generation_locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pdf_generation_locked_by VARCHAR(100);

ALTER TABLE bill_invoices
  ADD COLUMN IF NOT EXISTS overdue_reminder_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE bill_invoices
  ADD COLUMN IF NOT EXISTS overdue_reminder_last_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_bill_invoices_pdf_pending
  ON bill_invoices(organization_id, status)
  WHERE pdf_url IS NULL AND status NOT IN ('draft', 'void');

CREATE INDEX IF NOT EXISTS idx_bill_invoices_overdue
  ON bill_invoices(organization_id, due_date, status)
  WHERE status NOT IN ('paid', 'void', 'written_off');
```

**Verification:** scratch-DB apply + `\d bill_invoices`.

### 0087_bill_expense_receipt_metadata.sql

**Body:**
```sql
-- 0087_bill_expense_receipt_metadata.sql
-- Why: Track receipt file uploads from multipart form submissions and store MinIO metadata.
-- Client impact: additive only. New nullable columns.

ALTER TABLE bill_expenses
  ADD COLUMN IF NOT EXISTS receipt_mime_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS receipt_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS receipt_uploaded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_bill_expenses_missing_receipt
  ON bill_expenses(organization_id, status, created_at)
  WHERE status = 'approved' AND receipt_url IS NULL;
```

**Verification:** scratch-DB apply + `\d bill_expenses`.

### 0088_bill_worker_job_state.sql

**Body:**
```sql
-- 0088_bill_worker_job_state.sql
-- Why: Track worker job state for idempotent retries and progress monitoring on PDF generation and email delivery.
-- Client impact: additive only. New table, no existing rows affected.

CREATE TABLE IF NOT EXISTS bill_worker_jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    invoice_id          UUID REFERENCES bill_invoices(id) ON DELETE CASCADE,
    expense_id          UUID REFERENCES bill_expenses(id) ON DELETE CASCADE,
    job_type            VARCHAR(50) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    error_message       TEXT,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bill_worker_jobs_type_check') THEN
    ALTER TABLE bill_worker_jobs
      ADD CONSTRAINT bill_worker_jobs_type_check
      CHECK (job_type IN ('pdf_generate', 'email_send', 'reminder_check'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bill_worker_jobs_status_check') THEN
    ALTER TABLE bill_worker_jobs
      ADD CONSTRAINT bill_worker_jobs_status_check
      CHECK (status IN ('pending', 'processing', 'completed', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bill_worker_jobs_org ON bill_worker_jobs(organization_id);
CREATE INDEX IF NOT EXISTS idx_bill_worker_jobs_invoice ON bill_worker_jobs(invoice_id, job_type);
CREATE INDEX IF NOT EXISTS idx_bill_worker_jobs_status ON bill_worker_jobs(status, created_at);
```

**Verification:** scratch-DB apply + `\d bill_worker_jobs`.

## Schemas and shared types

- `apps/bill-api/src/db/schema/bill-invoices.ts` (update) — add Drizzle columns for `pdf_generation_locked_at`, `pdf_generation_locked_by`, `overdue_reminder_count`, `overdue_reminder_last_sent_at`.
- `apps/bill-api/src/db/schema/bill-expenses.ts` (update) — add Drizzle columns for `receipt_mime_type`, `receipt_size_bytes`, `receipt_uploaded_at`.
- `apps/bill-api/src/db/schema/bill-worker-jobs.ts` (new) — Drizzle table for bill_worker_jobs.

## API routes and services

### New services

- `apps/bill-api/src/services/sequence.service.ts` (G3) — `acquireAndIncrement(orgId, template)` with Redis lock. Pattern: `SET NX` on `bill:seq:lock:<org_id>`, `INCR bill:seq:<org_id>:<template>`, format invoice_number, release lock in finally. 5-second lock timeout.
- `apps/bill-api/src/plugins/minio.ts` (G4, G5) — MinIO client initialization using `minio` npm package. Exposes `putObject(bucket, key, buffer, opts)` and `getSignedUrl(bucket, key, ttl)` helpers.

### Service updates

- `apps/bill-api/src/services/invoice.service.ts` — `finalizeInvoice()` calls `sequenceService.acquireAndIncrement()` before DB insert. After insert, enqueue `bill-pdf-generate` job. Return invoice with optimistic status.
- `apps/bill-api/src/services/pdf.service.ts` — after generating PDF, upload to MinIO via `fastify.minio.putObject('bill-pdfs', ...)`, store URL in `bill_invoices.pdf_url`.

### New routes

- `POST /expenses/:id/upload-receipt` (G8) — multipart form handler. Parses file via `@fastify/multipart`, uploads to MinIO at `bill-receipts/<org_id>/<expense_id>/<filename>`, updates expense row with URL and metadata.

### Route updates

- `POST /invoices/:id/send` (G2) — enqueue `bill-email-send` job. Return job_id.
- `POST /invoices/:id/finalize` (G1, G3) — use sequence service, enqueue PDF generation job.

## Frontend pages and components

- `apps/bill/src/pages/invoice-from-time.tsx` (update, G6) — query Bam API `/b3/api/projects/:id/time-entries?billable=true` for unbilled entries. Render line item preview table. "Create Invoice" button calls `POST /v1/invoices/from-time-entries` with selected entries.
- `apps/bill/src/pages/expense-new.tsx` (update, G8) — add file input for `receipt`. Upload progress indicator. Receipt thumbnail preview. Multipart POST on submit.
- `apps/bill/src/pages/invoice-detail.tsx` (update, G1, G4) — show PDF generation status (pending, complete, failed). Show download link when PDF ready.
- `apps/bill/src/pages/invoice-list.tsx` (update) — add filter for "unsent" invoices. Show send status badge.

## Worker jobs

### `apps/worker/src/jobs/bill-pdf-generate.job.ts` (new, G1, G4)

Payload: `{ invoice_id, org_id }`.

Pipeline:
1. Insert `bill_worker_jobs` row with status=processing.
2. Fetch invoice from DB.
3. Call `pdfService.generateInvoicePdf(invoice)` to produce PDF buffer.
4. Upload to MinIO: `fastify.minio.putObject('bill-pdfs', '${org_id}/${invoice_id}.pdf', buffer)`.
5. Update `bill_invoices.pdf_url` with signed URL.
6. Mark job row completed.
7. Publish `bill.invoice.generated` Bolt event.

Retry: 3 attempts, exponential backoff. Timeout: 30s.

### `apps/worker/src/jobs/bill-email-send.job.ts` (new, G2)

Payload: `{ invoice_id, org_id, to_email, include_pdf }`.

Pipeline:
1. Fetch invoice.
2. If `include_pdf`, wait for PDF URL (poll briefly) or fetch existing.
3. Compose email using template from `bill_settings` or default.
4. If Blast API is available, call Blast; otherwise SMTP via Nodemailer (existing `email.job.ts` pattern).
5. Update `bill_invoices.sent_at`.
6. Publish `bill.invoice.email_sent` Bolt event.

Retry: 2 attempts. Timeout: 20s.

### `apps/worker/src/jobs/bill-overdue-reminder.job.ts` (new, G9)

Payload: `{ org_id? }` — optional org scope; omit for all-org sweep.

Pipeline:
1. Query `bill_invoices` WHERE status NOT IN ('paid', 'void', 'written_off') AND due_date < NOW() AND (overdue_reminder_last_sent_at IS NULL OR overdue_reminder_last_sent_at < NOW() - INTERVAL '7 days').
2. For each org, fetch billing settings for company name.
3. For each overdue invoice, compose reminder email.
4. Send via Blast or SMTP.
5. Update `overdue_reminder_last_sent_at = NOW()`, increment `overdue_reminder_count`.
6. Publish `bill.invoice.overdue` Bolt event per invoice.

Scheduled: daily at 9 AM UTC via Bolt schedule trigger or BullMQ repeating job.

## MCP tools

No new tools. Existing 16 tools remain. Optional enhancement: `bill_get_invoice_pdf_status(invoice_id)` tool to poll PDF generation status.

## Tests

- `apps/bill-api/src/services/__tests__/sequence.service.test.ts` (new) — concurrent `acquireAndIncrement` calls produce distinct numbers, lock release on error.
- `apps/bill-api/src/services/__tests__/invoice.service.test.ts` (update) — `finalizeInvoice` uses sequence service, enqueues PDF job.
- `apps/worker/src/jobs/__tests__/bill-pdf-generate.test.ts` (new) — mock MinIO, verify upload and URL storage.
- `apps/worker/src/jobs/__tests__/bill-email-send.test.ts` (new) — mock SMTP, verify PDF attachment.
- `apps/worker/src/jobs/__tests__/bill-overdue-reminder.test.ts` (new) — idempotency test (second run doesn't duplicate).
- `apps/bill/src/pages/__tests__/invoice-from-time.test.tsx` (new) — Bam API mock, line item preview, invoice creation.

## Verification steps

```bash
pnpm --filter @bigbluebam/bill-api build
pnpm --filter @bigbluebam/bill-api typecheck
pnpm --filter @bigbluebam/bill-api test
pnpm --filter @bigbluebam/bill typecheck
pnpm --filter @bigbluebam/bill test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations

docker run --rm -d --name bbb-bill-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55496:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55496/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55496/verify' pnpm db:check
docker rm -f bbb-bill-verify
```

**Live smoke tests:** concurrent finalize (10 requests, distinct numbers), PDF job completion, email delivery with attachment, overdue reminder with idempotency, receipt upload, time-entry wizard.

## Out of scope

Multi-currency, expense approval comments, invoice template library, tax immutability snapshots, public token rotation, accounting system export, credit card processing, subscription invoicing, bulk operations.

## Dependencies

- **Redis:** Required for G3 sequence locking.
- **MinIO:** Required for G4, G5 storage.
- **Puppeteer or pdf-lib:** PDF generation library (pdf-lib already in use).
- **Bam API:** `/b3/api/projects/:id/time-entries?billable=true` for G6 (already in use per audit).
- **Bond API:** for G7 auto-invoice automation. Requires Bolt subscription to `deal.closed-won` event.
- **Blast API or SMTP:** for G2 email delivery.

**Migration numbers claimed: 0086, 0087, 0088.** No unused slots.
