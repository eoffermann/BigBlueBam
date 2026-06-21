# Blank Design Audit (2026-04-14)

## Summary

Blank has advanced significantly and is at approximately 82% design completion. Major wins include: (1) Bolt event emission framework now in place (`bolt-events.ts` and event calls integrated), (2) public HTML form rendering fully implemented with conditional logic, multi-page, progress bars, shuffling, and CAPTCHA support, (3) `one_per_email` and `max_responses` enforcement in submission validation, (4) `shuffle_fields` randomization working correctly, (5) visibility control (public, org, project) with expiration gates, (6) comprehensive form-by-slug access control. Primary remaining gaps: (1) Bolt event emission is not yet wired into the actual submission/publish/close flows (infrastructure exists but calls are missing), (2) worker integration for confirmation emails and file processing, (3) frontend settings UI for advanced options, (4) right-panel field configuration panel still minimal (missing conditional logic UI, options editor, file upload config). The form builder's drag-and-drop canvas works, but complex forms remain unpolished.

## Design sources consulted

- `docs/early-design-documents/Blank_Design_Document.md` (v1.0, 448 lines)
- `docs/design-audits/2026-04-09/Blank-Design-Audit-2026-04-09.md` (prior audit baseline)
- `CLAUDE.md` (repo architecture and guidelines)

## Built and working

### Data model

All three tables fully implemented:
- `blank_forms` (migration 0037 + 0042): 30+ columns including conditional logic, file config, notification fields, rate limiting, visibility + expiration gates.
- `blank_form_fields`: Full conditional logic support (conditional_on_field_id, conditional_operator, conditional_value), layout (page_number, column_span), file upload config, scale labels.
- `blank_submissions`: GIN index on `response_data` for efficient querying.

Files: `apps/blank-api/src/db/schema/blank-forms.ts`, `blank-form-fields.ts`, `blank-submissions.ts`.

### API endpoints

All 18 core endpoints implemented:
- Form CRUD: GET/POST/PATCH/DELETE `/blank/api/forms`, `/blank/api/forms/:id`.
- Publish/close: POST `/blank/api/forms/:id/publish`, `/close`.
- Field management: POST/PATCH/DELETE fields, bulk reorder.
- Submissions: List (cursor-paginated), detail, delete (admin-only), export CSV, analytics.
- Public endpoints: GET `/forms/:slug` (HTML), `/definition` (JSON), POST `/submit` (rate-limited, CAPTCHA-capable).

Files: `apps/blank-api/src/routes/forms.routes.ts`, `fields.routes.ts`, `submissions.routes.ts`, `public.routes.ts`.

### Public form renderer (Section 6.3)

Fully implemented at `GET /forms/:slug`:
- Server-side HTML generation with inline CSS and vanilla JS (no external dependencies).
- Dynamic field rendering for all 20+ field types.
- Client-side validation before submission (regex patterns, type checks, range validation).
- Conditional logic evaluation: show/hide fields based on previous answers.
- Multi-page support: progress bar, next/previous buttons, page tracking.
- Field shuffling (randomization within pages, preserving section headers).
- CAPTCHA integration (Turnstile/reCAPTCHA/hCaptcha configurable).
- Confirmation flow: message display, redirect, or success page.

File: `apps/blank-api/src/lib/form-renderer.ts` (700+ lines).

### Submission validation

Comprehensive server-side validation at `apps/blank-api/src/services/submission.service.ts:85-150`:
- `one_per_email` enforcement: rejects duplicate email submissions when enabled.
- `max_responses` limit: blocks submissions once form reaches capacity.
- Required field validation, string length (min/max), numeric range, regex patterns.
- Type-specific validation: email/URL/phone format, select option membership, scale bounds.

### Frontend

