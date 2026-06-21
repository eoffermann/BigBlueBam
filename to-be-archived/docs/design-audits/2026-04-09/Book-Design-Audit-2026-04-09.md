# Book (Scheduling & Calendar) -- Design Audit

**Date:** 2026-04-09
**Auditor:** Claude (automated)
**Design Document:** `docs/DO_NOT_CHECK_IN_YET/Book_Design_Document.md` v1.0
**Implementation:** `apps/book-api/src/` (32 files), `apps/book/src/` (21 files), `apps/mcp-server/src/tools/book-tools.ts`

---

## Executive Summary

**Overall Completion: ~72%**

Book has a solid foundation with all core data models implemented, all primary API endpoints wired up, a functional SPA with calendar views (week, day, month), a timeline view, booking page management, working hours configuration, and external connection stubs. The MCP tool surface is fully implemented (10/10 tools). The main gaps are in cross-product aggregation (timeline only returns Book events, not Bam/Bond/Bearing/Blast data), external calendar sync (OAuth and BullMQ polling are stubs), Bolt event integration (no events emitted), booking page editor limitations (create-only, no edit-load), and missing Redis availability caching.

| Rating | Count | Meaning |
|--------|-------|---------|
| P5     | 18    | Fully matches design |
| P4     | 13    | Implemented with minor gaps |
| P3     | 8     | Partially implemented, notable missing pieces |
| P2     | 5     | Skeleton/stub only |
| P1     | 2     | Mentioned but barely started |
| P0     | 3     | Never implemented |

---

## Feature Ratings Table

### 3. Data Model (Section 3)

| # | Feature | Rating | Notes |
|---|---------|--------|-------|
| 3.1 | `book_calendars` table | P5 | Drizzle schema matches design exactly. All columns, types, indexes present. |
| 3.2 | `book_events` table | P5 | All columns present including recurrence, linked entities, booking source. Indexes match. |
| 3.3 | `book_event_attendees` table | P5 | Schema matches design. |
| 3.4 | `book_working_hours` table | P5 | All columns present, unique constraint, check constraint. |
| 3.5 | `book_booking_pages` table | P5 | Full schema including branding, integration flags, slug uniqueness. |
| 3.6 | `book_external_connections` table | P5 | All columns including OAuth tokens, sync config, status. |
| 3.7 | `book_external_events` table | P5 | Mirror table with unique constraint on (connection_id, external_event_id). |
| 3.8 | `book_ical_tokens` table (bonus) | P5 | Not in design doc but supports the iCal feed feature. Good addition. |
| 3.9 | SQL migration | P4 | `0036_book_tables.sql` exists. Not audited for idempotency. |

### 4. API Endpoints (Section 4)

| # | Feature | Rating | Notes |
|---|---------|--------|-------|
| 4.1a | `GET /calendars` | P5 | Filters by org, user, calendar_type. |
| 4.1b | `POST /calendars` | P5 | Creates with all fields, role/scope guards. |
| 4.1c | `PATCH /calendars/:id` | P5 | Updates metadata, org-scoped. |
| 4.1d | `DELETE /calendars/:id` | P5 | Admin-only, prevents deleting default calendar. |
| 4.2a | `GET /events` | P5 | Date range, calendar filter, pagination with total count. |
| 4.2b | `POST /events` | P5 | Full creation with attendees, recurrence, linked entities. Rate limited. |
| 4.2c | `GET /events/:id` | P5 | Returns event with attendees joined. |
| 4.2d | `PATCH /events/:id` | P4 | Updates event but does not support updating attendees list. |
| 4.2e | `DELETE /events/:id` | P5 | Soft-cancels (sets status=cancelled) rather than hard delete. Good. |
| 4.2f | `POST /events/:id/rsvp` | P5 | Validates attendee membership, updates response_status. |
| 4.3a | `GET /availability/:userId` | P5 | Working hours minus busy events minus external events. Org membership check. |
| 4.3b | `GET /availability/team` | P5 | Multi-user availability, org-scoped filtering. |
| 4.3c | `GET /working-hours` | P5 | Returns current user's working hours. |
| 4.3d | `PUT /working-hours` | P5 | Full replacement semantics. |
| 4.4a | `GET /booking-pages` | P5 | Lists user's booking pages. |
| 4.4b | `POST /booking-pages` | P5 | Slug uniqueness check, all fields. |
| 4.4c | `PATCH /booking-pages/:id` | P5 | Partial update with enable/disable. |
| 4.4d | `DELETE /booking-pages/:id` | P5 | Hard delete. |
| 4.5a | `GET /meet/:slug` | P5 | Returns public page info with owner name/avatar. No auth. |
| 4.5b | `GET /meet/:slug/slots` | P4 | Computes slots from availability with buffer logic. Does not enforce `min_notice_hours` or `max_advance_days`. |
| 4.5c | `POST /meet/:slug/book` | P4 | Creates event on owner's default calendar. Uses transaction with row-level locking to prevent double-booking. Does NOT auto-create Bond contact or Bam task even when flags are set. |
| 4.6a | `GET /connections` | P4 | Lists connections but does not redact access_token in response. |
| 4.6b | `POST /connections/google` | P2 | Accepts raw tokens. No OAuth flow (comment says "simplified"). |
| 4.6c | `POST /connections/microsoft` | P2 | Same as Google -- no OAuth flow. |
| 4.6d | `DELETE /connections/:id` | P5 | Deletes connection, user-scoped. |
| 4.6e | `POST /connections/:id/sync` | P2 | Placeholder -- updates timestamp but does not actually sync. Comment: "real impl would enqueue BullMQ job". |
| 4.7 | `GET /timeline` | P3 | Returns Book events only. Cross-product aggregation (Bam tasks, sprints, Bearing goals, Bond deals, Blast campaigns) is commented as placeholder. |
| 4.8 | `GET /calendars/:id/ical` | P5 | Full iCal feed generation with VCALENDAR/VEVENT, token-based auth, 90d-365d range. Also has POST to generate token. |

