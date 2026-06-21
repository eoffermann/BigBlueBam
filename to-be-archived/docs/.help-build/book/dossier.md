# Book — Dossier

Research dossier for the BigBlueBam **Book** app (scheduling & events). Compiled from
code under `apps/book-api/src`, `apps/book/src`, `apps/mcp-server/src/tools/book-tools.ts`,
and docs under `docs/apps/book`. Every claim cites a file path. Where docs/marketing
disagree with code, that is flagged under Discrepancies.

---

## 1. App identity

- **App key:** `book`
- **Display name:** Book (subtitle in code: "Book Scheduling & Calendar" / "Book — Scheduling & Calendar")
  (`apps/book/src/app.tsx:149`, `docs/apps/book/_narrative.md:1`)
- **Category:** Scheduling & events
- **SPA path:** `/book/` (nginx-served React SPA) — `apps/book/src/app.tsx:35` `BASE_PATH = '/book'`
- **API path:** `/book/api/` → proxies to book-api internal `:4012` (CLAUDE.md routing table)
- **Public booking path:** `/book/api/meet/:slug` (no `/v1` prefix) — `apps/book-api/src/server.ts:108`,
  `apps/book-api/src/lib/urls.ts:24`
- **Auth model:** session cookie or API key via shared `requireAuth` (`apps/book-api/src/plugins/auth.ts`);
  the SPA itself has no login screen — unauthenticated users see a "Please log in to BigBlueBam first"
  panel linking to `/b3/` (`apps/book/src/app.tsx:145-157`).
- **Prerequisites:** a BigBlueBam account/session (login happens in the Bam app at `/b3/`). A default
  personal calendar is auto-provisioned on first calendar read (`apps/book-api/src/services/calendar.service.ts:59-76`),
  so users are never stranded without a calendar.
- **Per-action permissions:** book-api enforces `fastify.requireCan('book.<resource>.<action>')` on every
  write route via the shared HTTP permissions plugin (`apps/book-api/src/plugins/permissions.ts`). Action
  keys used: `book.event.create/update/delete`, `book.calendar.create/update/delete`,
  `book.booking_page.create/update/delete`.
- **Scopes:** writes additionally require `requireScope('read_write')` (hierarchy `read < read_write < admin`,
  `apps/book-api/src/plugins/auth.ts:278-279`).

---

## 2. Key concepts and vocabulary

- **Calendar** (`book_calendars`) — a container for events. Has `calendar_type`
  (`personal` | `team` | `project` | `booking` | `bureau`), `color`, `timezone`, `is_default`, optional
  `project_id`. One personal `My Calendar` is auto-created per user on first read; the default calendar
  cannot be deleted (`apps/book-api/src/db/schema/book-calendars.ts`, `calendar.service.ts:146-159`).
  `bureau` calendars are auto-provisioned per org for Bureau room reservations
  (`apps/book-api/src/routes/internal.routes.ts:149-184`).
- **Event** (`book_events`) — a time block on a calendar. Fields: title, description, location,
  `meeting_url`, `livekit_room_name`, start/end, `all_day`, timezone, recurrence, status, visibility,
  `linked_entity_type`/`linked_entity_id`, booking-page linkage, `booked_by_name`/`booked_by_email`
  (`apps/book-api/src/db/schema/book-events.ts`).
  - **status enum:** `tentative` | `confirmed` | `cancelled` (default `confirmed`). Delete is a soft-cancel
    that flips status to `cancelled` (`event.service.ts:232-244`).
  - **visibility enum:** `free` | `busy` | `tentative` | `out_of_office` (default `busy`). `free` events do
    not block availability (`availability.service.ts:66`).
  - **recurrence_rule enum (input):** `daily` | `weekly` | `biweekly` | `monthly`
    (`events.routes.ts:18`). NOTE: recurrence is stored only; no expansion engine generates child
    occurrences (see Discrepancies).
  - **linked_entity_type enum:** `bam_task` | `bond_deal` | `helpdesk_ticket` (`events.routes.ts:22`).
- **Attendee** (`book_event_attendees`) — email (required), optional user_id/name, `is_organizer`,
  `response_status` (`needs_action` default; RSVP sets `accepted` | `declined` | `tentative`)
  (`apps/book-api/src/db/schema/book-event-attendees.ts`, `events.routes.ts:49-51`).
- **RSVP** — an attendee's response to an event; only an existing attendee (matched by `user_id`) can RSVP
  (`event.service.ts:250-279`).
