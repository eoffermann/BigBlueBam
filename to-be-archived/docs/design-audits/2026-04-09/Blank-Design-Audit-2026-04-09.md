# Blank (Forms & Surveys) Design Audit

**Date:** 2026-04-09
**Auditor:** Claude (automated)
**Design Document:** `docs/DO_NOT_CHECK_IN_YET/Blank_Design_Document.md` v1.0
**Implementation:** `apps/blank-api/src/` (18 files), `apps/blank/src/` (20 files), `apps/mcp-server/src/tools/blank-tools.ts`

---

## Executive Summary

**Overall Completion: ~72%**

Blank has a solid foundation. All three database tables match the design spec exactly, all 18 API endpoints are implemented, the form builder with drag-and-drop works, and all 11 MCP tools are registered. The primary gaps are in **Bolt event emission** (no events are actually fired), **worker integration** (no BullMQ jobs for confirmation emails or file processing), **public form HTML rendering** (the `GET /forms/:slug` HTML endpoint is missing -- only the JSON definition endpoint exists), **one_per_email enforcement**, **max_responses enforcement**, **shuffle_fields implementation**, and several frontend polish items (multi-page support in builder, conditional logic UI, field options editor, completion rate tracking). The permission model is partially implemented (role checks exist but do not match the granular matrix in the spec).

---

## Feature Rating Table

Rating scale: P0 = not implemented, P1 = stub/placeholder only, P2 = partial (<50%), P3 = mostly done (50-80%), P4 = nearly complete (80-95%), P5 = fully matches design.

### Data Model (Section 3)

| Feature | Rating | Notes |
|---------|--------|-------|
| `blank_forms` table | P5 | All columns match spec exactly. Migration 0037 is idempotent. |
| `blank_form_fields` table | P5 | All columns including conditional logic, file upload config, layout. |
| `blank_submissions` table | P5 | All columns including GIN index on response_data. |
| Drizzle ORM schema files | P4 | All three schema files match SQL. Missing: `idx_blank_forms_slug` partial index not in Drizzle (exists in migration). |
| Unique constraint `(organization_id, slug)` | P5 | In migration as `blank_forms_org_slug_unique`. |

### API Endpoints (Section 4)

| Endpoint | Rating | Notes |
|----------|--------|-------|
| `GET /blank/api/forms` | P5 | Filters by status, project_id. Returns submission_count, field_count. |
| `POST /blank/api/forms` | P5 | Creates form with inline fields. Zod validation. |
| `GET /blank/api/forms/:id` | P5 | Returns form + fields + submission_count. |
| `PATCH /blank/api/forms/:id` | P5 | All metadata fields updatable. CSS sanitization (BLANK-005). |
| `DELETE /blank/api/forms/:id` | P5 | Org-scoped delete. |
| `POST /blank/api/forms/:id/publish` | P4 | Works. Validates fields exist. Missing: Bolt event emission (`blank.form.published`). |
| `POST /blank/api/forms/:id/close` | P4 | Sets status + accept_responses. Missing: Bolt event emission (`blank.form.closed`). |
| `POST /blank/api/forms/:id/duplicate` | P5 | Clones form + all fields with unique slug. |
| `GET /blank/api/forms/:id/embed-code` | P5 | Returns URL + iframe HTML snippet. |
| `POST /blank/api/forms/:id/fields` | P5 | Full field creation with all properties. |
| `PATCH /blank/api/fields/:id` | P5 | Org-scoped update via join. |
| `DELETE /blank/api/fields/:id` | P5 | Org-scoped delete via join. |
| `POST /blank/api/forms/:id/fields/reorder` | P5 | Bulk sort_order update. |
| `GET /blank/api/forms/:id/submissions` | P5 | Cursor-based pagination. |
| `GET /blank/api/submissions/:id` | P5 | Org-scoped. |
| `DELETE /blank/api/submissions/:id` | P5 | Admin-only. |
| `GET /blank/api/forms/:id/submissions/export` | P5 | Full CSV export with proper escaping. |
| `GET /blank/api/forms/:id/analytics` | P4 | Has total, daily trend, per-field breakdowns (option counts, numeric stats, text counts). Missing: completion rate tracking. |
| `GET /forms/:slug` (HTML render) | P0 | **Not implemented.** Only `/forms/:slug/definition` (JSON) and `/forms/:slug/submit` exist. Design calls for server-rendered HTML at this path. |
| `GET /forms/:slug/definition` | P5 | Returns full field definitions for SPA rendering. |
| `POST /forms/:slug/submit` | P4 | Rate-limited, validates response_data, CAPTCHA support (BLANK-008). Missing: Bolt event emission, one_per_email enforcement, max_responses enforcement. |

