# Blank -- App Dossier

Research dossier for the BigBlueBam Blank app (forms and submissions). All
findings are cited to real files. Anything inferred or unverified is flagged.

---

## 1. App identity

- App key: blank
- Display name: Blank (sidebar logo text "Blank"; auth screen titles it "Blank Forms and Surveys")
- Category: Forms and submissions
- SPA path: /blank/ (served by nginx; infra/nginx/nginx.conf:293)
- API path: /blank/api/ -> proxied to blank-api:4013 (nginx strips the /blank/api/ prefix; infra/nginx/nginx.conf:293-294)
- Extra public route: top-level nginx location /forms/ also proxies to blank-api:4013/forms/ (infra/nginx/nginx.conf:305-306) -- this serves the server-rendered public form HTML at the bare-domain /forms/:slug.
- Internal port: 4013 (apps/blank-api/src/server.ts)
- Backend dir: apps/blank-api/src
- Frontend dir: apps/blank/src
- MCP tools file: apps/mcp-server/src/tools/blank-tools.ts (11 tools)
- Docs dir: docs/apps/blank (docs_exists = true)
- Prerequisites:
  - A BigBlueBam session/login is required for the authoring SPA. Unauthenticated visitors see a "Please log in to BigBlueBam first" screen with a link to /b3/ (apps/blank/src/app.tsx:139-151).
  - Auth via session cookie or bbam_/bbam_svc_ API key (apps/blank-api/src/plugins/auth.ts).
  - Org membership scoping: all authoring data is scoped to request.user.org_id.
  - Public form submission requires NO auth (anonymous), except where the form visibility is org/project (enforced); requires_login/allowed_domains are columns but not enforced (see Open questions).
  - Conditional routing to Bond/Helpdesk requires INTERNAL_SERVICE_SECRET to be set (apps/blank-api/src/services/routing.service.ts:104).
  - CAPTCHA enforcement requires CAPTCHA_SECRET_KEY (else token-presence-only check; apps/blank-api/src/routes/public.routes.ts:96-119).

---

## 2. Key concepts and vocabulary

Sourced from apps/blank-api/src/db/schema/blank-forms.ts, blank-form-fields.ts,
blank-submissions.ts, and the route Zod schemas.

Form (blank_forms): the top-level object. Belongs to an org, optionally to a Bam
project. Has a name, slug, description, theming, lifecycle status, and many
behavior toggles.

Form status (lifecycle): draft -> published -> closed (enum in blank_forms.status,
default draft). The frontend also renders an archived status color but no route
sets it (form-list.tsx:10-15).
- publishForm rejects if already published OR if the form has zero fields (form.service.ts:397-420).
- closeForm sets status=closed, closed_at, accept_responses=false (form.service.ts:426-435).

Form type (form_type, default public): public | internal | embedded. In the
per-form Settings page dropdown (form-settings.tsx:47-55).

Visibility (visibility, default public): public | org | project. Enforced on the
public render/submit path in getFormBySlug (form.service.ts:213-244):
- public: anyone with the link.
- org: caller must be in the same org.
- project: caller must be a member of the form project_id (checked against project_memberships).

Field (blank_form_fields): a single form input/element. Ordered by page_number
then sort_order. field_key must be a safe identifier (letters, digits,
underscores; starts with letter/underscore) -- enforced in Zod and in service code
as SQL-injection defense for analytics.

Field types (REST enum, forms.routes.ts:12-20 and fields.routes.ts:10-18):
short_text, long_text, email, phone, url, number, single_select, multi_select,
dropdown, date, time, datetime, file_upload, image_upload, rating, scale, nps,
checkbox, toggle, section_header, paragraph, hidden.
- The builder palette (form-builder.tsx:30-52) adds page_break (frontend-only; NOT an accepted DB field type) and omits datetime and image_upload.
- Non-input types skipped during validation/analytics: section_header, paragraph, hidden (submission.service.ts:222, form.service.ts:254).

