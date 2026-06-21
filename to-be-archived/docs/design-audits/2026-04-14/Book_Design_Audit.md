# Book Design Audit (2026-04-14)

## Summary

Book implements a functional foundation for team scheduling and external booking pages with approximately 72% design coverage. Core data models are complete (8 Drizzle schema tables), all REST API endpoints are wired (28 routes across 8 endpoint modules), calendar UI provides week/day/month views, and the MCP tool surface is fully implemented (10 tools for event CRUD, availability, timeline, booking pages). Production-ready elements include calendar and event management, working hours configuration, iCal feed authentication, and public booking with double-booking prevention via row-level locking. Major gaps remain in three areas: cross-product timeline aggregation (only Book events returned, not Bam task due dates, sprint boundaries, Bearing deadlines, or Bond deal close dates), external calendar synchronization (OAuth flows and BullMQ polling are stubs), and Bolt event integration (event.cancelled and rsvp events not emitted). Secondary gaps include missing booking page editor data-load, incomplete slot availability constraints, and no public UI for the /meet/:slug booking endpoint.

## Design sources consulted

- `docs/early-design-documents/Book_Design_Document.md` (v1.0, April 8, 2026)
- `docs/design-audits/2026-04-09/Book-Design-Audit-2026-04-09.md` if it exists
- `CLAUDE.md`
- `infra/postgres/migrations/0036_book_tables.sql`

## Built and working

### Data model

All 8 PostgreSQL tables are present with correct structure per `0036_book_tables.sql`:
- `book_calendars` - 10 columns, 3 indexes
- `book_events` - 17 columns, 4 indexes
- `book_event_attendees` - 6 columns, 2 indexes
- `book_working_hours` - 6 columns, unique (user, day_of_week)
- `book_booking_pages` - 15 columns, 3 indexes
- `book_external_connections` - 9 columns, 1 index
- `book_external_events` - 7 columns, 1 index + unique (connection, external_event_id)
- `book_ical_tokens` - 4 columns, 1 index (bonus addition supporting iCal feeds)

All check constraints, unique constraints, and foreign key relationships match design. No schema drift observed.

### REST API endpoints

**Calendars** (`apps/book-api/src/routes/calendars.routes.ts`, 4 endpoints): list, create, update, admin-only delete.

**Events** (`events.routes.ts`, 6 endpoints): list with date range filter, create with attendees + recurrence + linked_entity, get, partial update, soft-cancel via DELETE, RSVP with org/user membership validation. Events publish fire-and-forget Bolt events (event.created, event.updated).

**Availability** (`availability.routes.ts`, 4 endpoints): per-user slots from working hours minus Book+external events, team common availability, get/put working hours (full 7-day replacement).

**Booking Pages** (`booking-pages.routes.ts`, 4 endpoints): list user's pages, create with slug uniqueness, update including enabled flag, hard delete.

**Public Booking** (`public-booking.routes.ts`, 3 no-auth endpoints): page info, available slots with buffer/duration, book slot with row-level locking (publishes booking.created Bolt event).

**External Sync** (`connections.routes.ts`, 4 endpoints): list user's connections, create Google/Microsoft connection (accepts raw tokens), delete, force immediate sync (stub).

**Timeline** (`timeline.routes.ts`, 1 endpoint): aggregated timeline (Book events only; commented placeholders for Bam/Bond/Bearing/Blast).

**iCal** (`ical.routes.ts`, 2 endpoints): generate token-authenticated subscription, serve VCALENDAR feed with VEVENT entries (token in query string).

### MCP tools

All 10 tools implemented in `apps/mcp-server/src/tools/book-tools.ts` with name resolution: `book_list_events`, `book_create_event`, `book_update_event`, `book_cancel_event`, `book_get_availability`, `book_get_team_availability`, `book_find_meeting_time`, `book_create_booking_page`, `book_get_timeline`, `book_rsvp_event`.

Helper functions: `resolveCalendarId`, `resolveEventId` (1-year search window), `resolveUserIdByEmail` (Bam integration).

### Frontend

11 pages (1904 lines total):
- `calendar-week.tsx` - 7-column grid, event positioning by computed start/duration, time gutter, day headers
- `calendar-day.tsx` - single-column day detail, hourly rows, event list
- `calendar-month.tsx` - month grid with up-to-3 event dots per day, "+N more" overflow indicator
- `event-form.tsx` - full creation form (title, start/end, calendar, attendees, recurrence, description, location, meeting URL, all-day)
- `event-detail.tsx` - read-only event view with attendees, booking info, status badge, cancel action
- `booking-page-list.tsx` - list table with slug, title, enabled status, edit/delete
- `booking-page-editor.tsx` - create-only form
- `working-hours.tsx` - 7-day form with time pickers per day, enable/disable toggles
- `connections.tsx` - static placeholder UI (not wired to API)
- `timeline.tsx` - Gantt-style horizontal bars, legend for Bam/Bearing/Bond/Blast (renders Book events only)

### Infrastructure

- Fastify server on port 4010
- Auth plugin with session and API key (Argon2id)
- CORS from env, rate limiting (global + per-route overrides)
- Health checks: `/health`, `/health/ready` with DB + Redis validation
- Drizzle ORM with postgres driver

## Partial or divergent

### Event-level Bolt emission gaps