### Submission Validation (Implicit in Section 3+4)

| Feature | Rating | Notes |
|---------|--------|-------|
| Required field validation | P5 | Server-side in `validateResponseData`. |
| Email/URL/phone format validation | P5 | Regex-based. |
| Numeric range validation (min_value/max_value) | P5 | Implemented for number, rating, scale, nps. |
| Scale min/max enforcement | P5 | Checked for rating and scale types. |
| Select option validation | P5 | Validates against defined options. |
| String length validation (min_length/max_length) | P5 | For short_text and long_text. |
| Regex pattern validation | P5 | Applied to any field type with a pattern. |
| one_per_email dedup | P0 | **Not implemented.** Column exists but not enforced on submit. |
| max_responses limit | P0 | **Not implemented.** Column exists but not checked on submit. |
| shuffle_fields randomization | P0 | **Not implemented.** Column exists, not used in getFormBySlug or definition endpoint. |

### Bolt Integration / Events (Section 7)

| Feature | Rating | Notes |
|---------|--------|-------|
| `blank.form.published` event | P0 | **Not implemented.** No event emission anywhere in blank-api. |
| `blank.form.closed` event | P0 | **Not implemented.** |
| `blank.submission.created` event | P0 | **Not implemented.** This is described as the primary integration point. |

### Worker / BullMQ Integration (Section 2.2)

| Feature | Rating | Notes |
|---------|--------|-------|
| Submission confirmation emails | P0 | **Not implemented.** No BullMQ integration in blank-api. No blank jobs in worker. |
| File upload processing | P0 | **Not implemented.** No MinIO upload handling. |
| Bolt event emission via worker | P0 | **Not implemented.** |

### MCP Tools (Section 5)

| Tool | Rating | Notes |
|------|--------|-------|
| `blank_list_forms` | P5 | Filters by status/project. |
| `blank_get_form` | P5 | Returns full definition. |
| `blank_create_form` | P5 | Supports inline fields. |
| `blank_generate_form` | P3 | Keyword-based pattern matching. Works for common patterns (name, email, NPS, rating, feedback, bug). Not truly AI-powered -- uses simple string matching. Adequate for basic use. |
| `blank_update_form` | P5 | Updates metadata. |
| `blank_publish_form` | P5 | Publishes draft. |
| `blank_list_submissions` | P5 | Paginated. |
| `blank_get_submission` | P5 | Full detail. |
| `blank_summarize_responses` | P4 | Delegates to analytics endpoint. Not truly "summarizing" (no AI text summary of open-text responses). |
| `blank_export_submissions` | P5 | CSV export. |
| `blank_get_form_analytics` | P5 | Full analytics data. |

### Frontend Routes (Section 6.1)

| Route | Rating | Notes |
|-------|--------|-------|
| `/blank` (Form list) | P5 | Cards with name, status, response count, field count, last update. |
| `/blank/forms/new` | P5 | Routes to builder with id='new'. |
| `/blank/forms/:id/edit` (Builder) | P3 | Three-panel layout works (palette, canvas, config). Missing: drag from palette (click-to-add only), multi-page tabs, conditional logic UI in config panel, options editor for select/dropdown, live preview toggle. |
| `/blank/forms/:id/preview` | P4 | Renders all field types visually. Missing: actual submission capability (button is non-functional), conditional logic evaluation, progress bar for multi-page. |
| `/blank/forms/:id/responses` | P4 | Table view with submissions, email, field values, date. Export button. Missing: individual detail view (click-to-expand), delete submission UI. |
| `/blank/forms/:id/analytics` | P3 | Summary cards, daily trend bar chart, per-field breakdown (raw JSON display). Missing: proper chart rendering for option counts, rating histograms, word cloud. Completion rate not tracked. |
| `/blank/forms/:id/settings` | P4 | Covers access (form_type, accept_responses, one_per_email), confirmation, branding (theme color, progress bar), notifications. Missing: custom_css editor, allowed_domains, max_responses, captcha toggle, notify_emails list editor, rate_limit_per_ip, redirect URL, header_image_url upload. |

### Frontend Form Builder (Section 6.2)

| Feature | Rating | Notes |
|---------|--------|-------|
| Left panel: Field type palette | P4 | All 20 field types listed. Click to add. Missing: drag from palette onto canvas. |
| Center panel: Form canvas | P4 | Sortable via dnd-kit. Inline title/description editing. Missing: multi-page tabs, page navigation. |
| Right panel: Field configuration | P2 | Only label, key, placeholder, required. Missing: description, validation rules (min/max length, regex), options editor, scale config, file upload config, conditional logic, column span, page number, default value. |
| Multi-page support | P0 | **Not implemented** in UI. Data model supports it (page_number column). |
| Live preview toggle | P0 | **Not implemented.** Design calls for split-screen builder + live preview. |

