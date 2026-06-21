# Book Implementation Plan (2026-04-14)

## Scope

Book is 72% complete at `f5fb079` with all 8 core schema tables (migration 0036), 28 REST endpoints, full calendar UI (week/day/month), iCal feed generation, and public booking with row-lock double-booking prevention. Gaps cluster into three areas: (1) cross-product timeline aggregation (Bam/Bearing/Bond/Blast calls commented out in `timeline.service.ts`), (2) external calendar sync stubs (OAuth flow + BullMQ polling absent), (3) Bolt event emission gaps (`event.cancelled` and `event.rsvp` not published).

**In scope (P0):** public booking page UI, cross-product timeline queries, `event.cancelled` and `event.rsvp` Bolt emissions, external-event translucent blocks on day view.

**In scope (P1):** booking page editor form field completion, public slot constraint enforcement (min_notice_hours / max_advance_days), auto-create Bond contact / Bam task on booking, external calendar polling worker, week view multi-column layout for concurrent events, connections UI wiring.

**Out of scope:** Full OAuth consent flows, two-way sync back to Google/Microsoft, token refresh rotation, recurring RRULE beyond daily/weekly/monthly, room/equipment booking, video conferencing integration, viewer role restrictions, bulk event operations.

## Gap inventory

| Gap | Priority | Citation | Summary |
|---|---|---|---|
| G1 | P0 | audit §P0 item 1 | Public booking page UI (/meet/:slug visitor experience) |
| G2 | P0 | audit §P0 item 2 | Cross-product timeline queries (Bam tasks, sprints, Bearing goals, Bond deals, Blast campaigns) |
| G3 | P0 | audit §P0 item 3 | External calendar events as translucent blocks on day view |
| G4 | P0 | audit §P0 event gap | `event.cancelled` and `event.rsvp` Bolt event emissions |
| G5 | P1 | audit §P1 item 1 | Booking page editor data loading for all dynamic fields |
| G6 | P1 | audit §P1 item 2 | Public slot availability respecting min_notice_hours and max_advance_days |
| G7 | P1 | audit §P1 item 3 | Auto-create Bond contact and Bam task on booking |
| G8 | P1 | audit §P1 item 4 | Connections UI wired to API |
| G9 | P1 | audit §P1 item 5 | External calendar polling BullMQ job |
| G10 | P1 | audit §P1 item 6 | Week view multi-column layout for concurrent events |
| G11 | P2 | audit §P2 item | Redis availability cache |

## Migrations

**Reserved slots: 0101, 0102 (unused).**

All Book schema is present in `0036_book_tables.sql`. No new migrations required for Phase 1. Slots 0101 and 0102 are reserved unused for future Book enhancements (OAuth token encryption at rest, external event versioning).

## Schemas and shared types

- `packages/shared/src/schemas/book.ts` (new) — `BookEventStatus`, `BookVisibility`, `BookAttendeeResponse`, `TimelineItem` discriminated union (book / bam_task / bam_sprint / bearing_goal / bond_deal / blast_campaign), `PublicBookingPageInfo`, `AvailabilitySlot`.
- No Drizzle schema changes. All columns (`max_advance_days`, `min_notice_hours`, `confirmation_message`, `redirect_url`, `auto_create_bond_contact`, `auto_create_bam_task`, `bam_project_id`, `logo_url`) already exist in `apps/book-api/src/db/schema/book-booking-pages.ts`.

## API routes and services

### New routes

- `GET /meet/:slug/html` (G1) — server-rendered HTML shell for public booking pages. Loads booking page, renders minimal HTML that bootstraps the public React bundle.

### Route updates

- `DELETE /events/:id` (G4) — after `eventService.deleteEvent()` succeeds, publish `event.cancelled` Bolt event with enriched event payload, actor, org.
- `POST /events/:id/rsvp` (G4) — after `eventService.rsvpEvent()` succeeds, publish `event.rsvp` Bolt event with event, response_status, respondent, actor, org.

### New services

- `apps/book-api/src/services/public-booking-ui.service.ts` (new, G1) — `renderPublicBookingHTML(page)` returns HTML shell that loads the public React bundle and passes slug + api URL via window globals.

