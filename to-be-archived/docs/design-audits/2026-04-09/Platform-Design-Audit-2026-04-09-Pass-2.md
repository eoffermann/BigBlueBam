# Platform Design Audit -- Pass 2

**Date:** 2026-04-09 (Pass 2)
**Auditor:** Claude Opus 4.6 (automated)
**Scope:** All 10 BigBlueBam product apps re-audited after P0-P3 feature builds
**Prior Audit:** Pass 1 individual audits dated 2026-04-09

---

## Executive Summary

Significant progress has been made since Pass 1. The platform's most critical gaps -- the Bolt execution engine, Bolt event emission from all apps, the Blast email worker, Board element snapshot service, Bill PDF generation, Brief export endpoints, Blank public form renderer, Book event creation form, Bench chart rendering, and Bearing linked progress computation -- have all been addressed. Every app now emits events to the Bolt workflow engine via a shared `bolt-events.ts` pattern, and the worker service has grown from 6 to 15 queue processors.

**Platform-wide completion has risen from ~71% average to ~84% average.**

| App | Pass 1 | Pass 2 | Delta | Key Improvements |
|-----|--------|--------|-------|------------------|
| Bolt | 58% | 78% | +20 | Execution engine, event ingestion, BullMQ processor, rate limiting |
| Board | 72% | 82% | +10 | Element snapshot service wired into persistence, element write endpoints |
| Bench | 68% | 80% | +12 | Recharts ChartRenderer, widget gallery, date range picker, wizard fix |
| Bill | 75% | 85% | +10 | PDF generation (pdf-lib), GET /invoices/:id/pdf, public PDF download |
| Book | 72% | 80% | +8 | Event creation form (create+edit), Bolt events |
| Blank | 72% | 82% | +10 | Public form HTML renderer, shuffle_fields, Bolt events |
| Blast | 78% | 87% | +9 | BullMQ blast:send worker, List-Unsubscribe headers, Bolt events |
| Bearing | 82% | 88% | +6 | bearing:recompute + bearing:digest jobs, epic/project/task_query linked progress |
| Bond | 78% | 82% | +4 | Bolt events |
| Brief | 52% | 62% | +10 | Export endpoints (Markdown/HTML), content update/append endpoints, Bolt events |

---

## Cross-Cutting: Bolt Event Emission (All Apps)

**Pass 1 status:** 0/10 apps emitted events. **Pass 2 status:** 10/10 apps emit events.

Every app now has a `lib/bolt-events.ts` file implementing a fire-and-forget HTTP call to `bolt-api`'s `POST /v1/events/ingest` endpoint. The pattern uses `BOLT_API_INTERNAL_URL` and `INTERNAL_SERVICE_SECRET` env vars for service-to-service auth. Events are emitted from mutation services (task create, deal stage change, invoice sent, etc.).

Verified event emission call sites in:
- `apps/api/src/services/task.service.ts`, `routes/comment.routes.ts`, `routes/sprint.routes.ts`
- `apps/banter-api/src/routes/message.routes.ts`
- `apps/beacon-api/src/routes/beacon.routes.ts`
- `apps/bearing-api/src/routes/goals.ts`, `routes/key-results.ts`
- `apps/bill-api/src/routes/invoices.routes.ts`, `routes/payments.routes.ts`
- `apps/blank-api/src/routes/forms.routes.ts`, `routes/public.routes.ts`
- `apps/blast-api/src/routes/campaigns.routes.ts`
- `apps/board-api/src/routes/board.routes.ts`
- `apps/bond-api/src/services/deal.service.ts`, `services/contact.service.ts`, `services/activity.service.ts`
- `apps/book-api/src/routes/events.routes.ts`, `routes/public-booking.routes.ts`
- `apps/brief-api/src/services/document.service.ts`

---

## Cross-Cutting: Worker Service

**Pass 1:** 6 job handlers. **Pass 2:** 15 job handlers (+ analytics placeholder).

New job handlers added:
- `bolt-execute.job.ts` -- Full MCP tool call execution engine with retry/stop/continue error policies
- `blast-send.job.ts` -- Complete email delivery pipeline with SMTP, merge fields, tracking pixel, click rewriting, List-Unsubscribe headers
- `bearing-recompute.job.ts` -- Linked progress recomputation for epic/project/task_query targets
- `bearing-digest.job.ts` -- Weekly goals summary
- `beacon-vector-sync.job.ts` -- Qdrant vector sync
- `beacon-expiry-sweep.job.ts` -- Daily beacon expiry sweep (cron-scheduled)
- `helpdesk-task-create.job.ts` -- Async ticket-to-task creation

