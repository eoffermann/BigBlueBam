# Help-Build Discrepancies Audit

Produced 2026-06-14 as a byproduct of the per-app `help.md` documentation build
(`.claude/skills/help-doc-authoring`). Writing code-truth docs for all 16 apps
surfaced a large set of code-vs-docs/marketing gaps and live bugs. Every item
below was confirmed against source by a researcher and a reviewer; the help docs
document the real behavior, so these are tracked here for engineering triage.

Detailed evidence (per-app dossiers and reviews with full file:line citations)
lives under `docs/.help-build/<app>/` (gitignored working artifacts).

**Severity legend**
- **BUG** - a user-facing path is broken or silently fails.
- **GAP** - capability exists in API/MCP but has no UI, or a marketed feature is unimplemented.
- **DRIFT** - generated reference, counts, enums, or naming are out of sync with code (no user-facing break).

---

## bam (Project Management)
- **DRIFT** - generated `mcp-tools.md` omits ~12 registered tools; docs understate custom-field types (omit `checkbox`, `url`); priorities are per-org configurable, not a fixed enum; swimlanes are by assignee/priority/epic (not "label").
- **DRIFT** - the task drawer has no watcher-management control (watchers are system-populated); the dossier listed a watcher UI that does not exist.

## banter (Team Messaging)
- **BUG** - Search page 404s: it calls `/search` but only `/search/messages` exists (`apps/banter/src/pages/search.tsx:58`). The header search bar is affected too.
- **BUG** - Compose file upload reads `result.data.id` (`apps/banter/src/components/messages/message-compose.tsx:107`) which the upload route never returns, so attachments may not attach.
- **BUG** - Channel-settings add-member posts `{identifier}` but the API requires `{user_ids:[]}`, so it likely 400s. Use `banter_add_channel_members`.
- **GAP** - Voice/audio calls were removed from Banter: call write endpoints return HTTP 410 (`apps/banter-api/src/routes/call.routes.ts`); live audio moved to Bureau. Docs/marketing and the MCP call write tools still target the dead endpoints.
- **GAP** - Preferences page persists a field set the backend does not consume (only `compact_mode` overlaps; theme is localStorage-only).
- **GAP** - Admin "Who can create channels" offers 3 options but the API accepts only `members|admins` (`apps/banter-api/src/routes/admin.routes.ts`).
- **DRIFT** - 53 tools (not 54); generated `mcp-tools.md`/`guide.md` omit the 3 subscription tools and `banter_schedule_post`.

## bond (CRM)
- **BUG** - In-app Edit actions are unwired (empty `onSelect={() => {}}`): Edit Deal (`apps/bond/src/pages/deal-detail.tsx:160`), Edit Contact and the contact-menu Create Deal (`contact-detail.tsx:138,142`), Edit Company (`company-detail.tsx:145`). Editing is MCP/REST only.
- **GAP** - Pipeline stage reorder and per-stage probability/rotting/color editing are not wired (drag handle shown, no save); the Add stage form only sets name + type.
- **GAP** - No recalculate-score button in the UI; no in-app dedupe review screen (dedupe is API/MCP only).
- **DRIFT** - custom fields and scoring rules are per-entity-type / org-wide, not "per pipeline" as the guide claims.

## beacon (Knowledge Base)
- **BUG** - Editor tags are silently dropped on create AND edit (`apps/beacon-api/src/services/beacon.service.ts` createBeacon ~145-186, updateBeacon ~375-415 never persist `data.tags`).
- **BUG** - Publish from Pending Review errors: `publishBeacon` (~442-447) accepts only Draft, but the Pending Review status renders a Publish button.
- **BUG** - Restore on a Retired beacon is rejected: `restoreBeacon` (~473-478) only restores Archived, but the button renders on Retired.
- **GAP** - Knowledge-graph link creation has no UI (read-only display; create via `beacon_link_create`/`beacon_link_remove`).
- **GAP** - The `Expired` status is in the enum/lifecycle map but has no badge and is never set by the sweep (unreachable in the UI).
- **DRIFT** - the editor is a Markdown textarea (not a rich-text editor); the dashboard is freshness-only (not view/search analytics); retire emits the legacy `beacon.expired` Bolt event.

## brief (Documents)
- **BUG** - The editor "Public" visibility is an invalid enum (backend accepts `private|project|organization`), so selecting it errors on save (`document-editor.tsx:28` vs `brief-documents.ts:30-34`).
- **BUG** - Home "Recently Updated" stat always reads 0 (`home.tsx:27` reads `stats.recent`, never returned by `getStats` `document.service.ts:621-627`).
- **GAP** - `summary`, `published_at`, and `version` have no backend columns; the editor's "Brief summary" input is dropped and the Version button can render "vundefined" (`document-detail.tsx:293`).
- **GAP** - Collaborator management and link creation have no UI (task links via `brief_link_task`; collaborators and beacon links are API/MCP only). The "In Review" status is unreachable from the UI.
- **GAP** - `brief_search` semantic/limit params are no-ops (it hits the text route; the vector route uses a stubbed zero-vector embedding).