### Service updates

- `apps/book-api/src/services/booking-page.service.ts` `getPublicSlots(slug, startDate, endDate)` (G6) — filter slots by `min_notice_hours` (hours between now and slot.start) and `max_advance_days` (days between now and slot.start). Pull values from the loaded `BookBookingPage`.
- `apps/book-api/src/services/booking-page.service.ts` `bookSlot()` (G7) — after event creation, if `page.auto_create_bond_contact`, fire-and-forget `POST ${BOND_API_URL}/contacts` with `{ email, name, organization_id, source: 'book_booking_page', source_id: page.id }`. If `page.auto_create_bam_task && page.bam_project_id`, fire-and-forget `POST ${BAM_API_URL}/tasks` with `{ project_id, title, description, due_at, organization_id }`.
- `apps/book-api/src/services/timeline.service.ts` (G2) — replace all commented placeholders with real `fetch()` calls to Bam tasks (`/b3/api/tasks?due_between=...`), Bam sprints (`/b3/api/sprints?date_between=...`), Bearing goals (`/bearing/api/goals?target_between=...`), Bond deals (`/bond/api/deals?close_date_between=...`), Blast campaigns (`/blast/api/campaigns?send_between=...`). Each try/catch isolates failures so one downstream outage does not break the whole timeline. Merge, sort by `start_at`, return as discriminated-union items.
- `apps/book-api/src/services/external-sync.service.ts` `forceSync(id, userId)` (G9) — replace stub. Branch on `connection.provider`: `google` calls `https://www.googleapis.com/calendar/v3/calendars/{externalCalendarId}/events` with `Authorization: Bearer ${access_token}`, upserts into `book_external_events` keyed on `(connection_id, external_event_id)`; `microsoft` calls Microsoft Graph `/me/calendars/{id}/calendarview`. On success update `last_sync_at`, `sync_status='active'`, `sync_error=null`; on failure set `sync_status='error'` and `sync_error=error.message`.

## Frontend pages and components

### New components and pages

- `apps/book/src/pages/public-booking-page.tsx` (new, G1) — public-facing booking UI. Fetches booking page metadata, date picker restricted to `max_advance_days` window, slot picker respecting constraints, name/email/notes form, confirmation screen with `confirmation_message` and optional redirect to `redirect_url`. No auth required.
- `apps/book/src/components/calendar/external-event-block.tsx` (new, G3) — translucent amber block overlay for external busy events on day view.

### Page updates

- `apps/book/src/pages/booking-page-editor.tsx` (G5) — populate form state from API response for all dynamic fields: `max_advance_days`, `min_notice_hours`, `confirmation_message`, `redirect_url`, `auto_create_bond_contact`, `auto_create_bam_task`, `bam_project_id`, `logo_url`, `color`. Add form inputs for each. Wire save handler to PATCH endpoint with full payload.
- `apps/book/src/pages/calendar-day.tsx` (G3) — load `book_external_events` for displayed date range, render each as `<ExternalEventBlock>` positioned by `start_at`/`end_at`, labelled "(Busy)".
- `apps/book/src/pages/calendar-week.tsx` (G10) — multi-column layout for overlapping events. Compute column assignments via greedy interval packing: for each event, place in first column whose latest event ends before this event starts. Render at `left: col * (cellWidth / columns)` and `width: cellWidth / columns`.
- `apps/book/src/pages/connections.tsx` (G8) — replace static placeholder. Fetch `GET /v1/connections`, render list. "Connect Google" / "Connect Microsoft" buttons redirect to `/book/api/connections/{provider}/oauth`. Trash button calls `DELETE /v1/connections/:id`. Show `last_sync_at` and `sync_status` per connection.

## Worker jobs

### `apps/worker/src/jobs/book-external-sync.job.ts` (new, G9)

Payload: `{ connection_id, user_id }`.

Pipeline:
1. Look up `book_external_connections` row by id, verify `sync_status='active'`.
2. Call `externalSyncService.forceSync(connection_id, user_id)`.
3. On failure, job retries 2 times with exponential backoff; on final failure, service sets `sync_status='error'`.