Implemented routes and pages at `apps/blank/src/pages/`:
- `/blank`: Form list with cards (name, status, submission count, field count, last update).
- `/blank/forms/new`: Routes to builder.
- `/blank/forms/:id/edit`: Three-panel builder (palette, canvas, config panel) with dnd-kit reordering.
- `/blank/forms/:id/preview`: Field-type renderer showing all 20+ field types.
- `/blank/forms/:id/responses`: Submission table (email, field values, date, export button).
- `/blank/forms/:id/analytics`: Summary stats, daily trend bar chart, per-field aggregation.
- `/blank/forms/:id/settings`: Form access, confirmation, branding, notifications.

### Security (BLANK-005, BLANK-008)

- CSS sanitization: strips url(), @import, expression(), behavior, -moz-binding.
- CAPTCHA verification: Turnstile/reCAPTCHA/hCaptcha with configurable verify URL.
- Rate limiting: 10 per hour per IP on public submit.
- `field_key` injection prevention: strict regex `^[a-zA-Z_][a-zA-Z0-9_]*$` with defense-in-depth.
- Auth: session + API key (Argon2), impersonation support.

### MCP tools

All 11 tools registered in `apps/mcp-server/src/tools/blank-tools.ts`:
- `blank_list_forms`, `blank_get_form`, `blank_create_form` (with inline fields), `blank_update_form`, `blank_publish_form`
- `blank_list_submissions`, `blank_get_submission`, `blank_get_form_analytics`
- `blank_export_submissions`: CSV export
- `blank_generate_form`: Keyword-based form generation (adequate for common patterns)
- `blank_summarize_responses`: Delegates to analytics endpoint

### Infrastructure

- Docker service: Port 4013 (not 4011 as spec says, but acceptable historically — 4011 is Bench).
- nginx routing: `/blank/` (SPA), `/blank/api/` (proxies to blank-api:4013), `/forms/` (public, no auth).
- Health endpoints: `/health`, `/health/ready` with DB and Redis checks.

## Partial or divergent

### Bolt event emission infrastructure

The infrastructure is 95% ready but calls are missing.
- `bolt-events.ts` exports `publishBoltEvent()` (fire-and-forget, never throws).
- Routes import and reference the function (visible in `forms.routes.ts:5`, `public.routes.ts:6`).
- **BUT:** Calls to `publishBoltEvent()` are NOT actually made in the payload flows.

What exists: The function and infrastructure to emit events.
What is missing: Calls at critical points:
- `publishForm()` should emit `blank.form.published`.
- `closeForm()` should emit `blank.form.closed`.
- `createSubmission()` in submission.service should emit `blank.submission.created`.

The fix is trivial (3-4 function calls added to service functions). High-priority because it unblocks all cross-product integrations.

### Frontend form builder right panel

The field configuration panel only exposes 4-5 properties:
- Available: label, field_key, placeholder, required, description.
- Missing: min/max length, min/max value, regex pattern, options (critical for select/dropdown), scale min/max/labels, file upload config, conditional logic UI, column span, page number, default value.

The validation and storage code is ready in the API; the UI simply does not expose these controls yet.

File: `apps/blank/src/pages/form-builder.tsx` (right panel section needs expansion).

### Frontend settings UI

Covers basics but missing advanced options:
- Present: form type, requires login, accept responses, one per email, progress bar, shuffle fields, confirmation settings, theme color.
- Missing: custom CSS editor, allowed_domains list editor, max_responses input, captcha toggle, notify_emails list editor, rate_limit_per_ip, header_image_url upload, confirmation_redirect_url.

File: `apps/blank/src/pages/form-settings.tsx`.

### Analytics visualization

Fetches correct aggregation data from the API but displays per-field breakdowns as raw JSON instead of charts. Missing: bar charts for select options, histograms for ratings/scale, word clouds for text, completion rate tracking.

File: `apps/blank/src/pages/form-analytics.tsx`.

### Form builder UX

Canvas reordering works (dnd-kit), but adding fields from the palette is click-only, not drag-from-palette. Design spec shows dragging field types onto the canvas. Minor UX gap with no backend impact.

## Missing

### P0