Conditional field display (conditional_on_field_id, conditional_operator,
conditional_value on blank_form_fields): operators equals, not_equals, contains,
gt, lt, is_set, is_not_set (fields.routes.ts:37). Schema + create-field API only;
no builder UI, no render-time evaluation (see Discrepancies).

Submission (blank_submissions): one response. Stores response_data (JSONB keyed by
field_key), submitter email/IP/user-agent, attachments, file_processing_status
(pending | processing | complete | failed | skipped), and Bolt emission
idempotency flags.

Routing config (routing_config JSONB on the form): on submission can create a Bond
contact or Helpdesk ticket. Shape/operators in routing.service.ts:11-49. No builder
UI -- set only via API/DB.

Confirmation (confirmation_type: message | redirect | page) with
confirmation_message and confirmation_redirect_url.

Submission limits / anti-abuse: max_responses, one_per_email, rate_limit_per_ip
(default 10), captcha_enabled, requires_login, allowed_domains, expires_at.

Theming: theme_color (default #3b82f6), header_image_url, custom_css (sanitized
server-side), show_progress_bar, shuffle_fields.

Bolt events emitted (source blank): form.published, form.closed, submission.created
(forms.routes.ts:183/220, public.routes.ts:164). The worker also emits
submission.confirmation_sent (blank-confirmation-email.job.ts). The Settings page
labels them as blank.submission.created, blank.form.published, blank.form.closed
(settings.tsx:62-72) -- display strings; see Discrepancies re event naming.

---

## 3. Feature inventory

### Backend route map

Authenticated routes are registered under prefix /v1 (full path through nginx is
/blank/api/v1/...). Public routes have NO /v1 prefix. Registration:
apps/blank-api/src/server.ts:94-104.

GET /v1/forms -- requireAuth. List forms for org; filter by status and project_id.
Returns each form plus submission_count and field_count (forms.routes.ts:108,
form.service.ts:109).

POST /v1/forms -- requireAuth + requireScope(read_write), rate-limited 20/min.
Create form (optional inline fields array). Body: name, slug, description,
project_id, form_type, visibility, expires_at, requires_login, confirmation fields,
theme_color, fields (forms.routes.ts:122).

GET /v1/forms/:id -- requireAuth. Get one form with fields (ordered) plus
submission_count (forms.routes.ts:136, form.service.ts:166).

PATCH /v1/forms/:id -- requireAuth + requireScope(read_write). Update form;
custom_css is sanitized. Full settings surface incl. accept_responses,
max_responses, one_per_email, show_progress_bar, shuffle_fields, notify_on_submit,
notify_emails, rate_limit_per_ip, captcha_enabled, header_image_url
(forms.routes.ts:146).

DELETE /v1/forms/:id -- requireAuth + requireScope(read_write). Delete form
(cascades fields and submissions) (forms.routes.ts:161).

POST /v1/forms/:id/publish -- requireAuth + requireCan(blank.form.publish).
Publish; requires at least 1 field; emits form.published. Rejects if already
published or no fields (forms.routes.ts:171, form.service.ts:397).

POST /v1/forms/:id/close -- requireAuth + requireCan(blank.form.close). Close; sets
accept_responses false; emits form.closed with total_submissions
(forms.routes.ts:207). NO SPA button (see Discrepancies).

POST /v1/forms/:id/duplicate -- requireAuth + requireScope(read_write). Clone form
plus fields as a new draft; slug gets a copy suffix; name gets (Copy)
(forms.routes.ts:245, form.service.ts:441).

GET /v1/forms/:id/embed-code -- requireAuth. Returns url and embed_html iframe
snippet pointing at /forms/:slug (forms.routes.ts:259, form.service.ts:495). NO SPA
caller found (see Discrepancies).

POST /v1/forms/:id/fields -- requireAuth + requireScope(read_write). Add a field.
Full field schema incl. conditional fields, allowed_file_types, max_file_size_mb
(fields.routes.ts:78).