- **Booking page** (`book_booking_pages`) — a public scheduling link at `/meet/:slug`. Carries
  `duration_minutes` (default 30), `buffer_before_min` (default 0), `buffer_after_min` (default 15),
  `max_advance_days` (default 60), `min_notice_hours` (default 4), brand `color`, `logo_url`,
  `confirmation_message`, `redirect_url`, `enabled`, and the cross-app flags
  `auto_create_bond_contact` (default **true**), `auto_create_bam_task` (default false), `bam_project_id`
  (`apps/book-api/src/db/schema/book-booking-pages.ts`). Slug is unique per org and matches `^[a-z0-9-]+$`
  (`booking-pages.routes.ts:7`, `booking-page.service.ts:79-91`).
- **Booking** — a public visitor booking a slot; produces a confirmed `book_events` row on the page owner's
  default calendar, with `booking_page_id`, `booked_by_name`, `booked_by_email` set
  (`booking-page.service.ts:242-320`).
- **Working hours** (`book_working_hours`) — per-user weekly availability windows; one row per
  `(user_id, day_of_week 0=Sun..6=Sat)` with `start_time`/`end_time`/`timezone`/`enabled`. PUT is a full
  replacement (`availability.service.ts:360-384`, `book-working-hours.ts`).
- **Availability slot** — a computed `{ start, end }` free interval = working hours minus busy events
  (status != cancelled, visibility != free) minus busy external events
  (`availability.service.ts:31-133`).
- **Team availability** — per-user availability map for a list of user_ids (`getTeamAvailability`).
- **Mixed-roster meeting time** — intersection of human availability where agents/service accounts are
  treated as unconditionally available (`availability.service.ts:239-323`, AGENTIC §18 Wave 5).
- **Timeline** — aggregated cross-app view: Book events + Bam tasks (by due date) + Bond deals (by expected
  close date) in a date range (`timeline.service.ts`).
- **External connection** (`book_external_connections`) — stored Google/Microsoft OAuth tokens for calendar
  sync. `sync_direction` `inbound` | `outbound` | `both`; `provider` `google` | `microsoft`. Backend
  exists but sync is a placeholder (`external-sync.service.ts`, see Discrepancies).
- **iCal feed token** (`book_ical_tokens`) — a 48-char nanoid that authenticates a public `.ics` feed for
  one calendar (`ical.service.ts`).
- **LiveKit huddle room** — every Book-native event without an external `meeting_url` gets
  `huddle-book-{eventId}` and the event deep link as its join URL; Bureau reservations get
  `bureau-room-{roomId}` (`event.service.ts:14-16`, `book-events.ts:28-35`).

---

## 3. Feature inventory

### Navigation (sidebar) — apps/book/src/components/layout/book-sidebar.tsx

Top group (labels exact): **Week**, **Day**, **Month**, **Timeline**, **Booking Pages**.
Group header **"Book Settings"** then: **Calendars**, **Working Hours**, **Connections**.
Header chrome (book-layout.tsx): Launchpad trigger, breadcrumbs, **OrgSwitcher**, **NotificationsBell**,
**UserMenu**. Keyboard ? opens in-app Help (app.tsx:119-130).

Routes (client-side, app.tsx:44-78): / (Week), /day, /day/:YYYY-MM-DD, /month,
/month/:YYYY-MM, /timeline, /events/new, /events/:id, /events/:id/edit, /booking-pages,
/booking-pages/:id/edit (and /booking-pages/new/edit), /settings/calendars,
/settings/working-hours, /settings/connections, /meet/:slug (public, no auth), /help.

---

### F1. Week view  (apps/book/src/pages/calendar-week.tsx)
- **UI location:** sidebar **Week** (default landing). Breadcrumb "Week View".
- **Labels/actions:** date-range heading "MMM d - MMM d, yyyy"; prev / **Today** / next nav buttons;
  **New Event** button (top-right, Plus icon).
- **Behavior:** 8-column grid (time gutter + 7 days), 24 hour rows; event blocks positioned by start/end.
  Clicking an event block navigates to /events/:id/edit (NOT the detail page — see Discrepancies).
- **Backing route:** GET /book/api/v1/events?start_after&start_before (use-events.ts:50-62,
  events.routes.ts:64-81).