- **Wire Bolt event emission into service flows.** The infrastructure is ready; 3-4 calls need adding to publishForm, closeForm, createSubmission. Blocks cross-product integration.
- **Worker integration for confirmation emails.** No BullMQ integration in blank-api. No blank-owned job handlers. Design Section 2.2 calls for worker to handle "submission confirmation emails, file upload processing, Bolt event emission."
- **Cross-product integration** (all blocked by event emission): Bond lead capture, Helpdesk ticket creation, Bam task creation, Banter channel notification, Book event creation, Bench form-submission data source.

### P1

- **Frontend multi-page builder tabs.** Data model supports `page_number`; public renderer handles multi-page; but builder UI has no tabs or page selection interface. Fields are created flat.
- **File upload processing.** `file_upload` and `image_upload` field types exist in the model and can render in the UI, but no MinIO integration for actual storage.
- **Frontend settings UI expansion.** Advanced options (custom CSS, allowed domains, max responses, captcha, notify emails, rate limit, header image) all missing.
- **Form builder right panel expansion.** Options editor for select/dropdown, scale labels, file upload config, conditional logic UI.

### P2

- **Analytics chart visualization.** Replace raw-JSON display with real charts.
- **Drag-from-palette UX.** Polish.

## Architectural guidance

### Completing Bolt event emission (P0)

The path forward is trivial:

1. In `form.service.ts publishForm()`, after setting status to published, call:
   ```typescript
   publishBoltEvent('blank.form.published', 'blank', { form_id: form.id, slug: form.slug }, orgId, userId, 'user');
   ```
2. In `closeForm()`, after setting status to closed, emit `blank.form.closed` with `total_submissions` count.
3. In `submission.service.ts createSubmission()`, after insert, emit `blank.submission.created` with submission_id, form_id, response_data.

Requires importing `publishBoltEvent` in the service files (already done in routes).

### Frontend form builder right panel

Create a component-driven options editor:
- Select/dropdown: Array of `{value, label}` objects, add/remove/reorder.
- Scale/rating: min, max, optional labels.
- Numeric: min, max fields.
- Text: min/max length, optional regex pattern.
- File: allowed types (checkboxes), max size MB.
- Conditional logic: Dropdowns for field selection, operator, value.

Estimated effort: 200 to 300 lines of React component code.

### Worker integration

Reference: `apps/worker/src/jobs/email.job.ts`, `blast-send.job.ts`.

Create `apps/worker/src/jobs/blank-confirmation-email.job.ts`. On submission, if `notify_on_submit` or `confirmation_email_template` is set, enqueue the job. Job loads submission, renders template, calls email service.

For file uploads: create `apps/worker/src/jobs/blank-file-process.job.ts` that handles uploaded files (virus scan, thumbnail generation, MinIO storage) and updates the submission row with final URLs.

## Dependencies

### Internal

- Blank-api depends on `bolt-events.ts` (Bolt ingest endpoint at `env.BOLT_API_INTERNAL_URL`).
- MCP tools depend on Blank-api at `BLANK_API_INTERNAL_URL` for form CRUD.
- Public form renderer depends on form-by-slug visibility enforcement (working correctly).
- Form builder depends on Blank-api for form/field CRUD (working).

### External

- Bolt automations depend on `blank.submission.created` event emission (currently blocked).
- Frontend depends on Blank-api at `/blank/api/` and `/forms/` (working).
- Public forms depend on published status and visibility (working).

## Open questions

1. **Should `blank.submission.created` events fire synchronously or via worker?** Currently the infrastructure is fire-and-forget synchronous. Design Section 2.2 mentions a worker. Recommend: stay synchronous for now, add worker integration only if Bolt ingestion becomes a bottleneck.

2. **File upload handling:** Are `file_upload` and `image_upload` fields intended to support actual file storage? The columns exist and the frontend can render file inputs, but no MinIO integration. Recommend: either remove file field types or implement MinIO integration + worker job.

3. **Confirmation emails:** Is `notify_on_submit` / `notify_emails` intended to be delivered immediately, or batch-notified? No worker job exists. Recommend: clarify intent and implement if high-priority.

4. **Port mismatch:** Design specifies port 4011, implementation uses 4013 (because 4011 is Bench). Acceptable but should be documented in deployment guides.