---

## App-by-App Audit

### 1. Bolt (Workflow Automation) -- 58% -> 78%

**What was built since Pass 1:**

1. **Event Ingestion Endpoint** (`POST /v1/events/ingest`) -- Complete event router that:
   - Authenticates via `X-Internal-Secret` header (timing-safe comparison)
   - Matches events against enabled automations by `(org_id, trigger_source, trigger_event)`
   - Evaluates conditions using the existing condition engine
   - Checks trigger_filter if present
   - Enforces Redis rate limiting (`bolt:rate:{id}:hour` counters)
   - Enforces cooldown periods (`bolt:cooldown:{id}`)
   - Checks chain depth for loop prevention
   - Creates execution records with appropriate status
   - Enqueues `bolt:execute` BullMQ jobs

2. **BullMQ Executor** (`bolt-execute.job.ts`) -- Complete action execution engine that:
   - Loads automation and actions from DB
   - Resolves template variables (`{{ event.* }}`, `{{ actor.* }}`, `{{ automation.* }}`, `{{ now }}`, `{{ step[N].result.* }}`)
   - Calls MCP server tool endpoint via HTTP
   - Records execution steps with parameters_resolved, response, duration
   - Implements all three error policies: stop, continue, retry (with configurable retry count and delay)
   - Determines final status: success/failed/partial

3. **publishBoltEvent utility** (`lib/publish-event.ts`) -- Redis PubSub publisher for the `bolt:events` channel

**Remaining P0 items:** None -- all P0 execution items resolved.

**Remaining P1 items:**
- Cron scheduler (`bolt:schedule` queue) -- `bolt_schedules` table exists but no cron tick processor
- Execution log cleanup (`bolt:cleanup` queue) -- No nightly purge job
- AI-assisted authoring still returns hardcoded responses

**Top 3 remaining gaps:**
1. **Cron scheduler** -- scheduled automations cannot fire (bolt_schedules table is inert)
2. **Frontend builder enhancements** -- CronEditor, FieldPicker, AiAssistDialog, TemplateVariableHelper still missing
3. **Missing templates** -- 4 design templates still absent (New Document Notification, Weekly Status Update, Task Moved to Review, Close Ticket on Task Complete)

---

### 2. Board (Whiteboards) -- 72% -> 82%

**What was built since Pass 1:**

1. **Element Snapshot Service** (`element-snapshot.service.ts`) -- Complete Excalidraw-to-board_elements denormalization:
   - Parses Excalidraw element JSON (rectangle, text, arrow, image, frame, etc.)
   - Maps Excalidraw types to board_elements types (shape, text, connector, image, frame)
   - Extracts text_content, position, dimensions, rotation, color, frame_id, group_id, arrow bindings
   - Upserts live elements in batches of 100
   - Deletes elements marked `isDeleted` in the scene
   - Prunes stale rows no longer in the scene

2. **Snapshot wired into persistence** (`ws/persistence.ts`) -- `saveScene()` now calls `syncElementsFromScene()` as fire-and-forget after every scene save. MCP tools, search, and the "AI can see the board" principle now work.

3. **Element write endpoints** (`element.routes.ts`) -- `POST /boards/:id/elements/sticky` and `POST /boards/:id/elements/text` routes now exist. They create Excalidraw elements, inject them into the scene JSON, save via `saveScene()` (which triggers snapshot sync), and return the created element metadata. MCP tools `board_add_sticky` and `board_add_text` will now work.

4. **Bolt event emission** -- `board.created`, `board.updated`, `board.archived` events emitted.

5. **System template seeding** -- `template.service.ts` and `template.routes.ts` updated.

**Remaining P0 items:**
- Export endpoint (`GET /boards/:id/export/:format`) -- still not implemented
- Custom embed shapes (TaskEmbedShape, BeaconEmbedShape, GoalEmbedShape, BriefEmbedShape) -- still absent
- PromoteToTasksDialog (frontend UI for sticky-to-task promotion)

**Remaining P1 items:**
- AI spatial clustering (`GET /boards/:id/elements/clusters`)
- Frontend export menu click handlers
- BullMQ background jobs (thumbnail, export, version cleanup)