PATCH /v1/fields/:id -- requireAuth + requireScope(read_write). Update a field
(fields.routes.ts:89).

DELETE /v1/fields/:id -- requireAuth + requireScope(read_write). Remove a field
(fields.routes.ts:99).

POST /v1/forms/:id/fields/reorder -- requireAuth + requireScope(read_write). Bulk
reorder: array of id plus sort_order (fields.routes.ts:110).

GET /v1/forms/:id/submissions -- requireAuth. List submissions, cursor paginated;
filter by file_processing_status. Returns data plus meta cursor flags
(submissions.routes.ts:11).

GET /v1/submissions/:id -- requireAuth. Get one submission full response_data
(submissions.routes.ts:31).

DELETE /v1/submissions/:id -- requireAuth + requireCan(blank.submission.delete).
Delete a submission (submissions.routes.ts:41). NO SPA button (see Discrepancies).

GET /v1/forms/:id/submissions/export -- requireAuth. Export all submissions as CSV
(text/csv attachment named submissions.csv) (submissions.routes.ts:51,
submission.service.ts:382).

GET /v1/forms/:id/analytics -- requireAuth. Response aggregation: total, 30-day
daily trend, per-field breakdown (submissions.routes.ts:67,
submission.service.ts:443).

GET /forms/:slug -- public, no auth. Server-rendered HTML form page (or closed
page) (public.routes.ts:22, renderer lib/form-renderer.ts).

GET /forms/:slug/definition -- public, no auth. JSON field definitions for
SPA/headless rendering; enforces visibility/expiration (public.routes.ts:42).

POST /forms/:slug/submit -- public, rate-limited 10/hour. Submit a response;
CAPTCHA, accept_responses, one_per_email, max_responses, field validation, routing,
Bolt event. Body: response_data, optional email, optional captcha_token
(public.routes.ts:71).

Health probes: GET /healthz, GET /readyz via shared plugin (server.ts:85).

### Submission validation rules (submission.service.ts:224-376)

- Required fields must be non-empty.
- email -> regex; url -> http(s) prefix; phone -> loose phone regex.
- number/rating/scale/nps -> numeric; bounds from min_value/max_value and scale_min/scale_max.
- single_select/dropdown -> value in options; multi_select/checkbox_group -> array, each in options.
- short_text/long_text/textarea -> string with min_length/max_length.
- date -> parseable; checkbox -> boolean.
- regex_pattern applied to any string field.
- On any failure: HTTP 400 "Validation failed".

### Analytics computation (submission.service.ts:443-536)

- total_submissions (count).
- daily_trend: count per day, last 30 days.
- field_analytics per non-decorative field: select/multi/dropdown -> option_counts; rating/scale/nps/number -> numeric_stats (avg/min/max/count); else -> text_count.
- Field keys validated against safe-identifier regex before interpolation into sql.raw.

### Frontend views, panels, dialogs, and primary actions

The SPA is a hand-rolled router (app.tsx:35-70). BASE_PATH = /blank. Layout chrome
(blank-layout.tsx): Launchpad app switcher, breadcrumbs, OrgSwitcher,
NotificationsBell, UserMenu. Sidebar (blank-sidebar.tsx) nav items: "Forms" (/) and
"Blank Settings" (/settings). Pressing the question-mark key navigates to Help
(app.tsx:113-124).

View: Forms list -- route /blank/ -> FormListPage (form-list.tsx)
- Heading "Forms", subtitle "Build forms and surveys to capture responses from anyone."
- Primary action button "New Form" (Plus icon) -> POST /v1/forms with name "Untitled Form" plus generated slug, then navigates to /forms/:id/edit (form-list.tsx:25-51).
- Empty state: "No forms yet" / "Create your first form to start collecting responses."
- Each form card: name, description, status pill (draft/published/closed/archived), field count, submission count, relative updated time. Card click -> /forms/:id/edit.
- Per-card overflow menu (MoreHorizontal): "Preview" -> /forms/:id/preview; "Responses" -> /forms/:id/responses; "Duplicate" -> POST /v1/forms/:id/duplicate; "Delete" (destructive) -> DELETE /v1/forms/:id (form-list.tsx:86-98).