## bolt (Workflow Automation)
- **BUG** - "Test Run" is broken: `useTestAutomation` (`apps/bolt/src/hooks/use-automations.ts:219-224`) POSTs `/test` with no body while the route requires `event` (`automation.routes.ts:179-180`); the editor then reads `testMutation.data.data.execution_id` (`automation-editor.tsx:575`) but the service returns only `{passed,log,message}` (`automation.service.ts:906-927`).
- **GAP** - AI authoring (`/ai/generate`, `/ai/explain`) and automation versioning (`/versions`) are backend/API only, no UI.
- **DRIFT** - the engine runs a linear action list (no branching) despite marketing; some catalog templates are placeholders.

## bearing (Goals & OKRs)
- **BUG** - Several frontend calls hit routes that do not exist: dashboard report `usePeriodReport` -> `GET /periods/:id/report` (real route `/reports/period/:periodId`); KR inline Update `useSetKrValue` -> `/key-results/:id/set-value` (real `/value`); plus `/goals/:id/override-status` (real `/goals/:id/status`). The dashboard stats, the progress chart, and the KR inline Update do not function.
- **GAP** - The add-watcher UI always subscribes the calling user, not an arbitrary user.
- **GAP** - KR-to-entity linking (`LinkEditor` is rendered by no page) and Reports/Export have no human UI (agent/REST only).
- **DRIFT** - period status `planning` (backend) vs `draft` (UI store); the Activate guard checks `=== 'draft'` (`PeriodListPage.tsx:119`), which can hide Activate on new periods. No `parent_goal_id`, so there is no goal hierarchy despite marketing.

## board (Visual Collaboration)
- **BUG** - The Share button and the Export-as-PNG/SVG menu items have no handlers (`apps/board/src/components/canvas/board-toolbar.tsx:135-142,165-172`); collaborator REST exists but has no frontend.
- **GAP** - The version dialog's Description and the list's `element_count`/`creator_name` are dropped (the backend stores/returns only `name`).
- **DRIFT** - audio conferencing is the cross-cutting Bureau system, not board-api (marketing misattributes it to Board); visibility `org` (frontend) vs `organization` (backend); `board_update.locked` likely no-ops (PATCH does not accept `locked`); `yjs_state` holds plain Excalidraw JSON (no Yjs yet); chat is poll-only.

## blast (Email Campaigns)
- **BUG** - The worker send job ignores `segment_id` and sends to the whole org (`apps/worker/src/jobs/blast-send.job.ts:219-236`), even though `/segments/:id/evaluate` works.
- **GAP** - Campaign detail exposes only "Send Now"; schedule/pause/cancel/edit/delete and segment-edit are API/MCP only.
- **GAP** - Two "AI" MCP tools (`blast_draft_email_content`, `blast_suggest_subject_lines`) are hard-coded stubs.
- **DRIFT** - no `archived` campaign state (docs claim it; real enum is draft/scheduled/sending/paused/sent/cancelled); A/B testing is marketed but unimplemented; SMTP is platform-wide (Bam Account Settings -> Integrations), the Blast page stores nothing; `total_delivered` is counted as `sent` (no delivery webhook exists).

## bench (Analytics)
- **BUG** - The `bam:tasks` and `helpdesk:tickets` data sources return nothing: the registry leaves `orgColumn` at the default `organization_id`, but neither table has that column (both are project-scoped only), so every query 42703s (`0000_init.sql:198`). This kills the seeded task widgets and the helpdesk gallery presets. No single-string fix - those sources need a join to `projects`.
- **GAP** - Widget Gallery presets reference non-existent sources/fields (`data_source: 'mv'`, `points`, `sprint_name`, `state_name`, `total_tasks`).
- **GAP** - The Dashboard-view date-range picker is inert (its state never reaches widget queries; `from/to` vs server `start/end`); the saved-query -> Explorer "Run" handoff is unwired.
- **DRIFT** - no drag-and-drop canvas (marketing); report delivery is a logging stub (`"simulating delivery (stub)"`); anomaly detection and period comparison are MCP only.