### F2. Day view  (apps/book/src/pages/calendar-day.tsx)
- **UI location:** sidebar **Day**. Breadcrumb "Day View".
- **Labels/actions:** heading "EEEE, MMMM d, yyyy"; prev / **Today** / next; **New Event**.
- **Backing route:** GET /v1/events scoped to the single day.

### F3. Month view  (apps/book/src/pages/calendar-month.tsx)
- **UI location:** sidebar **Month**. Breadcrumb "Month View".
- **Labels/actions:** heading "MMMM yyyy"; nav; **New Event**; day-cell grid with event chips.
- **Backing route:** GET /v1/events scoped to the visible month grid.

### F4. Timeline  (apps/book/src/pages/timeline.tsx)
- **UI location:** sidebar **Timeline**. Breadcrumb "Timeline".
- **Labels/actions:** heading "Timeline: MMM d - MMM d, yyyy"; prev / **This Week** / next; per-day
  grouped items with source badges; legend "Book Events / Bam Tasks / Bond Deals".
- **Behavior:** aggregates Book events (blue), Bam tasks (orange/amber), Bond deals (teal). Clicking a Book
  item navigates to /events/:id/edit.
- **Backing route:** GET /book/api/v1/timeline?start_after&start_before then timeline.service.ts, which
  fans out to Bam GET /tasks and Bond GET /v1/deals over internal HTTP.
- **KNOWN MISMATCH:** the frontend reads item.date / item.end_date / item.source (book|bam|bond)
  and item.url, but the service returns start_at/end_at and source values book|bam_task|bond_deal
  with no url field (timeline.service.ts:10-18, 70-141). See Discrepancies.

### F5. New / Edit Event  (apps/book/src/pages/event-form.tsx)
- **UI location:** **New Event** button (any calendar view) gives /events/new; or **Edit** on an event.
  Headings "New Event" / "Edit Event". Back link "Back to Calendar" / "Back to Event".