### Public Form Renderer (Section 6.3)

| Feature | Rating | Notes |
|---------|--------|-------|
| Standalone SPA at `/forms/:slug` | P0 | **Not implemented.** No separate public form renderer app. The nginx config proxies `/forms/` to blank-api, but only the JSON definition endpoint exists. |
| Dynamic field rendering | P0 | No client-side renderer for public forms. |
| Client-side conditional logic | P0 | Not implemented. |
| Client-side validation | P0 | Not implemented (server-side exists). |
| Progress bar for multi-page | P0 | Not implemented. |
| Embeddable via iframe | P2 | Embed code endpoint exists, but the target URL (`/forms/:slug`) does not render anything. |

### Permissions (Section 9)

| Feature | Rating | Notes |
|---------|--------|-------|
| View forms (all roles) | P5 | `requireAuth` only. |
| Create/edit forms (Admin, Manager, Member) | P4 | Uses `requireScope('read_write')`. Does not check Viewer exclusion at role level. |
| Publish forms (Admin, Manager only) | P5 | Uses `requireMinRole('admin')`. |
| Delete forms (Admin, Manager, own-only for Member) | P2 | Uses `requireScope('read_write')` -- does not enforce "own only" for Members. |
| Delete submissions (Admin, Manager) | P5 | Uses `requireMinRole('admin')`. |
| Export submissions (Admin, Manager, Member) | P3 | Only uses `requireAuth` -- Viewers can also export, which contradicts spec. |

### Infrastructure (Section 2)

| Feature | Rating | Notes |
|---------|--------|-------|
| Docker service | P4 | Exists in docker-compose.yml. Port is 4013 (design says 4011, but 4011 is used by Bench). |
| nginx routing `/blank/` | P5 | SPA routing with try_files. |
| nginx routing `/blank/api/` | P5 | Proxies to blank-api:4013. |
| nginx routing `/forms/` | P5 | Proxies to blank-api:4013/forms/. |
| Redis integration | P4 | Redis plugin registered for rate limiting. Not used for submission count caching as spec suggests. |
| Health endpoints | P5 | `/health` and `/health/ready` with DB + Redis checks. |

### Cross-Product Integration (Section 8)

| Feature | Rating | Notes |
|---------|--------|-------|
| Bond integration (lead capture) | P0 | No event emission, so no Bolt automation trigger. |
| Helpdesk integration (ticket creation) | P0 | Same -- blocked by missing events. |
| Bam integration (task creation) | P0 | Same. |
| Banter integration (channel posting) | P1 | `notify_banter_channel_id` column exists but is never used. |
| Book integration (event creation) | P0 | No implementation. |
| Bench integration (data source) | P0 | No implementation. |

### Security

| Feature | Rating | Notes |
|---------|--------|-------|
| CSS sanitization (custom_css) | P5 | BLANK-005: Strips url(), @import, expression(), behavior, -moz-binding. |
| CAPTCHA verification | P5 | BLANK-008: Turnstile/reCAPTCHA/hCaptcha with configurable verify URL. |
| Rate limiting (public submit) | P5 | 10 per hour per IP on submit endpoint. |
| field_key injection prevention | P5 | Safe identifier regex + defense-in-depth check before sql.raw() in analytics. |
| Auth (session + API key) | P5 | Full auth plugin with Argon2 API key verification, impersonation support. |
| Security headers | P5 | X-Content-Type-Options, X-Frame-Options, Cache-Control. |

---

## Detailed Findings for P0-P3 Items

### P0: Bolt Event Emission (Critical)

The design spec identifies `blank.submission.created` as "the primary integration point" for the entire suite. Neither `publishForm`, `closeForm`, nor `createSubmission` emit any events. There is no BullMQ queue producer in blank-api, and no blank-related job handler in the worker service. This blocks all cross-product integrations (Bond lead capture, Helpdesk ticket creation, Bam task creation, Banter posting).

**Files affected:**
- `apps/blank-api/src/services/form.service.ts` (publishForm, closeForm)
- `apps/blank-api/src/services/submission.service.ts` (createSubmission)
- `apps/worker/src/` (no blank job handler)

**Recommendation:** Add a BullMQ producer to blank-api. Emit `blank.submission.created` in `createSubmission`, `blank.form.published` in `publishForm`, `blank.form.closed` in `closeForm`. Create a worker job handler to relay events to Bolt.