### 5. MCP Tools (Section 5)

| # | Tool | Rating | Notes |
|---|------|--------|-------|
| 5.1 | `book_list_events` | P5 | Proxies to API with query params. |
| 5.2 | `book_create_event` | P5 | Supports attendees. |
| 5.3 | `book_update_event` | P5 | Partial update. |
| 5.4 | `book_cancel_event` | P5 | Calls DELETE (soft-cancel). |
| 5.5 | `book_get_availability` | P5 | Single user availability. |
| 5.6 | `book_get_team_availability` | P5 | Multi-user. |
| 5.7 | `book_find_meeting_time` | P4 | Client-side slot intersection algorithm. Returns up to 3 suggestions. Does not use a dedicated server endpoint -- computes in MCP tool. Functional but not as robust as a server-side implementation. |
| 5.8 | `book_create_booking_page` | P5 | Proxies to API. |
| 5.9 | `book_get_timeline` | P4 | Works but inherits the timeline limitation (Book events only). |
| 5.10 | `book_rsvp_event` | P5 | Proxies RSVP to API. |

### 6. Frontend (Section 6)

| # | Feature | Rating | Notes |
|---|---------|--------|-------|
| 6.1a | Route: `/book` (week view default) | P5 | Week view renders as default. |
| 6.1b | Route: `/book/day/:date` | P5 | Day view with date parameter. |
| 6.1c | Route: `/book/month/:month` | P5 | Month view with month parameter. |
| 6.1d | Route: `/book/timeline` | P4 | Gantt-style horizontal timeline. Shows legend for Bam/Bearing/Bond but only renders Book events. |
| 6.1e | Route: `/book/events/:id` | P5 | Event detail with attendees, booking info, cancel action. |
| 6.1f | Route: `/book/booking-pages` | P5 | List with enable/disable status, edit/delete actions. |
| 6.1g | Route: `/book/booking-pages/:id/edit` | P3 | Create-only form. Does not load existing booking page data for editing. Only `useCreateBookingPage` is used; no fetch + populate for existing pages. Missing fields: max_advance_days, min_notice_hours, confirmation_message, redirect_url, auto_create_bond_contact, auto_create_bam_task, bam_project_id, logo_url. |
| 6.1h | Route: `/book/settings/working-hours` | P5 | Full 7-day form with enable/disable per day, time pickers, save. |
| 6.1i | Route: `/book/settings/connections` | P2 | Static placeholder UI. Connect buttons are disabled. Does not call any API. Hardcoded empty connections array. |
| 6.2a | Week view: 7-column grid with hourly rows | P5 | Implemented with time gutter, event positioning by hour/minute. |
| 6.2b | Week view: overlapping events side-by-side | P3 | Events are positioned absolutely but no overlap detection/layout. Overlapping events stack on top of each other. |
| 6.2c | Day view: single column, hourly detail | P5 | Implemented. |
| 6.2d | Day view: external calendar events as translucent blocks | P0 | Not implemented. External events are not fetched or rendered. |
| 6.2e | Month view: date grid with event dots | P5 | Shows up to 3 events per day with "+N more" overflow. |
| 6.2f | Aggregated items on calendar views | P0 | Bam due dates, sprint boundaries, Bearing deadlines, Bond close dates are not rendered on any calendar view. |
| 6.3 | Booking page public UI | P1 | API endpoints exist (GET /meet/:slug, GET /meet/:slug/slots, POST /meet/:slug/book) but there is no public-facing frontend component. The design calls for a clean single-purpose page with date picker, slot picker, booking form, and confirmation. |
| 6.x | Event creation form/modal | P0 | "New Event" buttons exist on calendar views but navigate to `/events/new` which falls through to the week view (no create form exists). |

