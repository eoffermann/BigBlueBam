# Book help.md - Review

## Verdict: APPROVED

The help doc at `docs/apps/book/help.md` is accurate, complete, and conventions-clean.
Every claim spot-checked traced to code. All four required "do not present as
working" guards are honored, and the three not-yet-available features
(reminders, recurrence expansion, OAuth/external sync) are each flagged as
unavailable. No changes required.

---

## Acceptance checklist

### Template completeness - PASS
- Overview (with Key concepts and Where to find it), Feature reference,
  User Stories, and Related sections all present and filled.
- Key concepts cover every core noun (Calendar, Event, Visibility/Show as,
  Attendee, RSVP, Working hours, Availability slot, Booking page, Booking,
  Timeline, External connection, iCal feed).

### Feature coverage - PASS
Every frontend view/action has how-to steps. Verified each against code:
- Sidebar labels exact (`book-sidebar.tsx`): Week, Day, Month, Timeline,
  Booking Pages; "Book Settings" header; Calendars, Working Hours, Connections.
- Week / Day / Month / Timeline views, New/Edit Event, Event detail + RSVP,
  Booking Pages list, Booking page editor, Public Meet page, Calendars,
  Working Hours, Connections, iCal feed, In-app Help - all documented.
- New Event form fields and option labels match `event-form.tsx`:
  Repeat (No repeat / Daily / Weekly / Every 2 weeks / Monthly), Show as
  (Busy / Free / Tentative / Out of Office), validation strings
  ("Title is required", "Select a calendar", "End must be after start").
- Event detail labels match `event-detail.tsx`: "Your response",
  Accept / Maybe / Decline, "Attendees (N)", "(organizer)",
  "Booked via scheduling link", "Cancel this event?".
- Working Hours: Mon-Fri 09:00-17:00 default, "Unavailable",
  "Save Working Hours" - all match `working-hours.tsx`.

### Story coverage - PASS
- Setup: "Set your working hours".
- Core loop: "Schedule a one-off meeting", "View and adjust an event",
  "Cancel an event".
- Collaboration: "RSVP to an invitation", "Manage multiple calendars",
  "Create a public booking page".
- Search/reporting: "See everything happening this week across apps" (Timeline).
- Agent flow: "Find a common meeting time across several people (agent-driven)"
  plus the iCal subscribe story (API/agent-only). Steps are followable.

### Accuracy - PASS
Spot-checked labels and feature claims; all trace to code:
- 11 MCP tools enumerated in the doc exactly match the 11 registered in
  `apps/mcp-server/src/tools/book-tools.ts` (book_list_events, book_create_event,
  book_update_event, book_cancel_event, book_get_availability,
  book_get_team_availability, book_find_meeting_time, book_create_booking_page,
  book_get_timeline, book_rsvp_event, book_find_meeting_time_for_users).
- `book_get_team_availability` minimum-two is code-backed (`.min(2)`, line 293).
- `book_find_meeting_time` "up to three suggestions" is code-backed
  (`.slice(0, 3)`, line 357; description "Returns up to 3 suggested slots").
- `book_find_meeting_time_for_users` "agents/service accounts always available
  while respecting human working hours" matches the tool description (line 429).
- 5 Bolt events (event.created, event.updated, event.cancelled, event.rsvp,
  booking.created), all source `book`, match `event-catalog.ts`
  (lines 1656, 1683, 1710, 2084, 2095).
- iCal window "-90 days to +365 days" matches `ical.service.ts:57-58`.
- Calendar/Timeline click-to-edit navigation matches
  `calendar-week.tsx:120` and `timeline.tsx:119` (both route to /events/:id/edit).

### Required "broken / unavailable" guards - ALL HONORED
1. On-booking Bond hook (BROKEN): documented as a confirmed live bug at help.md
   lines 188, 253, 434. Code-confirmed: `public-booking.routes.ts:94-111` POSTs
   to Bond `/v1/contacts` with only `x-internal-secret`, while
   `bond-api/.../contacts.routes.ts:111-116` requires requireAuth +
   requireCan(bond.contact.create) + requireScope(read_write) and has no
   internal-secret ingress, so every call 401s and is swallowed. NOT presented
   as working.
2. Public Meet page (BROKEN): documented as non-functional at lines 186, 377.
   Code-confirmed: `booking-page.service.ts:227-230` returns slots as
   `{ start, end }` while `meet.tsx:57,194,245` reads `s.start_at`/`s.end_at`,
   so selectedSlot is undefined and the posted start_at is empty. NOT presented
   as working.
3. Booking-page editor edit mode (BROKEN): documented as unavailable at lines
   179, 377. Code-confirmed: `use-booking-pages.ts:39` calls
   GET `/v1/booking-pages/:id`, which `booking-pages.routes.ts` does not define
   (only list/create/patch/delete exist), so edit never populates. NOT presented
   as working.
4. Reminders: documented as inactive/nonexistent (lines 127, 251). Code-confirmed:
   `event-form.tsx:116-126` submit payload omits reminder and color; no reminder
   column or worker job.
5. Recurrence: documented as stored-but-not-expanded (lines 129, 251). Accurate.
6. OAuth / external sync: documented as not implemented (lines 27, 220-227, 251).
   Code-confirmed: `connections.tsx` has both Connect buttons `disabled`,
   hardcoded-empty connections array, never calls the API.

### Conventions - PASS
- No em dashes or en dashes (ripgrep scan of help.md: no matches).
- Counts plausible and code-backed: 11 MCP tools (verified), 5 Bolt events
  (verified), 6 screenshots referenced.
- All 6 referenced screenshots exist under
  `docs/apps/book/screenshots/{light,dark}/`: 01-week-view, 02-month-view,
  03-day-view, 04-timeline, 05-booking-pages, 06-working-hours (both themes).

---

## Accuracy findings

No inaccuracies found. Every label and feature claim spot-checked traced to a
route, component, or MCP tool. The "Booking pages coming soon" banner is
correctly described as stale (the banner text in the doc matches
`booking-page-list.tsx:40-41` verbatim, and the doc correctly tells readers to
ignore it because CRUD + the booking object are shipped).

## Fix list

None. Verdict is APPROVED.