## book (Scheduling)
- **BUG** - The on-booking Bond contact-create hook 401s on every booking and the error is swallowed (`apps/book-api/src/routes/public-booking.routes.ts:94-111` sends only `x-internal-secret`; Bond's contacts route requires session/API-key auth with no internal ingress `apps/bond-api/src/routes/contacts.routes.ts:110-126`). See `docs/strategy/book-bond-booking-integration.md`.
- **BUG** - The public `/meet` page is functionally broken: slot field-shape mismatch (`meet.tsx` reads `start_at`/`end_at`; the backend returns `{start,end}` `booking-page.service.ts:227-230`), so a booking cannot complete.
- **BUG** - The booking-page editor edit mode calls a nonexistent route `GET /v1/booking-pages/:id` (`use-booking-pages.ts:39`), so editing an existing page does not populate.
- **GAP** - Timeline view field-shape mismatch (frontend reads `item.date`/`url`/`source: bam|bond`; backend returns `start_at`/`end_at`, `source: bam_task|bond_deal`, no `url`). Reminders, per-event color, drag-to-create/resize, external OAuth calendar sync, and recurrence expansion are claimed/implied but absent or stubbed (`event-form.tsx:116-126`, `connections.tsx`).
- **DRIFT** - a "Feature under development" banner shows on a shipped feature.

## blank (Forms)
- **BUG** - The builder "Page Break" palette item sends a `field_type` the REST enum rejects (`form-builder.tsx:51` vs `fields.routes.ts:10-18`). Page Number is the working multi-page mechanism.
- **GAP** - No UI for Close form, Delete submission, embed code, routing config, or notify-email recipients (the backend supports all of these).
- **DRIFT** - docs/marketing claim a "signature" field type, builder "conditional logic", and "completion rate / drop-off" analytics; none exist in code. Two competing public-form URLs (server-rendered `/forms/:slug` vs SPA `/blank/f/:slug`); `requires_login`/`allowed_domains` unenforced; CAPTCHA has no toggle.

## bill (Invoicing)
- **BUG** - The "Invoice from Time Entries" UI page is a non-functional stub (no API call; the "Preview Line Items" button is disabled) (`apps/bill/src/pages/invoice-from-time.tsx`).
- **BUG** - `bill_create_invoice_from_time` likely fails validation: it sends `date_from`/`date_to` but the API requires `time_entry_ids[]`.
- **GAP** - The `overdue`/`written_off` invoice statuses and the `reimbursed` expense status have no write path, so the "Overdue" filter pill + dashboard tile and the reimbursed pill never populate.
- **GAP** - The public token invoice view is API-token read-only with no client-facing payment. Many API capabilities (void/duplicate/edit/delete, rate update/resolve) have no UI or MCP tool.
- **DRIFT** - no recurring billing exists anywhere in code; invoice numbers format as `INV-00001` while seeds/docs use `INV-2026-0042`; money inputs are raw cents.

## blueprint (Structured Diagrams)
- **BUG** - The editor auto-layout dropdown offers Tree and Grid (`tree`/`grid`), but the ELK map only accepts `layered`/`mrtree`/`force`/`radial`/`rectpacking`/`manual`, so picking those two fails with "Unknown algorithm" (`apps/blueprint-api/src/services/layout.service.ts`).
- **GAP** - Templates are inert: `template_id` is accepted but never applied, and there is no endpoint to create templates. SVG/PNG export and queued large-graph layout are advertised but not wired (no Blueprint worker handler). Versions, anchored comments, collaborators, and Mermaid import have backend endpoints but no rendered UI (agent/API only).
- **DRIFT** - `blueprint_search` is client-side substring only; promote-to-task(s) returns a plan/payload the SPA executes; the module registers 23 `blueprint_*` tools (CLAUDE.md/dossier said 22/~20).

## bureau (Virtual Office)
- **GAP** - `bureau_locate_user` (`/presence/locate`), `bureau_get_presence` (`/presence`), and `bureau_set_status` (`/me/status`) are stubs hitting unbuilt endpoints; real status is set over the live WebSocket `set_status` frame via the docked box. There is no org-settings page in the SPA (settings are API/MCP only); the `free_walk` setting is unreachable via `PATCH /settings` (`settings.routes.ts:19-25`).
- **DRIFT** - `bureau_set_status` enum (`active|dnd|away`) does not match the canonical status set (`available|busy|dnd|focus|away|in_meeting`) (`bureau-tools.ts:269` vs `ws.routes.ts:132-139`); multi-building exists in the data model with no management screen; CLAUDE.md's MCP inventory predates Bureau.

## helpdesk (Support Portal)
- **BUG** - The MCP `update_ticket_status` enum uses `waiting_on_client`, which the route's Zod enum (canonical `waiting_on_customer`) rejects. The list-filter chips use `awaiting_customer`/`awaiting_internal`, which match no status (dead filters). Three-way status drift.
- **GAP** - There is no agent SPA; the agent queue is REST/MCP only. The agent-queue SLA badge is hardcoded to 4h while the worker breach sweeper uses per-org `sla_first_response_minutes` (default 8h).
- **DRIFT** - the guide and a `05-knowledge-base.png` screenshot describe a Helpdesk Knowledge Base that does not exist in code; the real knowledge base is the separate Beacon app.

---

## Cross-cutting follow-ups
- **Screenshots for blueprint and bureau** do not exist (those apps had no `docs/apps/` dir and no captures). Generating them requires seeding data into each app, then running the screenshot capture flow. Their help docs note that a visual walkthrough is not yet available.
- **Generated references are stale** for several apps (tool counts, omitted tools, phantom features). Regenerating `docs/apps/<app>/guide.md` and `mcp-tools.md` from current code would resolve most DRIFT items.