View: Form Builder -- route /blank/forms/:id/edit -> FormBuilderPage (form-builder.tsx)
- Multi-pane: left field palette, center canvas, optional right field-config panel, optional live-preview panel.
- Left palette "Add Field" -- one button per type in FIELD_TYPE_PALETTE (form-builder.tsx:30-52): Short Text, Long Text, Email, Phone, URL, Number, Single Select, Multi Select, Dropdown, Date, Time, Rating, Scale, NPS, Checkbox, Toggle, File Upload, Section Header, Paragraph, Hidden Field, Page Break. Click -> POST /v1/forms/:id/fields (line 424).
- Center canvas: editable form Title and Description inputs (onChange -> PATCH /v1/forms/:id). dnd-kit sortable rows; drag reorder -> POST /v1/forms/:id/fields/reorder (line 442). Each row: label, required marker, type badge, trash icon -> DELETE /v1/fields/:id. Empty state "Click a field type on the left to add it".
- Top-right action bar: "Preview" toggle (Eye) opens the Live Preview panel; "Settings" opens the Form Settings dialog; "Share" (only when published) opens the Publish-result dialog; "Publish" (Send) -> POST /v1/forms/:id/publish, disabled when already published, error shown via alert (line 460).
- Right field-config panel "Field Settings": Label, Key (field_key, mono), Description, Placeholder, Required checkbox; Options editor for select/dropdown ("+ Add option"); Min/Max Length for text; Min/Max Value for numeric; Scale Min/Scale Max for scale; Regex Pattern; Page Number. Each commits via PATCH /v1/fields/:id on blur/change (form-builder.tsx:591-799).
- Live Preview panel (FormPreviewPanel, line 246): mini render, splits fields at page_break into pages, shows progress bar plus Previous/Next/Submit when multi-page.

Dialog: Form Settings (FormSettingsDialog, form-builder.tsx:832) -- title "Form Settings"
- Visibility radio group: "Public" (Globe), "Organization" (Building2), "Project members" (FolderKanban). Project picker (loads Bam projects via /b3/api/v1/projects) appears when "Project members" is chosen.
- "Expires at" datetime-local with a "Clear" button.
- "Cancel" / "Save" (Save disabled if project visibility chosen but no project). Save -> PATCH /v1/forms/:id with visibility, expires_at, project_id.

Dialog: Publish result (PublishResultDialog, form-builder.tsx:1038) -- title "Your form is live"
- Read-only public URL (origin plus /forms/:slug) with "Copy" button (-> "Copied"), "Open in new tab" link, visibility label, "Done" button.

View: Form Preview -- route /blank/forms/:id/preview -> FormPreviewPage (form-preview.tsx)
- Full-page non-interactive render (header image, title, description, disabled inputs, themed Submit). Header: "Back to Builder" link plus "PREVIEW MODE" label.

View: Form Responses -- route /blank/forms/:id/responses -> FormResponsesPage (form-responses.tsx)
- Title "{form name} -- Responses", with a submission count. Back chevron -> /forms/:id/edit.
- Actions: "Analytics" -> /forms/:id/analytics; "Export CSV" -> opens /blank/api/v1/forms/:id/submissions/export.
- "Attachment status:" filter pills: all, pending, processing, complete, failed (client-side filter).
- Table columns: number, Email, first 5 display fields, Files (status pill), Date. Empty state "No responses yet."
- NOTE: no row click or submission-detail view despite GET /v1/submissions/:id existing.