- **Exact field labels:** **Title (required)** (placeholder "Team standup"), **Calendar (required)**,
  **All day** (toggle), **Start** / **End** (or "Start Date"/"End Date" when all-day), **Description**
  (placeholder "Add details, agenda, or notes..."), **Location** (placeholder "Conference room, address,
  or video URL"), **Repeat** (No repeat / Daily / Weekly / Every 2 weeks / Monthly), **Show as**
  (Busy / Free / Tentative / Out of Office), **Reminder** (At time of event ... 1 day before), **Color**.
- **Primary actions:** **Create Event** / **Update Event** (submit, Save icon), **Cancel**.
- **Backing routes:** POST /v1/events (create) / PATCH /v1/events/:id (update)
  (use-events.ts:72-104, events.routes.ts:84-170).
- **Validation surfaced to user:** "Title is required", "Select a calendar", "End must be after start".
- **DEAD UI:** **Reminder** and **Color** are collected in form state but never sent in the submit
  payload (event-form.tsx:116-126); the API has no reminder concept and color lives on the calendar,
  not the event. Attendees cannot be added/edited from this form at all.

### F6. Event detail  (apps/book/src/pages/event-detail.tsx)
- **UI location:** /events/:id. Breadcrumbs "Calendar > Event".
- **Labels/actions:** status pill + visibility label; **Edit** (to edit form) and **Cancel** (Trash2,
  confirm "Cancel this event?" then soft-delete). Details card shows time/timezone, **Location**,
  meeting URL link, description. **Your response** RSVP panel (only if current user is an attendee) with
  **Accept** / **Maybe** / **Decline** buttons. **Attendees (N)** list with response-status and
  "(organizer)" tag. Amber "Booked via scheduling link" panel when booked_by_email is set.
- **Backing routes:** GET /v1/events/:id (with attendees, event.service.ts:121-136);
  DELETE /v1/events/:id (soft-cancel); POST /v1/events/:id/rsvp with response_status accepted|declined|tentative.
- **NOTE:** "Maybe" maps to tentative. RSVP fails with "You are not an attendee of this event" if the
  user has no attendee row (event.service.ts:270).

### F7. Booking pages list  (apps/book/src/pages/booking-page-list.tsx)
- **UI location:** sidebar **Booking Pages**. Heading "Booking Pages", subtitle "Public scheduling links
  for clients and prospects".
- **Labels/actions:** **New Booking Page** button; **amber "Feature under development"** banner ("Booking
  pages are coming soon. We're integrating with Bond CRM to support lead capture and meeting scheduling.");
  per-page row shows title, **Active/Disabled** pill, /meet/{slug}, "{n} min", "Created {date}",
  description; **Edit** button and Trash2 delete (confirm "Delete this booking page?").
- **Backing routes:** GET /v1/booking-pages (owner-scoped list, booking-page.service.ts:40-53);
  DELETE /v1/booking-pages/:id.
- **Note:** list is filtered to owner_user_id = current user (booking-page.service.ts:46-49), so a user
  only ever sees their own pages.

### F8. Booking page editor  (apps/book/src/pages/booking-page-editor.tsx)
- **UI location:** **New Booking Page** or **Edit**. Headings "New Booking Page" / "Edit Booking Page".
  Back link "Back to Booking Pages".
- **Exact field labels:** **Title** (placeholder "30-Minute Intro Call"), **URL Slug** (prefix "/meet/",
  placeholder "intro-call"), **Description**, **Duration (min)**, **Buffer Before (min)**,
  **Buffer After (min)**, **Brand Color**.
- **Primary actions:** **Create** / **Update** (Save icon), **Cancel**.
- **Backing routes:** POST /v1/booking-pages (create) / PATCH /v1/booking-pages/:id (update).
- **BROKEN:** edit mode calls useBookingPage then GET /v1/booking-pages/:id, **which does not exist**
  (booking-pages.routes only defines GET-list, POST, PATCH, DELETE — booking-pages.routes.ts). Opening an
  existing page for edit will not populate (404) — see Discrepancies.
- **MISSING UI:** the editor does NOT expose auto_create_bond_contact, auto_create_bam_task,
  bam_project_id, max_advance_days, min_notice_hours, confirmation_message, redirect_url,
  logo_url, enabled — all of which exist in schema/API. Bond auto-create is therefore silently
  hardcoded-on by the DB default (docs/strategy/book-bond-booking-integration.md:18).

### F9. Public booking page (Meet)  (apps/book/src/pages/meet.tsx)
- **UI location:** /book/meet/:slug — bypasses auth (app.tsx:113-116).
- **Labels/actions:** page title + "with {owner}" + "{duration} min" + description; **"Pick a time"**
  section grouping slots by day; **"Your details"** with **Full name (required)**, **Email (required)**,
  **Notes (optional)**; submit button "Book {time}" / "Pick a time above"; confirmation screen
  "Booking confirmed" with the page confirmation message; "Booking unavailable" error screen.
- **Backing routes:** GET /book/api/meet/:slug (public page info), GET /book/api/meet/:slug/slots,
  POST /book/api/meet/:slug/book (public-booking.routes.ts).
- **KNOWN MISMATCH:** the slots endpoint returns { start, end } (booking-page.service.ts:202-236) but
  the page reads s.start_at / s.end_at (meet.tsx:57,139,245-258). Slot buttons render invalid times
  and the booked start_at is undefined. See Discrepancies.
- **Double-booking guard:** bookSlot uses a SELECT ... FOR UPDATE overlap check and returns 409 "This
  time slot is no longer available" (booking-page.service.ts:268-287).
- **On-booking cross-app side effects** (public-booking.routes.ts:84-132): emits Bolt booking.created;
  attempts a Bond contact create (auto_create_bond_contact !== false) and a Bam task create
  (auto_create_bam_task === true && bam_project_id). **The Bond contact create is a confirmed live bug**
  (see Agent flows + Discrepancies).

### F10. Calendars (settings)  (apps/book/src/pages/calendars.tsx)
- **UI location:** Book Settings then **Calendars**. Heading "Calendars", subtitle "Manage the calendars you
  use to organize events".
- **Labels/actions:** **New Calendar** button gives inline "New calendar" form (name + color preset swatches,
  **Create**/**Cancel**); per-calendar row shows name, **Default** pill, lowercased type, description;
  inline **Edit** (name + color), **Save**/**Cancel**, Trash2 delete (confirm
  "Delete calendar [name]?", blocked for default).
- **Backing routes:** GET /v1/calendars (auto-provisions default on first read),
  POST /v1/calendars, PATCH /v1/calendars/:id, DELETE /v1/calendars/:id (default protected with
  "Cannot delete default calendar"). (calendars.routes.ts, calendar.service.ts.)

### F11. Working hours (settings)  (apps/book/src/pages/working-hours.tsx)
- **UI location:** Book Settings then **Working Hours**. Heading "Working Hours", subtitle "Set your available
  hours for booking pages and availability calculations".
- **Labels/actions:** 7 rows (Sunday..Saturday), each a checkbox + start/end time inputs or
  "Unavailable"; Mon-Fri 09:00-17:00 enabled by default; **Save Working Hours** button.
- **Backing routes:** GET /v1/working-hours, PUT /v1/working-hours (full replacement; only enabled days
  are sent) (availability.routes.ts:114-133, availability.service.ts:360-384).

### F12. Connections (settings)  (apps/book/src/pages/connections.tsx)
- **UI location:** Book Settings then **Connections**. Heading "External Calendar Connections", subtitle
  "Connect Google Calendar or Microsoft Outlook for two-way sync".
- **Labels/actions:** **Google Calendar** and **Microsoft Outlook** cards each with a **Connect** button —
  **both buttons are disabled**; the connections array is hardcoded empty; the page never calls the API.
- **Backing routes (exist, UNWIRED from this page):** GET /v1/connections, POST /v1/connections/google,
  POST /v1/connections/microsoft, DELETE /v1/connections/:id, POST /v1/connections/:id/sync
  (connections.routes.ts). forceSync only stamps last_sync_at; no actual external pull/push exists
  (external-sync.service.ts:65-87). See Discrepancies.

### F13. iCal feed (backend only; no SPA UI)
- **Backing routes:** POST /v1/calendars/:id/ical (mints a 48-char token, org-checked),
  GET /v1/calendars/:id/ical?token=... (public, returns text/calendar, events from -90d to +365d)
  (ical.routes.ts, ical.service.ts).
- **NO FRONTEND:** there is no button anywhere in the SPA to generate or copy an iCal URL. Agent/API-only today.

### F14. In-app Help
- ? key or programmatic nav to /help renders the shared HelpViewer with appSlug="book" (app.tsx:159-161).

---

### Backend REST route map (book-api, mounted under /book/api)

All /v1/* unless noted. Auth = requireAuth (session cookie or API key) unless stated.

| Method | Path | Purpose | Notable request/response |
|---|---|---|---|
| GET | /v1/calendars | List calendars (own + team + project); auto-provisions default | ?calendar_type filter |
| POST | /v1/calendars | Create calendar | name(req), color #rrggbb, type, timezone, project_id; perm book.calendar.create |
| PATCH | /v1/calendars/:id | Update name/desc/color/timezone | perm book.calendar.update |
| DELETE | /v1/calendars/:id | Delete (blocks default) | perm book.calendar.delete; 400 Cannot delete default calendar |
| GET | /v1/events | List events in range | calendar_ids (CSV), start_after, start_before, status, limit<=500, offset |
| POST | /v1/events | Create event (+attendees) | rate-limited 30/min; perm book.event.create; emits Bolt event.created |
| GET | /v1/events/:id | Get event + attendees | returns attendees array |
| PATCH | /v1/events/:id | Update event | perm book.event.update; emits event.updated |
| DELETE | /v1/events/:id | Soft-cancel (status=cancelled) | perm book.event.delete; emits event.cancelled |
| POST | /v1/events/:id/rsvp | RSVP (attendee only) | response_status accepted/declined/tentative; emits event.rsvp |
| GET | /v1/availability/:userId | Free slots for one user (same-org check) | start_date, end_date; 404 if user not in org |
| GET | /v1/availability/team | Free slots for many users | user_ids (CSV), filtered to same org |
| POST | /v1/availability/meeting-time-mixed | Mixed human/agent meeting finder | user_ids[], duration_minutes 5-480, window, respect_working_hours_for_humans_only |
| GET | /v1/working-hours | Get caller weekly hours | |
| PUT | /v1/working-hours | Replace caller weekly hours | array of day_of_week 0-6, start_time, end_time, timezone?, enabled? |
| GET | /v1/booking-pages | List own booking pages | owner-scoped |
| POST | /v1/booking-pages | Create booking page | slug pattern a-z0-9-, title, durations/buffers, Bond/Bam flags; perm book.booking_page.create; 409 Slug already in use |
| PATCH | /v1/booking-pages/:id | Update (incl. enabled) | perm book.booking_page.update |
| DELETE | /v1/booking-pages/:id | Delete | perm book.booking_page.delete |
| GET | /meet/:slug | Public page info (no auth) | requires enabled=true |
| GET | /meet/:slug/slots | Public available slots (no auth) | start_date, end_date; returns data of {start,end} |
| POST | /meet/:slug/book | Public book a slot (no auth) | rate-limited 10/min; start_at, name, email, notes?; emits booking.created; triggers Bond/Bam hooks |
| GET | /v1/connections | List external connections | per-user |
| POST | /v1/connections/google | Store Google tokens | access_token, refresh_token?, external_calendar_id, sync_direction? |
| POST | /v1/connections/microsoft | Store Microsoft tokens | same shape |
| DELETE | /v1/connections/:id | Remove connection | |
| POST | /v1/connections/:id/sync | Force sync (stamps timestamp only) | placeholder |
| GET | /v1/timeline | Cross-app aggregated timeline | start_date, end_date; Book+Bam+Bond items |
| POST | /v1/calendars/:id/ical | Mint iCal feed token | org-checked |
| GET | /v1/calendars/:id/ical?token= | Public .ics feed (token auth) | text/calendar |
| POST | /v1/internal/events | Bureau-driven event create (internal secret) | X-Internal-Service-Secret; returns book_event_id + meeting_url |
| POST | /v1/internal/events/:id/cancel | Bureau-driven cancel (internal secret) | idempotent |
| GET | /v1/internal/events/:id | Internal event lookup (internal secret) | |

---

## 4. Candidate user stories

1. **Schedule a one-off meeting.** Open Book then a calendar view then **New Event** then fill Title,
   Calendar, Start/End, optional Location/Description/Repeat/Show-as then **Create Event**. (F1/F5,
   POST /v1/events.)
2. **Review and adjust an event.** Click an event (currently routes to the **edit form**, F5), change
   fields, **Update Event**. (Detail page F6 is reachable via /events/:id directly but the
   calendar/timeline link skips it.)
3. **Cancel an event.** Event detail then **Cancel** then confirm "Cancel this event?" then soft-cancel
   (status cancelled, hidden from availability/timeline). (F6, DELETE /v1/events/:id.)
4. **RSVP to an invite.** Open an event where you are an attendee then **Your response** then **Accept** /
   **Maybe** / **Decline**. (F6, POST /v1/events/:id/rsvp.)
5. **Set your working hours.** Settings then **Working Hours** then toggle days and set start/end then
   **Save Working Hours**. Drives availability + booking-page slots. (F11, PUT /v1/working-hours.)
6. **Create a public booking page.** Booking Pages then **New Booking Page** then Title, Slug, Duration,
   buffers, Brand Color then **Create** then share /meet/{slug}. (F7/F8, POST /v1/booking-pages.)
7. **External contact books time (public).** Visitor opens /book/meet/{slug} then **Pick a time** then
   enters **Full name** / **Email** / **Notes** then **Book {time}** then confirmation. Owner calendar
   gains a confirmed event; (intended) Bond contact + activity. (F9, POST /meet/:slug/book.)
8. **Find a common meeting time across people.** (Agent-driven today; no SPA UI.) Use availability/team or
   the mixed-roster finder. (MCP, section 5.)
9. **See everything happening this week across apps.** Sidebar **Timeline** then scan Book events, Bam task
   due dates, Bond deal close dates by day. (F4, GET /v1/timeline.)
10. **Manage multiple calendars.** Settings then **Calendars** then **New Calendar** / inline edit color &
    name / delete (non-default). (F10.)
11. **Subscribe to a calendar in an external app (iCal).** (API/agent-only.) Mint a token, hand the ?token=
    URL to Apple/Google Calendar. (F13.)
12. **Reserve a Bureau room and have it appear in Book.** (Cross-app, internal.) Bureau calls
    POST /v1/internal/events; event lands on the per-org "Bureau Bookings" calendar with a join URL.
    (Internal routes, section 3.)

---

## 5. Agent flows (MCP)

Tools registered in apps/mcp-server/src/tools/book-tools.ts (11 total; the generated docs reference lists
only 10 — see Discrepancies). All requests go to book-api with a Bearer service token; identifiers accept
fuzzy resolution (UUID, name, or email) via helper functions.

| # | Tool | Human feature it maps to | Backing call |
|---|---|---|---|
| 1 | book_list_events | Week/Day/Month/Timeline reads | GET /events |
| 2 | book_create_event | New Event (F5); resolves calendar_id by name, attendee user_id by email | POST /events |
| 3 | book_update_event | Edit Event (F5); resolves event by title | PATCH /events/:id |
| 4 | book_cancel_event | Cancel event (F6); resolves by title | DELETE /events/:id |
| 5 | book_get_availability | (no direct SPA UI) one-user free slots; resolves user by email | GET /availability/:id |
| 6 | book_get_team_availability | (no SPA UI) many-user free slots; min 2 | GET /availability/team |
| 7 | book_find_meeting_time | (no SPA UI) intersect team availability, returns up to 3 suggestions, computed in-tool | GET /availability/team |
| 8 | book_create_booking_page | New Booking Page (F8) | POST /booking-pages |
| 9 | book_get_timeline | Timeline (F4) | GET /timeline |
| 10 | book_rsvp_event | RSVP (F6); resolves event by title | POST /events/:id/rsvp |
| 11 | book_find_meeting_time_for_users | (no SPA UI) mixed human/agent roster finder (AGENTIC section 18) | POST /availability/meeting-time-mixed |

Bolt events Book publishes (registered in apps/bolt-api/src/services/event-catalog.ts:1654-2096, all
source=book): event.created, event.updated, event.cancelled, event.rsvp, booking.created. These are the
documented automation hooks (e.g., notify a Banter channel on a new booking).

**Cross-app on-booking hook (BROKEN — confirmed in current code).** On every public booking,
public-booking.routes.ts:94-111 POSTs to Bond POST /v1/contacts with only an x-internal-secret header and
no session/API-key bearer. Bond /v1/contacts requires requireAuth + requireCan(bond.contact.create) +
requireScope(read_write) and has NO internal-secret ingress at all
(apps/bond-api/src/routes/contacts.routes.ts:110-126, apps/bond-api/src/plugins/auth.ts). The call 401s on
every booking and the failure is swallowed (the fetch promise is caught and discarded), so no contact is
ever created and nothing is logged. The Bam-task hook (lines 113-132) is structurally identical but only
fires when auto_create_bam_task is explicitly enabled (default false). Additionally BOND_API_INTERNAL_URL is
read via an untyped cast and is not in book-api env schema (apps/book-api/src/env.ts) — it falls back to the
hardcoded http://bond-api:4009. Full analysis and the recommended fix (switch to /contacts/upsert via MCP
/tools/call, add the missing meeting activity log) are in docs/strategy/book-bond-booking-integration.md;
recorded as a live bug in docs/functionality-audits/2026-06-13-todo-batch.md:52.

**Bureau internal flow (working).** apps/book-api/src/routes/internal.routes.ts exposes secret-guarded
POST /v1/internal/events, /cancel, and GET /:id so Bureau room reservations become real Book events on a
per-org bureau calendar with a bureau-room-{roomId} LiveKit room and a /bureau/room/{id}/join meeting URL.

---

## 6. Screenshots available

All under docs/apps/book/screenshots/{light,dark}/ (identical set per theme), 1440x900, catalogued in
docs/apps/book/meta.json.

| File (light & dark) | meta.json label | Depicts | Illustrates |
|---|---|---|---|
| 01-week-view.png | Calendar week view | Week grid, **New Event** button, day columns | Story 1 (F1) |
| 02-month-view.png | Calendar month view | Month grid with event chips | Story 9 / F3 |
| 03-day-view.png | Calendar day view | Single-day hourly column | F2 |
| 04-timeline.png | Aggregated timeline | Per-day cross-app timeline + legend | Story 9 (F4) |
| 05-booking-pages.png | Booking page management | Booking Pages list with the amber "Feature under development" banner, a "30-Minute Intro Call with Eddie" Active row at /meet/eddie-intro, **New Booking Page** + **Edit** buttons | Story 6 (F7). NOTE: the screenshot itself shows the misleading "coming soon" banner. |
| 06-working-hours.png | Working hours settings | 7-day enable/time grid, **Save Working Hours** | Story 5 (F11) |

No screenshots exist for: Event form (F5), Event detail/RSVP (F6), Booking-page editor (F8), the public
/meet/:slug page (F9), Calendars (F10), or Connections (F12).

---

## 7. Discrepancies (docs/marketing vs. code)

1. **"Booking pages coming soon" banner is false.** booking-page-list.tsx:37-43 (and screenshot 05) show
   "Feature under development — Booking pages are coming soon." Booking-page CRUD and the public booking
   flow are fully shipped. Confirmed stale by docs/strategy/book-bond-booking-integration.md:7-12.
2. **On-booking Bond contact create is broken (live bug).** Guide (docs/apps/book/guide.md:24) says "Book
   booking pages can be linked from Bond contact records." In reality the auto-create-contact call 401s on
   every booking and is swallowed (see Agent flows). Status: documented, NOT yet fixed
   (2026-06-13-todo-batch.md:52).
3. **Public /meet slot field-shape mismatch.** getPublicSlots returns {start,end}; meet.tsx reads
   start_at/end_at. Slot times render invalid and start_at posted to /book is undefined — making the public
   booking page effectively non-functional in the SPA despite a working backend. (Not in any doc.)
4. **Timeline field-shape mismatch.** timeline.service.ts returns start_at/end_at and source
   book|bam_task|bond_deal with no url; timeline.tsx expects date/end_date/url and source book|bam|bond.
   Times do not render and Bam/Bond items fall back to a generic "Item" style. (Not in any doc.)
5. **Booking-page editor edit mode is broken.** useBookingPage calls GET /v1/booking-pages/:id, which has
   no backend route (only list/create/patch/delete exist). Editing an existing page will not populate.
6. **Editor hides real capabilities.** Schema/API support auto_create_bond_contact, auto_create_bam_task,
   bam_project_id, max_advance_days, min_notice_hours, confirmation_message, redirect_url, logo_url,
   enabled, but the editor exposes only title/slug/description/duration/buffers/color.
7. **Calendar/timeline click target.** Guide ("Event Detail with attendees...") implies a detail page, but
   Week/Month/Timeline event links navigate straight to /events/:id/edit, skipping the detail view
   (calendar-week.tsx:120, timeline.tsx:119). Detail (F6) is only reached via a direct /events/:id URL.
8. **Reminders are vaporware.** The event form offers a **Reminder** dropdown (down to "1 day before") and
   a **Color** picker, but neither is sent to the API, there is no reminder column on book_events, and
   there is no reminder/notification worker job for Book (apps/worker/src has no book handler).
9. **External calendar sync is a stub.** Guide/marketing (marketing.md:10, guide.md:19) tout "Calendar
   Connections via OAuth" and "two-way sync." The Connections page buttons are disabled and never call the
   API; forceSync only stamps last_sync_at; there is no OAuth flow and no sync engine. book_external_events
   is read by availability but nothing populates it.
10. **MCP tool count mismatch.** book-tools.ts registers 11 tools; the generated reference (guide.md,
    mcp-tools.md) lists only 10 — book_find_meeting_time_for_users is omitted.
11. **Recurrence is not expanded.** recurrence_rule/recurrence_end_at/recurrence_parent_id columns exist and
    the form offers Daily/Weekly/Every-2-weeks/Monthly, but no code generates recurring occurrences; a
    weekly event is a single row. Guide says "recurrence rules" without this caveat.
12. **Drag-to-create / drag-to-resize claimed but absent.** Guide/marketing say calendar views support
    "drag-to-create and drag-to-resize events" (guide.md:16, marketing.md:7). The calendar pages have no
    drag handlers; events are created only via the **New Event** form. Overstated.

---

## 8. Open questions

1. Are the meet.tsx / timeline.tsx field-shape mismatches (Disc. 3, 4) reproducing in production, or is
   there a build-time transform not visible in source? The code as written cannot work; needs a live check
   at /book/meet/<slug> and /book/timeline.
2. Is the booking-page editor edit flow exercised in practice? Given the missing GET /v1/booking-pages/:id
   route, are users only ever creating (never editing) pages, or is there an unmerged backend route?
3. Which Bond fix option (A/C from the strategy doc) is intended for the broken on-booking hook, and should
   auto_create_bond_contact become a visible per-page toggle vs. always-on?
4. iCal feed has no UI — is exposing a Subscribe / Copy-feed-URL button in Calendars planned, or is the feed
   intentionally API/agent-only?
5. Reminders: is a Book reminder/notification worker job planned (the form UI implies it), or should the
   Reminder dropdown be removed as dead UI?
6. External sync: is real Google/Microsoft OAuth + sync on the roadmap, or should the Connections page +
   marketing claims be downgraded to stored-credentials-only?
7. Team-availability / find-meeting-time has no human UI — only agents can reach it. Is a Find-a-time panel
   planned for the SPA?
8. book_create_booking_page declares a url field in its return shape but the create response has no url
   field (booking-page.service.ts returns the row). Does any agent flow depend on that non-existent field?