- `event.created` and `event.updated` published from events.routes.ts (with enrichment).
- `event.cancelled` NOT published (DELETE endpoint does not emit).
- `event.rsvp` NOT published (RSVP endpoint does not emit).
- `booking.created` published from public-booking.routes.ts.

### Booking page editor (create-only)

`booking-page-editor.tsx` does not load existing page for editing. Missing fields in the form: `max_advance_days`, `min_notice_hours`, `confirmation_message`, `redirect_url`, `auto_create_bond_contact`, `auto_create_bam_task`, `bam_project_id`, `logo_url`.

### Slot availability constraints

Public slot availability computes correctly but does not enforce `min_notice_hours` or `max_advance_days` from the booking page settings.

### Week view event overlap

Events positioned absolutely but no multi-column layout for concurrent events (they stack instead of side-by-side).

### Connections frontend

`connections.tsx` is a static placeholder UI. "Connect Google" and "Connect Microsoft" buttons are disabled. Hardcoded empty connections array. Does not call `/v1/connections` API.

### External calendar sync

POST `/v1/connections/:id/sync` updates `last_sync_at` timestamp but does not fetch Google Calendar API or Microsoft Graph. No polling background job. No Redis lock management.

### Auto-create flags

`book_booking_pages.auto_create_bond_contact` and `auto_create_bam_task` columns exist but `bookSlot()` ignores them.

## Missing

### P0

1. **Public booking page UI** - No HTML/React component for /meet/:slug visitor experience. Endpoint returns JSON, not suitable for end users.
2. **Cross-product timeline queries** - Bam task due dates, sprint boundaries, Bearing goal deadlines, Bond deal close dates, Blast campaign send dates all commented out in `timeline.service.ts`.
3. **External calendar events on day view** - Translucent blocks showing external events not implemented.

### P1

4. **Booking page editor data loading** - edit form cannot populate existing page fields.
5. **Slot availability respecting min_notice_hours and max_advance_days**.
6. **Auto-create Bond contact and Bam task in bookSlot()** - schema flags exist but ignored.
7. **RSVP and cancelled event Bolt emissions**.
8. **Connections page wired to real API with OAuth redirect flow**.
9. **External calendar polling BullMQ job** (5-minute interval).
10. **Week view multi-column layout** for concurrent events.

### P2

11. **Redis availability cache** - Redis plugin registered but `availability.service.ts` queries PostgreSQL directly.
12. **Bot attendees, recording toggles** - Banter-related call integration.
13. **Bulk event operations** - batch create/update/cancel.
14. **Viewer role restrictions** - titles-only event detail access not enforced.

## Architectural guidance

### Public booking page UI

Create `apps/book/src/pages/public-booking-page.tsx` as a branded standalone React component. Since `/meet/:slug` is outside auth, it needs its own minimal Vite bundle or a public-page route that bypasses the auth gate. Pattern: query `GET /meet/:slug` for page info, `GET /meet/:slug/slots` for available times, show date picker + slot picker, submit via `POST /meet/:slug/book`, display confirmation page.

### Cross-product timeline

Update `timeline.service.ts` to call internal app APIs:
- Bam: `GET /tasks?due_between=<start>&<end>&org_id=<org>`
- Bearing: `GET /goals?target_between=<start>&<end>`
- Bond: `GET /deals?close_date_between=<start>&<end>`
- Blast: `GET /campaigns?scheduled_between=<start>&<end>`

Aggregate into a uniform timeline_item shape. Cache via Redis with 60-second TTL since timeline data changes relatively slowly.

### External calendar sync worker

Create `apps/worker/src/jobs/book-external-sync.job.ts` that runs every 5 minutes:
1. Load all active connections.
2. For each, use Google Calendar API or Microsoft Graph to fetch events in the next 60-day window.
3. Upsert into `book_external_events`.
4. Update `last_sync_at` on connection.
5. Handle rate limits with exponential backoff.

### Auto-create integration in bookSlot

Modify `booking-page.service.ts bookSlot()` to check page flags:
- If `auto_create_bond_contact`, call Bond API to create contact with booker email/name.
- If `auto_create_bam_task` and `bam_project_id` set, call Bam API to create task referencing booking.

Both calls should be fire-and-forget and not block the booking response.

## Dependencies

### Inbound

- MCP tools expose Book operations to AI agents.
- Bam task-to-booking links (future).
- Bond contact-to-booking links (future).
- Bolt subscribes to Book events.

### Outbound

- Bam API for task lookup and creation.
- Bond API for contact creation.
- Google Calendar API and Microsoft Graph (external sync).
- Bolt API for event publishing.

## Open questions

1. **Public booking page bundle:** Should the public booking page be part of the main Book SPA or a separate standalone bundle? Standalone allows minimal JS for public visitors but adds build complexity.
2. **External calendar sync direction:** Push direction (Book -> Google) requires write scopes. Is one-way (pull only) sufficient for Phase 1?
3. **Booking confirmation email:** Should booking confirmation emails be sent immediately (blocking response) or via worker queue? Recommend worker queue.
4. **Calendar sharing granularity:** Design mentions shared calendars. Should calendar membership be separate table or flag on calendar row?
5. **Timeline caching:** 60-second TTL for aggregated timeline seems right, but invalidation on upstream event creation would be more accurate. Worth the complexity?