### 7. Bolt Integration Events (Section 7)

| # | Feature | Rating | Notes |
|---|---------|--------|-------|
| 7.1 | `book.event.created` | P0 | No event emission anywhere in the codebase. |
| 7.2 | `book.event.updated` | P0 | Same. |
| 7.3 | `book.event.cancelled` | P0 | Same. |
| 7.4 | `book.event.rsvp` | P0 | Same. |
| 7.5 | `book.booking.created` | P0 | Same. |

### 8. Cross-Product Integration (Section 8)

| # | Feature | Rating | Notes |
|---|---------|--------|-------|
| 8.1 | Bam task due dates on calendar | P0 | Not implemented. |
| 8.1b | Sprint boundaries on calendar | P0 | Not implemented. |
| 8.1c | Auto-create Bam task on booking | P1 | Flag exists in schema and API but `bookSlot()` does not trigger task creation. |
| 8.2a | Bond deal close dates on timeline | P0 | Timeline is Book-only. |
| 8.2b | Auto-create Bond contact on booking | P1 | Flag exists in schema/API but `bookSlot()` does not create contacts. |
| 8.3 | Banter integration (huddle links, reminders) | P0 | Not implemented. |
| 8.4 | Bearing goal deadlines on timeline | P0 | Not implemented. |

### 9. Permissions (Section 9)

| # | Feature | Rating | Notes |
|---|---------|--------|-------|
| 9.1 | Role-based access (admin/manager/member/viewer) | P4 | Auth plugin implements role hierarchy with requireMinRole. Calendar deletion requires admin. Event creation requires member + read_write scope. Viewer restrictions for event details ("titles only") NOT implemented. |
| 9.2 | SuperUser bypass | P5 | SuperUser check in role guard. |

### Infrastructure & Architecture (Section 2)

| # | Feature | Rating | Notes |
|---|---------|--------|-------|
| 2.1 | Monorepo placement | P5 | `apps/book-api/` and `apps/book/` exist as expected. |
| 2.2a | Fastify server with health checks | P5 | `/health` and `/health/ready` with DB + Redis checks. |
| 2.2b | Redis plugin | P5 | Registered in server. |
| 2.2c | Rate limiting | P5 | Global rate limit + per-route overrides (event creation, public booking). |
| 2.2d | Error response envelope | P5 | Matches suite standard with code, message, details, request_id. |
| 2.2e | Security headers | P5 | X-Content-Type-Options, X-Frame-Options, Cache-Control. |
| 2.2f | CORS | P5 | Configured from env. |
| 2.3 | External calendar sync engine (BullMQ) | P1 | No BullMQ integration. Force sync is a no-op placeholder. No polling worker. |
| 2.4 | nginx routing `/meet/` | P3 | Public booking routes exist at `/meet/:slug` but no nginx config was audited (out of scope for code audit, but the API routes are correctly registered without the `/v1` prefix). |
| 2.5 | Redis availability cache | P2 | Redis plugin exists but availability calculation does not use Redis caching or invalidation. All availability is computed live from DB. |

---

## Detailed Findings (P0-P3)

### P0: Not Implemented

**1. Event Creation Form (Frontend)**
The "New Event" button on all calendar views navigates to `/events/new`, but the router does not have a dedicated create-event page or modal. The route falls through to the default week view. Users cannot create events through the UI.
- **Files:** `apps/book/src/app.tsx` (line 57 -- no route for "new"), `apps/book/src/pages/calendar-week.tsx` (line 53 -- button targets `/events/new`)
- **Impact:** Critical -- users cannot create events at all through the frontend.

**2. Cross-Product Calendar Overlays**
The design specifies Bam task due dates (triangular markers), sprint boundaries (horizontal bars), Bearing goal deadlines (diamond markers), and Bond deal close dates (circle markers) as read-only overlays on calendar views. None of these are implemented. The timeline view shows a legend for these item types but renders only Book events.
- **Files:** `apps/book-api/src/services/timeline.service.ts` (lines 57-59 -- commented placeholder), `apps/book/src/pages/timeline.tsx` (lines 123-140 -- legend only)
- **Impact:** High -- this is described as the "killer feature" in section 1.2.

**3. Bolt Event Integration**
No Bolt events (`book.event.created`, `book.event.updated`, `book.event.cancelled`, `book.event.rsvp`, `book.booking.created`) are emitted from any service. No event bus integration exists.
- **Impact:** Medium -- Bolt workflows cannot react to Book events.

**4. External Calendar Events on Day View**
Design specifies external calendar events shown as "translucent blocks" on the day view. Not implemented.

### P1: Barely Started

