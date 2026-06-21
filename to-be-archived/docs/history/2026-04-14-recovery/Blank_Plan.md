# Blank Implementation Plan (2026-04-14)

## Scope

Closes gaps from the 2026-04-14 Blank Design Audit. Blank is 82% complete at `a5147ce`. All core backend infrastructure is functional: form CRUD, submission validation, public rendering with conditional logic, multi-page support, field shuffling, CAPTCHA, and MCP tools. Form builder canvas works. This plan completes three critical infrastructure layers: Bolt event emission wiring (unblocks all cross-product integration), worker integration for confirmation emails and file processing, and frontend expansion for advanced form configuration and multi-page builder UX.

**In scope (P0):** wire `publishBoltEvent()` calls into `publishForm()`, `closeForm()`, and `createSubmission()`; implement confirmation email worker job; enable cross-product integrations (Bond lead capture, Helpdesk tickets, Bam tasks, Banter posts) unblocked by event emission. **In scope (P1):** file upload processing with MinIO; form builder right panel expansion; settings UI expansion; multi-page builder tabs. **In scope (P2):** analytics chart visualization.

**Out of scope:** drag-from-palette polish, Bench data source registration, offline submission, email template visual editor.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §Bolt event emission infrastructure | Wire `publishBoltEvent()` calls in publishForm, closeForm, createSubmission |
| G2 | P0 | audit §Worker integration | `blank-confirmation-email.job.ts` worker for notify_on_submit and confirmation emails |
| G3 | P0 | audit §Cross-product integration | Unblocks Bond lead capture, Helpdesk tickets, Bam tasks, Banter posts via G1 |
| G4 | P1 | audit §File upload processing | MinIO integration for file_upload and image_upload field types via worker job |
| G5 | P1 | audit §Frontend form builder right panel | Expand field config panel with options editor, conditional logic UI, file upload config |
| G6 | P1 | audit §Frontend settings UI | Custom CSS, allowed domains, max responses, captcha toggle, notify emails, rate limit, header image |
| G7 | P1 | audit §Multi-page builder | Page tab UI for assigning fields to pages |
| G8 | P2 | audit §Analytics visualization | Replace raw JSON with bar charts, histograms, completion rate tracking |

## Migrations

**Reserved slots: 0089, 0090.**

### 0089_blank_file_processing_status.sql

**Body:**
```sql
-- 0089_blank_file_processing_status.sql
-- Why: Enable worker jobs to track file upload processing state and errors. Store MinIO URLs after successful processing.
-- Client impact: additive only. New nullable columns and JSONB field for file metadata.

ALTER TABLE blank_submissions
  ADD COLUMN IF NOT EXISTS file_processing_status VARCHAR(20) DEFAULT 'pending';

ALTER TABLE blank_submissions
  ADD COLUMN IF NOT EXISTS file_processing_error TEXT;

ALTER TABLE blank_submissions
  ADD COLUMN IF NOT EXISTS processed_files JSONB DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blank_submissions_file_status_check') THEN
    ALTER TABLE blank_submissions
      ADD CONSTRAINT blank_submissions_file_status_check
      CHECK (file_processing_status IN ('pending', 'in_progress', 'completed', 'failed', 'skipped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_blank_submissions_file_status
  ON blank_submissions (file_processing_status)
  WHERE file_processing_status IN ('pending', 'in_progress');
```

### 0090_blank_submission_event_emission.sql

**Body:**
```sql
-- 0090_blank_submission_event_emission.sql
-- Why: Track Bolt event emission success for idempotency on worker retries. Prevent duplicate event publishing.
-- Client impact: additive only. New nullable columns for idempotency tracking.

ALTER TABLE blank_submissions
  ADD COLUMN IF NOT EXISTS bolt_events_emitted BOOLEAN DEFAULT false;

ALTER TABLE blank_submissions
  ADD COLUMN IF NOT EXISTS bolt_event_emit_error TEXT;

CREATE INDEX IF NOT EXISTS idx_blank_submissions_bolt_events_pending
  ON blank_submissions (bolt_events_emitted)
  WHERE bolt_events_emitted = false;
```

## Schemas and shared types

No new shared schemas. All types remain local to `apps/blank-api/src/` and `apps/worker/src/`.

## API routes and services

### Service updates

**`apps/blank-api/src/services/form.service.ts`** (G1):
- Import `publishBoltEvent` from `../lib/bolt-events.js`.
- In `publishForm(id, orgId)`, after status update, emit `blank.form.published` event with `{ form_id, slug, form_type }`.
- In `closeForm(id, orgId)`, after status update, count submissions and emit `blank.form.closed` with `{ form_id, slug, total_submissions }`.

**`apps/blank-api/src/services/submission.service.ts`** (G1, G2):
- Import `publishBoltEvent` and BullMQ queue.
- In `createSubmission(formId, orgId, input)`, after insert, emit `blank.submission.created` with `{ submission_id, form_id, form_slug, response_data, submitted_by_email }`.
- If form has `notify_on_submit` or `confirmation_email_template`, enqueue `blank-confirmation-email` job with `{ submission_id, form_id, org_id }`.
- If submission contains file upload fields, enqueue `blank-file-process` job.