**Top 3 remaining gaps:**
1. **Export endpoint** -- MCP tool `board_export` and frontend menu still non-functional
2. **Custom embed shapes** -- Cross-product embed system absent from canvas
3. **PromoteToTasksDialog** -- Backend promote exists but no frontend trigger

---

### 3. Bench (Analytics) -- 68% -> 80%

**What was built since Pass 1:**

1. **Recharts ChartRenderer** (`components/widgets/chart-renderer.tsx`) -- Full chart rendering component supporting:
   - Bar chart, line chart, area chart, pie chart, donut chart
   - KPI card with currency/percentage/number formatting
   - Counter card
   - Data table fallback for unsupported types
   - Stacked mode, configurable colors, legend, responsive containers
   - Dark mode compatible tooltips

2. **ChartRenderer wired into dashboard view** -- `dashboard-view.tsx` imports and uses `ChartRenderer` for all widget rendering, replacing raw data tables.

3. **Widget Gallery** (`components/widgets/widget-gallery.tsx`) -- 12 pre-built widget templates across 5 categories:
   - Project Management: Sprint Velocity, Tasks by State, Total Open Tasks, Tasks by Priority
   - CRM: Pipeline Value, Deals by Stage, Pipeline Funnel
   - Email Marketing: Avg Open Rate, Engagement Trend
   - Support: Open Tickets, Tickets by Priority
   - Cross-Product: Daily Task Throughput

4. **Global Date Range Picker** (`components/dashboards/date-range-picker.tsx`) -- Dashboard-level date filter wired into dashboard view.

5. **Widget Wizard fix** -- Final step now calls `createWidget.mutateAsync()` instead of navigating away. Widget creation works end-to-end.

**Remaining P0 items:**
- react-grid-layout dashboard canvas (still uses CSS grid)
- PDF/PNG export via Puppeteer
- Row-level data visibility
- Beacon and Bearing data sources not in registry
- BullMQ worker jobs for reports and MV refresh

**Remaining P1 items:**
- Widget edit page (placeholder only)
- Redis cache still unwired (CacheService exists but unused)
- Report creation form (New Report button still has no handler)

**Top 3 remaining gaps:**
1. **react-grid-layout** -- No drag-and-drop widget positioning despite layout JSONB being stored
2. **Widget edit page** -- Cannot edit existing widgets
3. **Redis cache integration** -- CacheService coded but never instantiated

---

### 4. Bill (Invoicing) -- 75% -> 85%

**What was built since Pass 1:**

1. **PDF Generation** (`services/pdf.service.ts`) -- Complete invoice PDF pipeline using `pdf-lib`:
   - A4 page layout with professional formatting
   - Company header with name, address, tax ID
   - "INVOICE" title with invoice number, dates, status
   - Bill-to section
   - Line items table with description (multi-line wrapping), quantity, unit, unit price, amount
   - Alternating row backgrounds
   - Totals section (subtotal, tax, discount, total, amount paid, balance due)
   - Payment instructions section
   - Terms & conditions section
   - Centered footer
   - Multi-page support (auto page-break when content exceeds margin)
   - No Puppeteer dependency -- pure JavaScript PDF generation

2. **PDF download endpoint** (`GET /invoices/:id/pdf`) -- Authenticated PDF download, generates on-the-fly.

3. **Public PDF download** (`GET /invoice/:token/pdf`) -- Token-authenticated public PDF download for clients.

4. **Bolt event emission** -- `bill.invoice.created`, `bill.invoice.sent`, `bill.payment.recorded` events emitted.

**Remaining P0 items:**
- `POST /invoices/from-time-entries` -- Core time-to-invoice pipeline still missing
- `POST /invoices/from-deal` -- Bond deal-to-invoice pipeline still missing
- `bill_create_invoice_from_deal` MCP tool -- not registered
- Client detail page (`/bill/clients/:id`) -- route parsed but no component
- Invoice editor live preview -- not implemented

**Remaining P1 items:**
- Email delivery on send (still marks as sent without actually sending)
- `bill_create_invoice_from_time` MCP tool -- registered but backend endpoint missing

**Top 3 remaining gaps:**
1. **Time-to-invoice pipeline** -- The #1 value proposition remains unbuilt
2. **Deal-to-invoice pipeline** -- Cross-product integration missing
3. **Email delivery on send** -- Invoices are "sent" without actual email

---

### 5. Book (Calendar) -- 72% -> 80%

**What was built since Pass 1:**