**1. Booking Page Public UI**
The backend endpoints exist and work (GET page info, GET slots, POST book), but there is no public-facing HTML/React page. The design describes a clean branded page with date picker, time slot picker, booking form, and confirmation screen. A visitor to `/meet/:slug` would receive raw JSON, not a usable UI.

**2. External Calendar Sync Engine**
The data model and connection CRUD routes exist, but:
- No OAuth flow (routes accept raw tokens)
- No BullMQ worker for periodic polling
- Force sync updates a timestamp but does not fetch/push events
- No Redis lock management for sync races

### P2: Skeleton Only

**1. Connections Page (Frontend)**
The `connections.tsx` page renders a static UI with disabled "Connect" buttons and a hardcoded empty array. It does not call the `/v1/connections` API. No OAuth redirect flow is wired.

**2. Redis Availability Cache**
The design describes Redis-cached availability with invalidation on event create/update. The Redis plugin is registered but the availability service queries the DB directly every time.

### P3: Partially Implemented

**1. Booking Page Editor**
The editor page works for creating new booking pages but cannot edit existing ones. When navigating to `/booking-pages/:id/edit` with a real ID, the form renders blank (no data fetch). Missing fields compared to design: max_advance_days, min_notice_hours, confirmation_message, redirect_url, auto_create_bond_contact, auto_create_bam_task, bam_project_id, logo_url.

**2. Public Slot Availability**
`getPublicSlots()` computes slots from owner availability and applies buffer/duration logic, but does not enforce `min_notice_hours` (could return slots within the minimum notice window) or `max_advance_days` (could return slots beyond the maximum advance booking window).

**3. Timeline Aggregation (API)**
The endpoint exists and returns Book events, but the cross-product aggregation (Bam, Bond, Bearing, Blast) is a commented-out placeholder.

**4. Week View Overlap Handling**
Events are positioned by absolute CSS offsets but there is no overlap detection. If two events occupy the same time slot, they render on top of each other instead of side-by-side as the design specifies.

**5. Auto-Create on Booking**
The `bookSlot()` service does not honor `auto_create_bond_contact` or `auto_create_bam_task` flags. The schema and API support storing these preferences, but the booking flow ignores them.

---

## P4-P5 Summary (Implemented Well)

The following areas are solidly implemented:

- **All 7 Drizzle schema tables** match the design SQL exactly (P5)
- **Calendar CRUD** (list, create, update, delete) with org-scoping and default-calendar protection (P5)
- **Event CRUD** (list, create, get, update, soft-delete) with attendee management and pagination (P5)
- **RSVP** with attendee membership validation (P5)
- **Availability calculation** correctly subtracts Book events and external events from working hours (P5)
- **Team availability** with org-scoped user filtering (P5)
- **Working hours** CRUD with 7-day form (P5)
- **Booking page CRUD** with slug uniqueness (P5)
- **Public booking** with double-booking prevention via row-level locking (P4)
- **iCal feed** with token generation and VCALENDAR output (P5)
- **All 10 MCP tools** implemented and functional (P4-P5)
- **Auth system** with session cookies, API keys (Argon2id), multi-org support, role/scope guards (P5)
- **Frontend layout** with sidebar, breadcrumbs, launchpad integration, dark mode (P5)
- **Week/Day/Month calendar views** with event rendering and navigation (P5)
- **Event detail page** with attendees, booking info, status badges (P5)
- **Booking page list** with enable/disable status display (P5)

---

## Recommendations

### Priority 1 (Blocking)
1. **Build event creation form/modal.** Without this, the calendar is read-only through the UI. A slide-over modal with title, start/end datetime pickers, calendar selector, and optional attendee input would unblock basic usage.
2. **Implement cross-product timeline aggregation.** This is the stated killer feature. Add internal HTTP calls from book-api to bam-api, bearing-api, bond-api, and blast-api to fetch time-based items, or use direct DB queries since they share the same PostgreSQL instance.

### Priority 2 (Important)
3. **Fix booking page editor** to load existing page data and support all fields (especially integration flags).
4. **Emit Bolt events** from event.service and booking-page.service for `book.event.created`, `book.event.cancelled`, `book.booking.created`, etc.
5. **Enforce `min_notice_hours` and `max_advance_days`** in `getPublicSlots()`.
6. **Build public booking page UI** (separate lightweight React app or server-rendered HTML for `/meet/:slug`).
7. **Implement auto-create Bond contact / Bam task** in `bookSlot()` when the flags are enabled.

### Priority 3 (Enhancement)
8. **Add overlap detection** to week view event rendering (calculate columns for concurrent events).
9. **Wire connections page** to actual API calls and add OAuth redirect flow.
10. **Add Redis availability caching** with invalidation on event mutations.
11. **Build BullMQ sync worker** for external calendar polling.
12. **Add external calendar events** as translucent blocks on day view.

---

*Generated by automated audit on 2026-04-09.*