### P0: Public Form Renderer

The design describes a standalone lightweight React app at `/forms/:slug` that fetches the form definition and renders a fully functional form with client-side validation, conditional logic, and progress bars. Currently, only the JSON API endpoints exist (`/forms/:slug/definition` and `/forms/:slug/submit`). The nginx config proxies `/forms/` to blank-api, but there is no HTML-serving route.

**Recommendation:** Either (a) create a minimal standalone React app/bundle served by blank-api at `GET /forms/:slug`, or (b) serve a static HTML page that bootstraps a tiny renderer using the definition endpoint.

### P0: one_per_email / max_responses / shuffle_fields

All three columns exist in the database and are settable via PATCH, but none are enforced:
- `one_per_email`: No check in `createSubmission` for duplicate email.
- `max_responses`: No check in `createSubmission` or `POST /forms/:slug/submit` for count limit.
- `shuffle_fields`: Not applied when returning fields in `getFormBySlug`.

**Recommendation:** Add enforcement in `createSubmission` and/or the public submit route. shuffle_fields can be applied in `getFormBySlug` by randomizing the field array before returning.

### P0: Multi-Page Support in Builder UI

The data model fully supports multi-page forms (page_number column), but the form builder UI has no page tabs, no page navigation, and no way to assign fields to pages.

### P0: Live Preview Toggle in Builder

Design calls for a split-screen showing builder on left and live rendered form on right. Not implemented.

### P0: Worker Integration (Confirmation Emails, File Processing)

No BullMQ integration exists in blank-api. No confirmation email job, no file upload processing pipeline, no MinIO upload handling for file_upload/image_upload field types.

### P2: Right Panel Field Configuration

The field configuration panel only exposes 4 of ~15 configurable properties (label, key, placeholder, required). Missing: description, min/max length, min/max value, regex pattern, options editor (critical for select/dropdown), scale min/max/labels, file upload config, conditional logic, column span, page number, default value.

### P3: Form Builder Drag-and-Drop

Fields on the canvas are reorderable via dnd-kit (good), but adding fields from the palette is click-only, not drag-from-palette as the design specifies. This is a minor UX gap.

### P3: Analytics Visualization

The analytics page fetches correct data from the API but displays per-field breakdown as raw JSON. The design calls for bar charts for select fields, histograms for ratings, and optionally word clouds for text.

### P3: blank_generate_form MCP Tool

Uses simple keyword matching rather than AI generation. Works adequately for common patterns but cannot handle arbitrary descriptions like "employee onboarding questionnaire with department selection and start date."

---

## P4-P5 Items (Brief)

**P5 (Fully Matches Design):**
- All three database tables and migration
- 13 of 18 API endpoints (list, create, get, update, delete, duplicate, embed-code, add/update/delete field, reorder, list/get/delete submissions, export CSV)
- Form list page with cards, status badges, counts
- MCP tools: list_forms, get_form, create_form, update_form, publish_form, list_submissions, get_submission, export_submissions, get_form_analytics
- CSS sanitization, CAPTCHA, rate limiting, field_key injection prevention
- nginx routing, Docker service, health endpoints

**P4 (Nearly Complete):**
- Publish/close endpoints (work but no event emission)
- Public submit endpoint (works but missing one_per_email/max_responses enforcement)
- Analytics endpoint (data correct, missing completion rate)
- Form preview page (renders all field types, non-functional submit button)
- Form responses page (table view, export; missing detail view)
- Form settings page (most settings; missing several advanced options)
- Drizzle schema (matches SQL, minor index gap)
- Field palette (all 20 types, click-to-add)

---

## Recommendations (Priority Order)

1. **Bolt event emission** -- Unblocks all cross-product integrations. Highest business value.
2. **Public form renderer** -- Without it, published forms cannot be accessed by respondents. Core functionality gap.
3. **Enforce one_per_email, max_responses** -- Data integrity; columns exist but are decorative.
4. **Right panel field configuration** -- The builder is barely usable without options editor, scale config, or conditional logic UI.
5. **Worker integration** -- Confirmation emails and file upload processing.
6. **Analytics visualization** -- Replace raw JSON with proper charts.
7. **Multi-page support in builder** -- Backend ready, frontend needs page tabs.
8. **Live preview toggle** -- Nice-to-have UX improvement.
9. **Remaining settings UI** -- custom_css editor, allowed_domains, captcha toggle, notify_emails list.
10. **Port alignment** -- Design says 4011, implementation uses 4013 (cosmetic, but worth noting in docs).