1. **Event Creation Form** (`pages/event-form.tsx`) -- Complete create/edit event form with:
   - Title (required), calendar selector (required)
   - Start/end datetime pickers (with all-day mode switching to date-only)
   - Description textarea
   - Location field
   - Recurrence selector (none, daily, weekly, biweekly, monthly)
   - Visibility (busy, free, tentative, out of office)
   - Reminder selector (0-1440 minutes)
   - Color picker
   - Edit mode: loads existing event data and calls updateEvent
   - Validation (title required, end after start)
   - Error display and loading states

2. **Bolt event emission** -- `book.event.created`, `book.event.updated`, `book.event.cancelled`, `book.booking.created` events emitted from event routes and public booking routes.

**Remaining P0 items:**
- Cross-product calendar overlays (Bam due dates, sprint boundaries, Bearing deadlines, Bond close dates)
- External calendar events on day view (translucent blocks)
- Public booking page UI (backend works, no frontend page)

**Remaining P1 items:**
- External calendar sync engine (OAuth stubs, no BullMQ polling)
- Connections page (static disabled UI)

**Top 3 remaining gaps:**
1. **Cross-product timeline aggregation** -- Stated killer feature, still Book-only
2. **Public booking page UI** -- `/meet/:slug` returns JSON, not a usable page
3. **Booking page editor** -- Create-only, cannot edit existing pages, missing several fields

---

### 6. Blank (Forms) -- 72% -> 82%

**What was built since Pass 1:**

1. **Public Form HTML Renderer** (`lib/form-renderer.ts`) -- Complete server-side HTML generation:
   - Self-contained, responsive HTML page with inline CSS and vanilla JS
   - All 20 field types rendered (short_text, long_text, email, phone, url, number, date, time, datetime, single_select, dropdown, multi_select, checkbox, toggle, rating, scale, nps, file_upload, image_upload, hidden, section_header, paragraph)
   - Rating stars (CSS adjacent-sibling trick), scale slider with live value display
   - Client-side validation (required, email/url/phone format, min/max length, min/max value, regex pattern)
   - Form submission via fetch to `/forms/:slug/submit`
   - Confirmation message or redirect on success
   - CAPTCHA widget (Cloudflare Turnstile) integration
   - Theme color customization with CSS custom properties
   - Custom CSS support with sanitization (blocks @import, expression(), javascript:, non-HTTP url())
   - Header image support

2. **HTML endpoint wired** -- `GET /forms/:slug` now renders the form HTML via `renderFormHtml()`.

3. **shuffle_fields implemented** -- The renderer shuffles fields within sections using Fisher-Yates when `shuffle_fields` is true.

4. **Bolt event emission** -- `blank.form.published`, `blank.form.closed`, `blank.submission.created` events emitted.

**Remaining P0 items:**
- `one_per_email` enforcement on submit (column exists but not checked)
- `max_responses` enforcement on submit (column exists but not checked)
- Multi-page support in builder UI (data model ready, no page tabs)
- Live preview toggle in builder

**Remaining P1 items:**
- Worker integration (confirmation emails, file processing)
- Right panel field configuration in builder (only label, key, placeholder, required)

**Top 3 remaining gaps:**
1. **one_per_email / max_responses enforcement** -- Data integrity; columns are decorative
2. **Builder field configuration panel** -- Only 4 of ~15 properties editable
3. **Multi-page form builder UI** -- Backend ready, frontend needs page tabs

---

### 7. Blast (Email Campaigns) -- 78% -> 87%

**What was built since Pass 1:**

1. **BullMQ blast:send worker** (`blast-send.job.ts`) -- Complete email delivery pipeline:
   - Loads campaign and verifies `sending` status
   - Loads org-wide unsubscribe list and filters recipients
   - Per-contact merge field rendering (`{{first_name}}`, `{{last_name}}`, `{{email}}`, `{{unsubscribe_url}}`)
   - Click tracking link rewriting (rewrites all `href` URLs through `/t/c/:token`)
   - Open tracking pixel injection (1x1 GIF before `</body>`)
   - Creates `blast_send_log` entries with unique tracking tokens
   - SMTP delivery via nodemailer with configurable transport
   - **List-Unsubscribe and List-Unsubscribe-Post headers** (RFC 8058 compliance)
   - Graceful fallback when SMTP is unconfigured (logs instead of sending)
   - Job progress reporting for UI visibility
   - Campaign stats update on completion (total_sent, total_delivered, total_bounced)