View: Form Analytics -- route /blank/forms/:id/analytics -> FormAnalyticsPage (form-analytics.tsx)
- Title "{form name} -- Analytics", with total submissions.
- Summary cards: Total Submissions, Active Fields, Form Status.
- "Submissions (Last 30 Days)" bar chart from daily_trend.
- "Per-Field Breakdown" cards rendering raw field_analytics (type plus JSON-stringified data, truncated to 200 chars).

View: Per-form Settings page -- route /blank/forms/:id/settings -> FormSettingsPage (form-settings.tsx)
- NOTE: reachable only by typing the URL; no nav/menu link points to it (app.tsx:66).
- Sections: Access (Form Type select; Accept Responses checkbox; One per Email checkbox), Confirmation (Type select; Confirmation Message textarea), Branding (Theme Color picker; Show Progress Bar checkbox), Notifications (Email on Submit checkbox). Each control PATCHes /v1/forms/:id.

View: Blank Settings (app-level) -- route /blank/settings -> SettingsPage (settings.tsx)
- Read-only informational page. Heading "Settings". Defaults (Default Form Type public, Default Theme Color #3b82f6), Rate Limiting (10 per hour), Integrations (lists blank.submission.created, blank.form.published, blank.form.closed). Nothing editable.

View: Public form (SPA) -- route /blank/f/:slug -> PublicFormPage (public-form.tsx)
- Auth-bypassed React render. Fetches /blank/api/forms/:slug/definition, renders interactive inputs, multi-page via page_number grouping with Back/Next plus progress bar, optional email field on last page, submits to /blank/api/forms/:slug/submit. Shows confirmation or follows redirect; closed/error states handled.

View: Public form (server-rendered HTML) -- /forms/:slug (and /blank/api/forms/:slug)
- Self-contained HTML page from lib/form-renderer.ts. This is the URL the Publish dialog and embed-code/urls.ts hand out, NOT the /blank/f/:slug SPA route (see Discrepancies).

---

## 4. Candidate user stories

1. Build and publish a feedback form. Forms list -> New Form -> builder opens -> rename title/description -> add fields from the palette (Rating, NPS, Long Text) -> configure each in Field Settings -> open Settings dialog to set Visibility/Expires -> Publish -> copy the public URL from the Your form is live dialog -> share.

2. Collect and review responses. Public respondent opens the share URL, fills the form, submits, sees the confirmation. Author opens form card overflow -> Responses -> reviews the table, filters by attachment status, clicks Export CSV.

3. Analyze results. From Responses -> Analytics -> read total submissions, 30-day trend, and per-field breakdown.

4. Duplicate a form as a template. Forms list -> card overflow -> Duplicate -> a new draft Copy form with the same fields appears; edit and re-publish.

5. Restrict a form to org or project members. Builder -> Settings dialog -> choose Organization or Project members and pick a project -> Save. Non-members hitting the public URL get a 403 message.

6. Multi-page survey. Builder -> add Page Break elements between groups (or set per-field Page Number) -> respondents page through with a progress bar. Note: page_break add may fail at the API; see Discrepancy 4.

7. Close a form and wrap up (Agent/API only, no SPA button). POST /v1/forms/:id/close stops accepting responses and emits form.closed.

8. Route submissions into other apps (API/DB-config only). Set routing_config so a submission whose field matches a condition creates a Bond contact or Helpdesk ticket (routing.service.ts).

9. Agent-driven form authoring. Agent calls blank_generate_form with a description -> reviews the suggested spec -> blank_create_form -> blank_publish_form, then later blank_summarize_responses.

---

## 5. Agent flows (MCP tools)

File: apps/mcp-server/src/tools/blank-tools.ts. All tools proxy to blank-api over
HTTP with the caller bearer token. 11 tools (matches CLAUDE.md count).

- blank_list_forms -- List org forms; filter status, project_id. Backs GET /v1/forms (Forms list view).
- blank_get_form -- Get a form plus its fields. Backs GET /v1/forms/:id (Builder load).
- blank_create_form -- Create form with optional inline fields. Backs POST /v1/forms (New Form plus builder).
- blank_generate_form -- AI/heuristic form spec from a natural-language description; returns a suggestion to pass to blank_create_form. Does NOT persist anything. Keyword-matches name/email/phone/nps/rating/feedback/bug to seed fields. No REST equivalent; in-tool logic only (blank-tools.ts:132-199).
- blank_update_form -- Update name/description/form_type/accept_responses/theme_color. Backs PATCH /v1/forms/:id (Settings pages).
- blank_publish_form -- Publish a draft. Backs POST /v1/forms/:id/publish (Publish button).
- blank_list_submissions -- List submissions, cursor paginated. Backs GET /v1/forms/:id/submissions (Responses view).
- blank_get_submission -- Get one submission full data. Backs GET /v1/submissions/:id (no SPA detail view).
- blank_summarize_responses -- Returns analytics for AI summarization. Backs GET /v1/forms/:id/analytics (Analytics view).
- blank_export_submissions -- Export CSV (returns raw text). Backs GET /v1/forms/:id/submissions/export (Export CSV).
- blank_get_form_analytics -- Same analytics payload (alias of summarize). Backs GET /v1/forms/:id/analytics (Analytics view).

Agent-only / no human-UI parity:
- No MCP tool to add/edit/reorder/delete fields after creation (fields can only be set inline at blank_create_form time via MCP), to close/duplicate a form, to delete a submission, to get the embed code, or to configure routing.
- blank_generate_form and blank_get_submission have no corresponding SPA surface.

Per-action permission IDs registered for Blank (docs/permissions-action-manifest.json
near lines 10681-11126, seeded in infra/postgres/migrations/0145_permissions_seed_actions.sql):
includes blank.form.publish, blank.form.close, blank.form.duplicate,
blank.form.generate, blank.form.submit, blank.submission.delete,
blank.submissions.export, blank.responses.summarize, plus field/analytics actions.
Only blank.form.publish, blank.form.close, and blank.submission.delete are wired as
requireCan gates in the routes; the rest use requireScope or are public.

---

## 6. Screenshots available

Located in docs/apps/blank/screenshots/{light,dark}/. Manifest:
docs/apps/blank/meta.json (1440x900, captured 2026-04-17). Same four images in both
themes.

- light/01-form-list.png, dark/01-form-list.png -- Forms list grid with cards. Illustrates Story 1 start; the Forms list view.
- light/02-form-builder.png, dark/02-form-builder.png -- Builder with palette plus canvas. Illustrates Story 1 build step; the Form Builder view.
- light/03-form-preview.png, dark/03-form-preview.png -- Full-page form preview. Illustrates the Form Preview view; what respondents see.
- light/04-settings.png, dark/04-settings.png -- App-level Blank Settings (read-only). Illustrates the Blank Settings / integrations page.

Gaps: no screenshots of Responses, Analytics, the Form Settings dialog, the
Publish-result dialog, the per-form Settings page, or the public submission flow.

---

## 7. Discrepancies (docs/marketing vs code)

1. Signature field type is claimed in guide.md:18 and _narrative.md:8 (the field-types list ends with rating and signature). No signature field type exists in the REST enum or the builder palette. Unverified/false.

2. Conditional logic in the builder -- marketing (marketing.md:12, _marketing_hook.md:3, guide.md:16) and the builder palette imply conditional logic. The DB supports per-field conditional display (conditional_on_field_id etc.) and form-level routing_config, but there is no builder UI to configure either, and no render-time evaluation of field-level conditionals in public-form.tsx or form-renderer.ts. Routing only runs server-side from a manually-set routing_config. So conditional logic is real as a data/routing feature but not as a no-code builder feature.

3. Completion rates / drop-off analysis -- claimed in guide.md:20, marketing.md:14, _narrative.md:11. The analytics endpoint computes total, daily trend, and per-field counts/stats only. No completion-rate or drop-off computation exists (submission.service.ts:443). Overstated.

4. page_break palette item is frontend-only -- the builder offers Page Break (form-builder.tsx:51) but page_break is not in the REST FIELD_TYPES enum. Adding one sends field_type page_break to POST /v1/forms/:id/fields, which Zod rejects (fields.routes.ts:25). Multi-page in the renderer/public form is actually driven by page_number, not page-break fields. Likely-broken builder action.

5. datetime and image_upload field types are accepted by the API and rendered by form-preview.tsx/public-form.tsx, but are absent from the builder palette; not addable via the UI.

6. No Close form or Delete submission UI. Both routes exist and are permission-gated, but no SPA button/menu invokes them. Form lifecycle only goes draft to published in the UI; there is no close, archive, or un-publish control. The archived status has a color but is never set.

7. Embed code has no UI caller. GET /v1/forms/:id/embed-code returns an iframe snippet, and the Settings page mentions an Embedded form type, but no SPA component fetches embed-code. Embedded is selectable as a form_type but otherwise inert.

8. Per-form Settings page (/forms/:id/settings) is orphaned -- fully built (form-settings.tsx) but unreachable from any nav/menu; the builder Settings button opens the in-builder dialog instead, which only covers visibility/expiration/project (a subset of the page controls).

9. App-level Blank Settings page is entirely read-only -- presents defaults/rate-limit/events as static text despite looking like a configuration screen.

10. Two different public-form surfaces. The Publish dialog, getEmbedCode, and urls.ts hand out the server-rendered URL (/forms/:slug or /blank/api/forms/:slug), while the SPA also implements a React public page at /blank/f/:slug. Nothing in the authoring UI links to the SPA variant; users get the HTML-rendered page. Reconcile in docs which is canonical.

11. Bolt event naming. Per CLAUDE.md, events are bare-name plus explicit source (event submission.created, source blank). The Settings page and docs show dotted blank.submission.created strings. These are display labels, not the actual emitted event names (public.routes.ts:164 emits submission.created with source blank). Minor naming-convention mismatch.

12. Response-detail view missing. The Responses table has no row drill-down even though blank_get_submission and GET /v1/submissions/:id exist. The MCP tool is more capable than the UI here.

---

## 8. Open questions

1. File upload pipeline maturity. blank-file-process.job.ts is explicitly a pure DB state advancer for P0 with a simulated failure rate and stub processed_files; real MinIO scanning is a later wave. How should help docs describe file-upload fields given the backing is partly simulated? (apps/worker/src/jobs/blank-file-process.job.ts:1-12)

2. Confirmation/notification emails. blank-confirmation-email.job.ts runs in sweep mode (the Blank API does not yet push to a BullMQ queue), keyed off processed=false. Without SMTP configured it only logs. Are submitter confirmation emails plus notify_emails notifications considered shipped for documentation?

3. notify_emails and notify_banter_channel_id exist in the schema and update API but have no editor UI (the per-form Settings page only toggles notify_on_submit, never lets you enter addresses or pick a Banter channel). Is configuring recipients expected to be UI-driven or API-only?

4. requires_login and allowed_domains are schema columns but I found no enforcement of them in the public submit path (only visibility and expires_at are enforced in getFormBySlug). Are these intended to gate submission, and where?

5. captcha_enabled has no builder/Settings toggle; only settable via raw PATCH. Is CAPTCHA a documented user-facing feature or operator-only?

6. Conditional field display (conditional_on_field_id) -- is this a planned feature to document as coming, or should it be omitted entirely since neither builder nor renderer use it?

7. Help content delivery. The SPA loads HelpViewer with appSlug blank and the question-mark key opens it (app.tsx:153), but docs/apps/blank has no help.md yet (only guide/marketing/narrative/mcp-tools). Confirm the writer help.md is the file this viewer renders.