## Frontend pages and components

### New component: `apps/blank/src/components/field-config-panel.tsx` (G5)

Props: `field: BlankField`, `onUpdate: (field: BlankField) => void`.

Renders controls for: label, field_key, placeholder, required, description, min/max length, min/max value, regex pattern, options array (add/remove/reorder for select/dropdown), scale min/max/labels, file upload config (allowed types, max size), conditional logic (on_field, operator, value), layout (page_number, column_span), default_value for hidden fields.

Replace existing minimal right panel in `form-builder.tsx`.

### Page updates

- **`form-builder.tsx`** (G7) — add page tabs above canvas. Each tab shows a page number. Click switches canvas filter to show only fields with that `page_number`. Create/delete/rename page. Drag from palette prompts modal for target page.
- **`form-settings.tsx`** (G6) — add sections: Advanced (custom CSS textarea, allowed_domains, max_responses), Notifications (notify_on_submit, notify_emails tags input, rate_limit_per_ip), Branding (header_image_url upload, confirmation_redirect_url), Captcha (captcha_enabled toggle, provider select).
- **`form-analytics.tsx`** (G8, optional P2) — add Recharts bar charts for select options, histograms for rating/scale, completion rate computation.

## Worker jobs

### `apps/worker/src/jobs/blank-confirmation-email.job.ts` (new, G2)

Payload: `{ submission_id, form_id, org_id }`.

Pipeline:
1. Fetch submission + form.
2. If `form.confirmation_email_template` set, render with `response_data` substitutions.
3. Send confirmation email to submitter via Nodemailer (pattern from `banter-notification.job.ts`).
4. If `form.notify_on_submit` set, send notification to each address in `form.notify_emails` with submission summary.
5. On success: no DB update needed. On failure: log to `blank_submissions.bolt_event_emit_error`.

### `apps/worker/src/jobs/blank-file-process.job.ts` (new, G4)

Payload: `{ submission_id, form_id, org_id }`.

Pipeline:
1. Fetch submission + form.
2. Update `file_processing_status = 'in_progress'`.
3. For each file field in `response_data`:
   - Download file from temp upload URL.
   - Virus scan (optional, ClamAV integration; can skip in Phase 1 with stub).
   - Generate thumbnail for image uploads (sharp library).
   - Upload to MinIO at `blank/<org_id>/<form_id>/<field_key>/<submission_id>/<filename>`.
   - Collect metadata into `processed_files` JSONB.
4. Update `file_processing_status = 'completed'`, store `processed_files`.
5. On failure: `file_processing_status = 'failed'`, error in `file_processing_error`.

### Job registration

`apps/worker/src/index.ts` (update) — register both new handlers.

## MCP tools

No changes to existing 11 Blank MCP tools. Event emission is internal; no tool-level exposure needed.

## Tests

- `apps/blank-api/src/services/__tests__/form.service.test.ts` (update) — verify publish/close emit Bolt events with expected payloads.
- `apps/blank-api/src/services/__tests__/submission.service.test.ts` (update) — verify createSubmission emits event and enqueues worker job.
- `apps/worker/src/jobs/__tests__/blank-confirmation-email.test.ts` (new) — mock SMTP, template rendering, failure handling.
- `apps/worker/src/jobs/__tests__/blank-file-process.test.ts` (new) — mock MinIO upload, virus scan, thumbnail generation.
- `apps/blank/src/pages/__tests__/form-builder.test.tsx` (update) — page tabs render, create/delete/switch pages, drag field to page.
- `apps/blank/src/pages/__tests__/form-settings.test.tsx` (update) — advanced, notifications, branding, captcha sections render and sync.

## Verification steps

```bash
pnpm --filter @bigbluebam/blank-api build
pnpm --filter @bigbluebam/blank-api typecheck
pnpm --filter @bigbluebam/blank-api test
pnpm --filter @bigbluebam/blank typecheck
pnpm --filter @bigbluebam/blank test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations

docker run --rm -d --name bbb-blank-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55495:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55495/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55495/verify' pnpm db:check
docker rm -f bbb-blank-verify
```

**Live smoke tests:** publish form, verify Bolt event received; submit form, verify `blank.submission.created` reaches Bolt and confirmation email job enqueued; submit form with file, verify file-process job runs and stores MinIO URLs; close form, verify `blank.form.closed` with submission count; create Bond automation triggered by submission event, verify contact created.

## Out of scope

Drag-from-palette polish (click-only works), Bench data source registration (Wave 3), offline submission, email template visual editor, advanced statistical analytics, form duplication API completion, ClamAV virus scanning integration (placeholder stub acceptable for Phase 1).

## Dependencies

- **BullMQ:** existing dependency.
- **Nodemailer:** existing dependency (via worker).
- **MinIO:** existing infra. New bucket `blank-uploads` or reuse existing.
- **sharp:** for image thumbnail generation.
- **Bolt API ingest:** at `${env.BOLT_API_INTERNAL_URL}/v1/events/ingest`.
- **Recharts (or similar):** for P2 analytics visualization (optional).

**Migration numbers claimed: 0089, 0090.** No unused slots.