Trigger: BullMQ repeating job every 5 minutes. Each tick queries `book_external_connections WHERE sync_status='active'` and enqueues one sync job per connection with `removeOnComplete: true`.

Register in `apps/worker/src/index.ts` alongside other Book jobs.

## MCP tools

No new tools. Existing `book_get_timeline` tool now returns cross-product aggregated data because the underlying service is fixed. All 10 tools remain unchanged in signature.

## Tests

- `apps/book-api/src/services/__tests__/timeline.service.test.ts` (new, G2) — mock internal `fetch()` for each cross-product endpoint, verify aggregation order by `start_at`, verify one failing endpoint does not break the rest.
- `apps/book-api/src/services/__tests__/booking-page.service.test.ts` (update, G6, G7) — `getPublicSlots()` filters by `min_notice_hours` and `max_advance_days`; `bookSlot()` calls Bond contact and Bam task endpoints when flags enabled.
- `apps/book-api/src/services/__tests__/external-sync.service.test.ts` (update, G9) — mock Google Calendar and Microsoft Graph responses, verify upserts and status transitions.
- `apps/book-api/src/routes/__tests__/events.test.ts` (update, G4) — `DELETE /events/:id` publishes `event.cancelled`; `POST /events/:id/rsvp` publishes `event.rsvp`.
- `apps/book/src/pages/__tests__/public-booking-page.test.tsx` (new, G1) — date selection, slot selection, booking submission, confirmation.
- `apps/book/src/pages/__tests__/calendar-week.test.tsx` (update, G10) — concurrent events render in separate columns.
- `apps/worker/src/jobs/__tests__/book-external-sync.test.ts` (new, G9) — enqueues one job per active connection, handles failure by updating sync_status.

## Verification steps

```bash
pnpm --filter @bigbluebam/book-api build
pnpm --filter @bigbluebam/book-api typecheck
pnpm --filter @bigbluebam/book-api test
pnpm --filter @bigbluebam/book typecheck
pnpm --filter @bigbluebam/book test
pnpm --filter @bigbluebam/worker test
pnpm lint:migrations

docker run --rm -d --name bbb-book-verify -e POSTGRES_DB=verify -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -p 55494:5432 postgres:16-alpine
sleep 5
DATABASE_URL='postgresql://verify:verify@localhost:55494/verify' node apps/api/dist/migrate.js
DATABASE_URL='postgresql://verify:verify@localhost:55494/verify' pnpm db:check
docker rm -f bbb-book-verify
```

**Live smoke tests:** create a booking page with all dynamic fields, visit `/meet/:slug`, verify constraints enforced; book a slot with auto-create flags enabled, verify Bond contact and Bam task created; cancel a Book event, verify `event.cancelled` reaches Bolt ingest; RSVP to an event, verify `event.rsvp` reaches Bolt; connect a test Google calendar, trigger sync, verify `book_external_events` populated; view day calendar, verify external events render as translucent amber blocks; view week calendar with 3 overlapping events, verify side-by-side columns.

## Out of scope

OAuth consent flow (tokens accepted as-is), two-way push sync, token refresh rotation, recurring RRULE patterns beyond daily/weekly/monthly, room/equipment booking, video conferencing integration, viewer role title-only restrictions, bulk event operations, booking confirmation emails, bot attendee transcription.

## Dependencies

- `googleapis` or direct `fetch` for Google Calendar API v3 (simpler to use direct fetch).
- `@microsoft/microsoft-graph-client` or direct `fetch` for Microsoft Graph.
- BullMQ (already in worker) for `book:external-sync` queue.
- Env vars: `BOOK_API_URL`, `BAM_API_URL`, `BOND_API_URL`, `BEARING_API_URL`, `BLAST_API_URL`, `PUBLIC_URL`.
- Bolt API event ingest (already working).
- Bond, Bam, Bearing, Blast APIs for timeline aggregation and auto-create.

**Migration numbers claimed: none. Reserved unused: 0101, 0102.**