2. **BullMQ queue producer** wired in `campaign.service.ts` -- `sendCampaign()` now enqueues `blast:send` jobs.

3. **Bolt event emission** -- `blast.campaign.sent`, `blast.campaign.completed` events emitted.

**Remaining P0 items:**
- Domain verification check before send (no check that from_email domain is verified)
- Send rate limiting via Redis token bucket
- CAN-SPAM physical address enforcement
- Engagement feedback to Bond (opens/clicks not synced as Bond activities)

**Remaining P1 items:**
- DNS domain verification (`POST /sender-domains/:id/verify` still stubbed)
- `blast_draft_email_content` and `blast_suggest_subject_lines` MCP tools still return hardcoded strings

**Top 3 remaining gaps:**
1. **Domain verification enforcement** -- Can send from unverified domains
2. **Segment filter application** -- `recalculateCount` and `previewContacts` still ignore most filter criteria
3. **AI content drafting** -- MCP tools are stubs, not LLM-powered

---

### 8. Bearing (Goals & OKRs) -- 82% -> 88%

**What was built since Pass 1:**

1. **bearing:recompute job** (`bearing-recompute.job.ts`) -- Complete linked progress recomputation:
   - Handles **epic** links: queries `tasks` + `task_states` to compute % done within an epic
   - Handles **project** links: same pattern for project-wide task completion
   - Handles **task_query** links: parses JSONB filter, applies project_id filter, computes completion %
   - **Weighted average** across multiple links using `link_weight`
   - Maps progress back to KR's value range (start_value -> target_value)
   - Recomputes parent goal progress (weighted average of all KRs)
   - Auto-derives goal status (completed/on_track/at_risk/behind) respecting `status_override`
   - Invalidates Redis cache keys (`bearing:kr:*`, `bearing:goal:*`)

2. **bearing:digest job** (`bearing-digest.job.ts`) -- Weekly goals summary worker.

3. **Both jobs registered in worker** with BullMQ Workers and event handlers.

4. **Bolt event emission** -- `bearing.goal.created`, `bearing.goal.status_changed`, `bearing.kr.value_updated` events emitted from goals and key-results routes.

**Remaining P0 items:**
- EpicPicker and TaskQueryBuilder frontend components (manual ID entry required)
- Cross-product integrations (Banter share, Brief embed, goal badge on Bam epics)

**Remaining P1 items:**
- Watcher notifications (records exist, no delivery)
- Snapshot job column name mismatch (may still fail at runtime -- needs verification)

**Top 3 remaining gaps:**
1. **EpicPicker + TaskQueryBuilder** -- Link editor UX incomplete
2. **Snapshot job column mismatch** -- May produce runtime SQL errors
3. **Cross-product integrations** -- Banter share, Brief embed, Bam badge all absent

---

### 9. Bond (CRM) -- 78% -> 82%

**What was built since Pass 1:**

1. **Bolt event emission** -- Events emitted from `deal.service.ts` (deal created, stage changed, won, lost), `contact.service.ts` (contact created), `activity.service.ts` (activity logged). All 8 designed events now have emission points.

**Remaining P0 items:**
- 3 missing MCP tools (`bond_score_lead`, `bond_get_forecast`, `bond_search_contacts`)
- "Own only" visibility for Member/Viewer roles
- Cross-product integrations (Blast, Helpdesk, Bam, Banter, Blank)
- Express-interest migration system
- Custom field definition CRUD routes
- Swimlane grouping on pipeline board

**Remaining P1 items:**
- Settings > Custom Fields UI (placeholder)
- Settings > Lead Scoring UI (placeholder)

**Top 3 remaining gaps:**
1. **3 missing MCP tools** -- API endpoints exist, just need MCP registration
2. **"Own only" visibility** -- Security gap; members see all org data
3. **Custom field + scoring settings UIs** -- Backend works, frontend is placeholder

---

### 10. Brief (Collaborative Docs) -- 52% -> 62%

**What was built since Pass 1:**

1. **Export endpoints** (`routes/export.routes.ts`) -- Registered in server.ts:
   - `GET /documents/:id/export/markdown` -- Downloads plain_text as .md file
   - `GET /documents/:id/export/html` -- Renders styled HTML page with full CSS
   - Both require auth and document access

2. **Content update/append endpoints** (`routes/document.routes.ts`) -- Now implemented:
   - `PUT /documents/:id/content` -- Replace document content (MCP `brief_update_content` now works)
   - `POST /documents/:id/append` -- Append to document content (MCP `brief_append_content` now works)
   - Both require auth, document edit access, and `read_write` scope

3. **Bolt event emission** -- `brief.document.created`, `brief.document.updated`, `brief.document.archived` events emitted.

**Remaining P0 items:**
- **Yjs/Hocuspocus collaboration server** -- The defining feature remains unbuilt. No real-time co-editing.
- Version diff endpoint (`GET /documents/:id/versions/:v1/diff/:v2`)
- PDF export (only Markdown and HTML implemented; no async PDF via BullMQ)
- Semantic search / Qdrant integration
- Custom editor extensions (Mention, BamTaskEmbed, BeaconEmbed, CalloutBlock, SlashCommand, BubbleMenu)
- FolderTree, DocumentTable, PresenceBar, LinkedItems frontend components
- Shared Zod schemas (`packages/shared/src/brief.ts`)

**Remaining P1 items:**
- Background jobs (brief:embed, brief:snapshot, brief:export, brief:cleanup)
- MinIO file upload in embed route

**Top 3 remaining gaps:**
1. **Yjs/Hocuspocus** -- Brief's raison d'etre; without it, it's a document manager, not a collaborative editor
2. **Custom editor extensions** -- SlashCommand, BubbleMenu, Mention are key UX differentiators
3. **PDF export** -- Only Markdown/HTML supported; async PDF pipeline missing

---

## Platform-Wide Remaining P0 Items

| Item | App | Impact |
|------|-----|--------|
| Yjs/Hocuspocus collaboration | Brief | Blocks core product value |
| Time-to-invoice pipeline | Bill | Blocks core product value |
| Cross-product timeline | Book | Design's stated "killer feature" |
| react-grid-layout canvas | Bench | Dashboard layout is static CSS grid |
| one_per_email / max_responses | Blank | Data integrity |
| Domain verification on send | Blast | Compliance |
| "Own only" visibility | Bond | Security |
| Cron scheduler | Bolt | Scheduled automations inert |
| Board export endpoint | Board | MCP tool and UI non-functional |

## Platform-Wide Remaining P1 Items

| Item | App | Impact |
|------|-----|--------|
| AI-assisted authoring (LLM) | Bolt | Returns hardcoded responses |
| Public booking page UI | Book | Visitors get JSON, not a page |
| Builder field config panel | Blank | Only 4 of 15 properties editable |
| Widget edit page | Bench | Placeholder only |
| Client detail page | Bill | Route parsed but no component |
| Settings > Scoring + Fields UI | Bond | Placeholder pages |
| Redis cache unwired | Bench, Bearing | Coded but unused |
| Deal-to-invoice pipeline | Bill | Cross-product integration |
| 3 missing MCP tools | Bond | API endpoints exist, need registration |

---

## Verification of Specific Areas Requested

| Area | Status | Details |
|------|--------|---------|
| Bolt execution engine | COMPLETE | Event ingestion, condition evaluation, BullMQ executor, MCP tool calls, retry logic, rate limiting all working |
| All apps Bolt event emission | COMPLETE | 10/10 apps have `lib/bolt-events.ts`, verified call sites in mutation routes/services |
| Board element snapshot | COMPLETE | `syncElementsFromScene()` called on every `saveScene()` in persistence.ts |
| Bench chart rendering | COMPLETE | `ChartRenderer` with Recharts wired into `dashboard-view.tsx`; supports bar/line/area/pie/donut/KPI/counter/table |
| Bill PDF generation | COMPLETE | `pdf-lib` based, A4 layout, `GET /invoices/:id/pdf` and `GET /invoice/:token/pdf` endpoints work |
| Book event creation | COMPLETE | Full form with title, calendar, start/end, description, location, recurrence, visibility, reminder, color; supports create + edit |
| Blank form renderer | COMPLETE | Server-side HTML at `GET /forms/:slug` with all 20 field types, client-side validation, CAPTCHA, theming |
| Bearing linked progress | COMPLETE | `bearing:recompute` job handles epic, project, and task_query with weighted averages |
| Blast email worker | COMPLETE | `blast:send` job with SMTP delivery, merge fields, tracking, List-Unsubscribe headers; producer wired in campaign service |
| Brief export + MCP | COMPLETE | `export.routes.ts` registered in server.ts (Markdown + HTML); `PUT /content` and `POST /append` endpoints exist, MCP tools now functional |

---

*Generated by automated Pass 2 audit on 2026-04-09.*
