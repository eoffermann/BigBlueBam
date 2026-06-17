# Book - Scheduling and calendar for your team

> Book is the BigBlueBam scheduling app. Use it to keep personal and team calendars, view what is happening across the suite on a timeline, set the working hours that drive availability, and publish public links that let outside people book time with you.

## Overview

Book gives every BigBlueBam user a calendar without any extra setup. The first time you open it, a personal calendar named **My Calendar** is created for you automatically, so you can start adding events right away. You can add more calendars later to separate work streams, projects, or teams.

Beyond plain events, Book computes availability. It takes the working hours you define, subtracts the events that mark you as busy, and produces free time slots. Those slots power two things: public booking pages, where someone outside your org can grab a slot on your calendar, and the availability tools that AI agents use to find a meeting time across several people.

Book also pulls other apps into one place. The Timeline view aggregates Book events with Bam task due dates and Bond deal close dates, so you can scan a week across the whole suite. Events can link to a Bam task, a Bond deal, or a Helpdesk ticket, and every Book-native event gets a LiveKit huddle room so attendees have a place to meet by video.

A few areas of Book are still being finished. Where a screen exists but does not yet do what its label implies, this document says so plainly under the relevant feature so you do not lose time on a path that cannot complete today. Two of these remain: external calendar connections (the Connections page) and reminders and recurrence. Read those notes before relying on connecting an outside calendar or on reminder and repeat behavior.

### Key concepts

- **Calendar** - A container for events. Each calendar has a type (`personal`, `team`, `project`, `booking`, or `bureau`), a color, and a timezone. One personal calendar, **My Calendar**, is created for you on first use and cannot be deleted. The `bureau` type is reserved for a system-provisioned, per-org calendar that other apps write room bookings into; you do not create it by hand.
- **Event** - A time block on a calendar with a title, start and end time, optional location, description, and meeting URL. Events have a status (`tentative`, `confirmed`, or `cancelled`; new events default to `confirmed`) and a visibility (`free`, `busy`, `tentative`, or `out_of_office`; default `busy`). Cancelling an event is a soft delete: it flips status to `cancelled` rather than erasing the row.
- **Show as (visibility)** - Controls whether an event blocks your availability. An event marked **Free** does not consume a slot; **Busy**, **Tentative**, and **Out of Office** do.
- **Attendee** - A person invited to an event, identified by email. Attendees carry a response status (`needs_action` until they answer, then `accepted`, `declined`, or `tentative`) and a flag for the organizer.
- **RSVP** - An attendee's response to an event. Only someone who is already an attendee can RSVP.
- **Working hours** - Your weekly availability windows, one row per day of the week. By default Monday to Friday, 09:00 to 17:00, are enabled. These windows are the raw material for availability and booking-page slots.
- **Availability slot** - A computed free interval, equal to your working hours minus the events that mark you busy.
- **Booking page** - A public scheduling link at `/book/meet/<slug>` that lets an outside visitor pick one of your free slots. It carries a duration, before and after buffers, advance and notice limits, and brand styling.
- **Booking** - The event created when a visitor books a slot on a booking page. It lands as a confirmed event on the page owner's default calendar.
- **Timeline** - A cross-app, date-ranged view that gathers Book events, Bam task due dates, and Bond deal close dates into one per-day list.
- **External connection** - A stored Google or Microsoft credential intended for two-way calendar sync. The backend records exist, but sync is not yet implemented (see Connections below).
- **iCal feed** - A token-authenticated `.ics` URL that exposes one calendar to an outside calendar app. Available through the API and agents only; there is no button for it in the app yet.

### Where to find it

Book is served at **`/book/`**. Reach it from the BigBlueBam Launchpad, or go to the path directly. Book does not have its own login screen. If you are not signed in, Book shows a "Please log in to BigBlueBam first to access Book." panel with a **Go to BigBlueBam Login** link to the main app at `/b3/`. Sign in there, then return to Book.

Prerequisites:

- A BigBlueBam account and an active session (sign in at `/b3/`).
- No calendar setup is required. Your personal **My Calendar** is provisioned the first time Book reads your calendars.
- Write actions (creating or editing events, calendars, and booking pages) require the `read_write` scope and the matching per-action permission (for example `book.event.create`). If a write is blocked, you lack the scope or permission for that resource.

Press **?** anywhere in Book (when you are not typing in a field) to open the in-app Help.

## Feature reference

The left sidebar has two groups. The top group holds the calendar and scheduling views: **Week**, **Day**, **Month**, **Timeline**, and **Booking Pages**. Below the **Book Settings** header sit **Calendars**, **Working Hours**, and **Connections**.

### Week view

The default landing screen. It shows a 7-day grid with a time gutter and 24 hour rows, with event blocks placed by their start and end times.

![Week view](screenshots/light/01-week-view.png)

To use the Week view:

1. Open Book. You land on **Week** by default, or click **Week** in the sidebar.
2. Read the date range heading at the top (for example "Jun 9 - Jun 15, 2026").
3. Move between weeks with the left and right chevron arrows, or click **Today** to jump back to the current week.
4. Click an event block to open it. Note that clicking a block opens the event's **edit** form, not its read-only detail view.
5. Click **New Event** (top right, with a plus icon) to create an event.

### Day view

A single day shown as one hourly column. Reached by **Day** in the sidebar.

To use the Day view:

1. Click **Day** in the sidebar.
2. Read the heading for the day shown.
3. Use the left and right chevron arrows to change day, or click **Today** to return to today.
4. Click **New Event** to add an event.

### Month view

A full-month grid of day cells with event chips.

![Month view](screenshots/light/02-month-view.png)

To use the Month view:

1. Click **Month** in the sidebar.
2. Read the month heading (for example "June 2026").
3. Use the left and right chevron arrows to change month.
4. Click an event chip to open that event (this opens the event edit form).
5. Click **New Event** to add an event.

Note: Book's calendar views do not support drag-to-create or drag-to-resize. Create and change events only through the **New Event** form and the edit form.

### Timeline view

A cross-app view that groups items by day across a week. It gathers Book events (blue), Bam task due dates (orange), and Bond deal close dates (teal), with a legend reading "Book Events / Bam Tasks / Bond Deals".

![Cross-app timeline](screenshots/light/03-timeline.png)

To use the Timeline:

1. Click **Timeline** in the sidebar.
2. Read the heading (for example "Timeline: Jun 9 - Jun 15, 2026").
3. Move between weeks with the left and right chevron arrows, or click **This Week** to return to the current week.
4. Scan the per-day grouping; each item carries a source label (Event, Task, or Deal) and, for timed items, its time.
5. Click a Book item to open that event (this opens the event edit form).

The Timeline reads Book events, Bam task due dates, and Bond deal close dates from the API and renders each under the right source style, with timed items showing their time. Bam and Bond items appear with their own Task and Deal styling. To read the same data with an agent, use the `book_get_timeline` MCP tool.

### New Event and Edit Event

The form for creating a new event or changing an existing one. Reached by **New Event** from any calendar view (which opens "New Event"), or by opening an event and choosing **Edit** (which opens "Edit Event").

To create an event:

1. From any calendar view, click **New Event**. The form opens with the heading **New Event**.
2. Enter a **Title** (required; placeholder "Team standup").
3. Choose a **Calendar** (required) from the dropdown. The form preselects your default calendar.
4. Toggle **All day** if the event has no specific time. When off, set **Start** and **End**. When on, set **Start Date** and **End Date**.
5. Optionally add a **Description** (placeholder "Add details, agenda, or notes...") and a **Location** (placeholder "Conference room, address, or video URL").
6. Optionally set **Repeat** (No repeat, Daily, Weekly, Every 2 weeks, Monthly) and **Show as** (Busy, Free, Tentative, Out of Office).
7. Click **Create Event**. If anything is missing you will see "Title is required", "Select a calendar", or "End must be after start".

To edit an event:

1. Open an event and click **Edit**, or click the event in a calendar view (which goes straight to this form). The heading reads **Edit Event**.
2. Change any field.
3. Click **Update Event**. Use **Cancel** or **Back to Event** to leave without saving.

Notes and current limitations:

- The form shows a **Reminder** dropdown and a **Color** picker, but neither is sent when you save. Book has no reminder feature and no reminder job, and event color is not stored on the event (color lives on the calendar). Treat both controls as inactive.
- You cannot add or edit attendees from this form. Attendees are set when an event is created through the API or an agent tool (`book_create_event`).
- **Repeat** is stored but not expanded. Choosing a repeat option records the rule on the single event; Book does not yet generate the future occurrences, so a "weekly" event remains one event.

### Event detail and RSVP

The read-only detail view of an event, reached by visiting an event's direct URL (`/book/events/<id>`). It shows the event's status pill and visibility label, time and timezone, location, meeting URL link, and description.

To view an event and respond to it:

1. Open the event detail page. A **Back to Calendar** link sits at the top.
2. Review the details card: time and timezone, the **Location** line, the meeting URL link, and the description.
3. If you are an attendee, find the **Your response** panel and click **Accept**, **Maybe**, or **Decline**. "Maybe" records a tentative response.
4. See the **Attendees (N)** list for each person's response status; the organizer's row is marked "(organizer)".
5. If the event came from a booking page, an amber **Booked via scheduling link** panel appears with the booker's name and email.
6. Click **Edit** to change the event, or **Cancel** (trash icon) and confirm "Cancel this event?" to soft-cancel it.

Notes:

- RSVP only works if you are already an attendee. If you are not on the attendee list, the response is rejected.
- The calendar and Timeline views link straight to the edit form, so the detail view is reached mainly by opening an event's direct URL.
- Cancelling an event sets its status to `cancelled`; it then drops out of availability and the timeline rather than being deleted.

### Booking Pages list

Your public scheduling links. The heading reads "Booking Pages" with the subtitle "Public scheduling links for clients and prospects". You only ever see your own pages here.

![Booking pages](screenshots/light/04-booking-pages.png)

To manage booking pages:

1. Click **Booking Pages** in the sidebar.
2. Each page row shows its title, an **Active** or **Disabled** pill, its `/meet/<slug>` link, its duration ("{n} min"), its creation date, and its description.
3. Click **New Booking Page** to create one.
4. Click **Edit** on a page to change it, or the trash icon to delete it (confirm "Delete this booking page?").

Note: the list still renders an amber **Feature under development** banner that reads "Booking pages are coming soon. We're integrating with Bond CRM to support lead capture and meeting scheduling." That banner is stale. The page list, creation, editing, deletion, the public booking flow, and the on-booking Bond contact creation are all shipped and working. The screenshot above includes this banner.

### Booking page editor

The form for creating or editing a booking page. Reached by **New Booking Page** ("New Booking Page" heading) or **Edit** ("Edit Booking Page" heading).

To create a booking page:

1. Click **New Booking Page**.
2. Enter a **Title** (placeholder "30-Minute Intro Call").
3. Enter a **URL Slug** after the "/meet/" prefix (placeholder "intro-call"). Slugs use lowercase letters, numbers, and hyphens only, and must be unique within your org. A duplicate slug is rejected with "Slug already in use".
4. Optionally add a **Description** and adjust **Duration (min)**, **Buffer Before (min)**, **Buffer After (min)**, and **Brand Color**.
5. Click **Create**. Use **Cancel** or **Back to Booking Pages** to leave.

To edit an existing page:

1. From the Booking Pages list, click **Edit** on the page you want.
2. The form opens with the heading **Edit Booking Page** and loads the page's current title, slug, description, duration, buffers, and brand color.
3. Change any field and click **Update**.

Current limitations:

- The editor exposes only title, slug, description, duration, buffers, and brand color. The booking page model also supports advance limit, minimum notice, confirmation message, redirect URL, logo, an enabled flag, and the cross-app flags `auto_create_bond_contact`, `auto_create_bam_task`, and `bam_project_id`. None of these are surfaced in the editor today, so to change them use the `book_update_booking_page` MCP tool. Because `auto_create_bond_contact` defaults to on at the data layer, new pages create a Bond contact on each booking by default even though there is no toggle for it in the editor.

### Public Meet page

The public scheduling page a visitor sees at `/book/meet/<slug>`. It does not require login. It shows the page title, "with {owner}", the duration, and the description, then a **Pick a time** section that groups available slots by day, then a **Your details** form with **Full name** (required), **Email** (required), and **Notes (optional)**, and a submit button labelled "Book {time}" (or "Pick a time above" until a slot is chosen). On success it shows a **Booking confirmed** screen with the page's confirmation message.

To book time as a visitor:

1. Open the page's `/book/meet/<slug>` link. The available times for the next two weeks load under **Pick a time**, grouped by day.
2. Click a time slot to select it.
3. Fill in **Full name** and **Email** (both required), and an optional note in **Notes (optional)**.
4. Click **Book {time}**.
5. The page shows the **Booking confirmed** screen with the owner's confirmation message. If the page has a redirect URL configured, you are sent there instead.

The slots offered come from the owner's working hours minus the events that mark them busy, cut into meeting-sized chunks that respect the page's duration and before and after buffers. Booking creates a confirmed event on the owner's default calendar. Two visitors cannot grab the same slot: the booking is guarded by a row lock, and a collision returns a 409 with "This time slot is no longer available."

When a booking comes in and the page has `auto_create_bond_contact` on (the default), Book creates or updates a matching Bond contact by email, attributed to the booking-page owner and tagged with a `booking_page` lead source. Re-booking with the same email does not create a duplicate contact. The Bam-task hook on booking only runs when a page explicitly enables `auto_create_bam_task` and sets a `bam_project_id`, which the editor does not expose; set those with `book_update_booking_page` if you want each booking to spawn a follow-up task.

### Calendars

Manage the calendars you organize events into. Found under **Book Settings > Calendars**. The heading reads "Calendars" with the subtitle "Manage the calendars you use to organize events".

![Calendars](screenshots/light/06-calendars.png)

To manage calendars:

1. Click **Calendars** under **Book Settings**.
2. Each calendar row shows its name, a **Default** pill where applicable, its type (lowercased), and its description.
3. Click **New Calendar** to open the inline **New calendar** form. Enter a name, pick a color from the preset swatches, and click **Create** (or **Cancel**).
4. To change a calendar, click **Edit** on its row, adjust the name and color, and click the check (save) button.
5. To remove a calendar, click the trash icon and confirm "Delete calendar [name]?". The default calendar cannot be deleted and has no trash icon; an attempt at the API returns "Cannot delete default calendar".

Note: your personal **My Calendar** is created automatically the first time this screen loads, so the list is never empty.

### Working Hours

Set the weekly hours that drive your availability and booking-page slots. Found under **Book Settings > Working Hours**. The heading reads "Working Hours" with the subtitle "Set your available hours for booking pages and availability calculations".

![Working hours](screenshots/light/05-working-hours.png)

To set your working hours:

1. Click **Working Hours** under **Book Settings**.
2. You see seven rows, Sunday through Saturday. Monday to Friday, 09:00 to 17:00, are enabled by default.
3. Check or uncheck a day to mark it available or "Unavailable".
4. For each enabled day, set its start and end times.
5. Click **Save Working Hours**. The save replaces your full weekly schedule with the enabled days shown, so make sure every day you want available is enabled before saving.

### Connections

Intended to connect Google Calendar or Microsoft Outlook for two-way sync. Found under **Book Settings > Connections**. The heading reads "External Calendar Connections" with the subtitle "Connect Google Calendar or Microsoft Outlook for two-way sync".

To reach the page:

1. Click **Connections** under **Book Settings**.
2. You see a **Google Calendar** card and a **Microsoft Outlook** card, each with a **Connect** button.

Current limitation: external calendar sync is not implemented. Both **Connect** buttons are disabled, the page never calls the API, and there is no OAuth flow. A note on the page reads "OAuth integration requires Google/Microsoft credentials in the server configuration." Even at the API level, the force-sync action only updates a timestamp and does not pull or push any external events. Do not expect to connect or sync an outside calendar from Book today.

### iCal feed

Book can expose a single calendar as a token-authenticated `.ics` feed that an outside calendar app (Apple Calendar, Google Calendar) can subscribe to.

There is no button for this in the app. The feed is available through the API only: mint a feed token for a calendar with `POST /calendars/:id/ical`, then hand the resulting `GET /calendars/:id/ical?token=...` URL to your external calendar app. If you need this, ask an admin or an agent to mint the token for the calendar you want to share.

### In-app Help

Press **?** anywhere in Book (when you are not typing in a field), or navigate to `/book/help`, to open the shared Help viewer for Book.

### Working with AI agents

Agents reach Book through 24 MCP tools. They use the same Book API and permissions you do, so an agent can only do what its account is allowed to do. Agents are especially useful for the scheduling math that Book has no human screen for: finding a common free time across several people.

- **Reading events and the timeline:** `book_list_events` (the data behind Week, Day, Month reads), `book_get_event` (one event with attendees and linked-entity context), and `book_get_timeline` (the cross-app Timeline data).
- **Creating and changing events:** `book_create_event` (resolves a calendar by name and an attendee by email, and can set attendees, which the human form cannot), `book_update_event` and `book_cancel_event` (resolve an event by UUID or title), and `book_rsvp_event` (RSVP by event UUID or title).
- **Availability and meeting time:** `book_get_availability` (one person's free slots), `book_get_team_availability` (free slots for two or more people), `book_find_meeting_time` (intersects team availability and returns up to three suggestions), and `book_find_meeting_time_for_users` (a mixed-roster finder that treats agents and service accounts as always available while respecting human working hours). These four have no human UI in Book today, so they are the main reason to involve an agent.
- **Calendars:** `book_list_calendars`, `book_create_calendar`, `book_update_calendar`, `book_delete_calendar` (the last three resolve a calendar by UUID or name).
- **Booking pages:** `book_list_booking_pages`, `book_create_booking_page`, `book_update_booking_page` (set `enabled: false` to take a page offline without deleting it, or set the cross-app flags the editor does not expose), and `book_delete_booking_page`.
- **Working hours:** `book_get_working_hours` and `book_set_working_hours` (a full replace; include every day you want available).
- **External connections:** `book_list_connections`, `book_sync_connection`, and `book_delete_connection` (subject to the same sync limitation described under Connections).

Things to know when reviewing agent work:

- An agent can add attendees at creation time even though the human event form cannot. Check the attendee list on the event detail page to confirm who was invited.
- `book_update_booking_page` is the way to set the booking-page options the human editor does not surface (advance limit, minimum notice, confirmation message, redirect URL, logo, the enabled flag, and the cross-app auto-create flags).
- Some caveats that apply to people apply to agents too: recurrence is not expanded, reminders do not exist, and external calendar sync does not run. An agent cannot work around these because the backend does not implement them.
- Book publishes five automation events to Bolt, all from source `book`: `event.created`, `event.updated`, `event.cancelled`, `event.rsvp`, and `booking.created`. Use these to drive cross-app automations (for example, post to a Banter channel when a booking comes in). A new public booking creates or updates a Bond contact by email when the page has `auto_create_bond_contact` on, so a `booking.created` automation can safely assume the matching contact exists.

Book agents also sit on the cross-cutting agentic platform that every BigBlueBam app shares:

- **Identity and heartbeat.** Agent and service accounts are first-class users (`users.kind` is `human`, `agent`, or `service`), and the actor type is recorded on every action they take. Agent runners report in with `agent_heartbeat`, `agent_self_report`, and `agent_audit`.
- **Approval queues.** An agent can route a scheduling change for human sign-off with `proposal_create`; reviewers act on it with `proposal_list` and `proposal_decide`. This is the right pattern when an agent wants to move or cancel an event on someone else's behalf.
- **Visibility preflight.** Before an agent surfaces another person's calendar items in a shared place, it calls `can_access` so it only shows entities the asking user is allowed to see.
- **Policies and webhooks.** Per-agent kill switches and tool allowlists (the `book.*` prefix governs these Book tools) are enforced on every service-account call, and subscribed Bolt events can be pushed to agent runners over signed outbound webhooks.

For the full tool catalog and schemas, see the Book MCP-tools reference and guide in `docs/apps/book/`.

## User Stories

### Story: Set your working hours

**Who:** Any Book user getting started.
**Goal:** Define the weekly windows that determine when you are available.
**Before you start:** Be signed in to BigBlueBam and have Book open.

**Steps**

1. In the sidebar, under **Book Settings**, click **Working Hours**.
2. Review the seven day rows. Monday to Friday, 09:00 to 17:00, are enabled by default.
3. Check the days you want to be available and uncheck the rest (unchecked days show "Unavailable").
4. For each enabled day, set the start and end times.
5. Click **Save Working Hours**.

**Result:** Your weekly availability is saved. Book now uses these windows when it computes free slots for availability and for any booking pages you publish.

**Related:** Working Hours feature; availability tools `book_get_availability` and `book_get_team_availability`. Agents can set the same schedule with `book_set_working_hours`.

### Story: Schedule a one-off meeting

**Who:** Anyone planning a meeting or a block of focused time.
**Goal:** Put a single event on a calendar.
**Before you start:** Be signed in. At least one calendar exists (your **My Calendar** is created automatically).

**Steps**

1. Open any calendar view (**Week**, **Day**, or **Month**) and click **New Event**.
2. Enter a **Title** (for example "Team standup").
3. Choose a **Calendar** (your default is preselected).
4. Leave **All day** off and set **Start** and **End**, or turn **All day** on and set **Start Date** and **End Date**.
5. Optionally add a **Description**, a **Location**, a **Repeat** value, and a **Show as** value.
6. Click **Create Event**.

**Result:** The event appears on the chosen calendar and shows in the Week, Day, and Month views. If you marked it Busy, Tentative, or Out of Office, it now reduces your availability.

**Related:** New Event feature. Agents do the same with `book_create_event`, which can also add attendees.

### Story: View and adjust an event

**Who:** Anyone updating a meeting's details.
**Goal:** Change the time, location, or description of an existing event.
**Before you start:** The event exists and you have permission to update it.

**Steps**

1. In a calendar view, click the event. This opens the **Edit Event** form directly.
2. Change any field, for example **Start**, **End**, **Location**, or **Description**.
3. Click **Update Event**.

**Result:** The event is updated everywhere it appears.

**Related:** New Event and Edit Event feature. To see an event's read-only detail and attendee list instead, open its direct URL (`/book/events/<id>`). Agents update events with `book_update_event`.

### Story: Cancel an event

**Who:** Anyone calling off a meeting.
**Goal:** Remove an event from calendars and availability without losing its record.
**Before you start:** The event exists and you can delete it.

**Steps**

1. Open the event's detail page at its direct URL (`/book/events/<id>`).
2. Click **Cancel** (the trash icon).
3. Confirm "Cancel this event?".

**Result:** The event's status becomes `cancelled`. It disappears from availability and the timeline but its record is retained (soft delete).

**Related:** Event detail feature. Agents cancel with `book_cancel_event`.

### Story: RSVP to an invitation

**Who:** An attendee invited to an event.
**Goal:** Tell the organizer whether you will attend.
**Before you start:** You are listed as an attendee on the event.

**Steps**

1. Open the event's detail page (`/book/events/<id>`).
2. Find the **Your response** panel.
3. Click **Accept**, **Maybe**, or **Decline**. "Maybe" records a tentative response.

**Result:** Your response status updates in the **Attendees** list. If you are not an attendee, the response is rejected.

**Related:** Event detail and RSVP feature. Agents RSVP with `book_rsvp_event`.

### Story: Manage multiple calendars

**Who:** Anyone separating work into distinct calendars.
**Goal:** Add, rename, recolor, or remove calendars.
**Before you start:** Be signed in with calendar write permission.

**Steps**

1. Under **Book Settings**, click **Calendars**.
2. Click **New Calendar**, enter a name, pick a color swatch, and click **Create**.
3. To change a calendar, click **Edit** on its row, adjust the name and color, and click the check (save) button.
4. To remove a non-default calendar, click its trash icon and confirm "Delete calendar [name]?".

**Result:** Your calendar list reflects the changes. The default calendar stays put; it has no trash icon and the API rejects an attempt to delete it with "Cannot delete default calendar".

**Related:** Calendars feature. Agents manage calendars with `book_list_calendars`, `book_create_calendar`, `book_update_calendar`, and `book_delete_calendar`.

### Story: Create and share a public booking page

**Who:** Someone who wants outside people to book time with them.
**Goal:** Publish a scheduling link at `/book/meet/<slug>` and share it.
**Before you start:** Set your Working Hours first, since they define the offered slots. Have booking-page write permission.

**Steps**

1. Click **Booking Pages** in the sidebar, then **New Booking Page**.
2. Enter a **Title** (for example "30-Minute Intro Call").
3. Enter a **URL Slug** after "/meet/" using lowercase letters, numbers, and hyphens (for example "intro-call").
4. Optionally set **Description**, **Duration (min)**, **Buffer Before (min)**, **Buffer After (min)**, and **Brand Color**.
5. Click **Create**.
6. Copy the page's `/meet/<slug>` link from the Booking Pages list and share it. To change the page later, click **Edit** on its row.

**Result:** The page appears in your Booking Pages list with an **Active** pill and its `/meet/<slug>` link. A visitor who opens the link sees your available times, picks a slot, and books; the booking lands as a confirmed event on your default calendar, and a matching Bond contact is created or updated by email (unless the page's `auto_create_bond_contact` flag has been turned off).

**Related:** Booking Pages list, Booking page editor, and Public Meet page features. Agents create pages with `book_create_booking_page` and edit them (including the options the editor does not surface) with `book_update_booking_page`.

### Story: Book time as an outside visitor

**Who:** A prospect or client with a booking-page link.
**Goal:** Reserve a time on the page owner's calendar.
**Before you start:** You have a `/book/meet/<slug>` link. No login is required.

**Steps**

1. Open the link. Under **Pick a time**, the next two weeks of available slots load, grouped by day.
2. Click a time slot to select it.
3. Fill in **Full name** and **Email**, and an optional **Notes (optional)**.
4. Click **Book {time}**.

**Result:** You see the **Booking confirmed** screen with the owner's confirmation message (or you are sent to the page's redirect URL, if set). The owner's default calendar gains a confirmed event, and a Bond contact is created or updated from your email when the page has that on.

**Related:** Public Meet page feature. The booking emits a `booking.created` Bolt event from source `book`, which Bolt rules can react to.

### Story: See everything happening this week across apps

**Who:** Anyone who wants a single week-at-a-glance across the suite.
**Goal:** Scan Book events, Bam task due dates, and Bond deal close dates together.
**Before you start:** Be signed in.

**Steps**

1. Click **Timeline** in the sidebar.
2. Read the date-range heading (for example "Timeline: Jun 9 - Jun 15, 2026").
3. Move between weeks with the left and right chevron arrows, or click **This Week**.
4. Scan the per-day items, using the source labels and the "Book Events / Bam Tasks / Bond Deals" legend.

**Result:** You see the week's items grouped by day. Book events show in blue with their time, Bam tasks in orange on their due date, and Bond deals in teal on their close date. Click a Book item to open its event.

**Related:** Timeline feature. Agents read the same data with `book_get_timeline`.

### Story: Find a common meeting time across several people (agent-driven)

**Who:** A user working with an AI agent, or the agent itself.
**Goal:** Identify a time when everyone on a list is free.
**Before you start:** Each person has set their Working Hours, and you have an agent with Book access. There is no human screen for this in Book today, so it runs through an agent.

**Steps**

1. Ask the agent to find a meeting time for the people you name (by email is fine; the tools resolve identifiers).
2. The agent calls `book_get_team_availability` to gather each person's free slots, or `book_find_meeting_time` to get up to three suggested times directly.
3. For a roster that mixes people with agents or service accounts, the agent uses `book_find_meeting_time_for_users`, which treats agents and service accounts as always available while honoring human working hours.
4. Review the suggested times and ask the agent to create the event with `book_create_event`.

**Result:** You get one or more candidate times that fit everyone's availability, and an event can be created on the spot.

**Related:** Working with AI agents. Tools: `book_get_availability`, `book_get_team_availability`, `book_find_meeting_time`, `book_find_meeting_time_for_users`, `book_create_event`.

### Story: Subscribe to a Book calendar from an outside app (iCal, agent or API)

**Who:** Someone who wants a Book calendar to appear in Apple Calendar or Google Calendar.
**Goal:** Get a subscribable `.ics` feed URL for one calendar.
**Before you start:** There is no button for this in Book. You need an admin or an agent to mint the feed token through the API.

**Steps**

1. Ask an admin or agent to mint an iCal feed token for the specific calendar you want to share (`POST /calendars/:id/ical`).
2. Receive the public feed URL with its `?token=...` query (`GET /calendars/:id/ical?token=...`).
3. In your external calendar app, add a subscribed calendar by URL and paste the feed URL.

**Result:** Your outside calendar app shows that Book calendar's events. There is no in-app control to generate or revoke the feed today.

**Related:** iCal feed feature.

## Related

- **Bam** (`/b3/`) - Sign in here first; Book has no login of its own. Bam tasks with due dates appear on the Book Timeline, and events can link to a Bam task.
- **Bond** (`/bond/`) - Bond deal close dates appear on the Book Timeline, and events can link to a Bond deal. A public booking creates or updates a Bond contact by email when the page has `auto_create_bond_contact` on (the default).
- **Helpdesk** (`/helpdesk/`) - Events can link to a Helpdesk ticket.
- **Bolt** (`/bolt/`) - Subscribe to Book's automation events (`event.created`, `event.updated`, `event.cancelled`, `event.rsvp`, `booking.created`, all from source `book`) to drive cross-app workflows.
- **Banter** (`/banter/`) - A common automation target, for example posting to a channel when a booking arrives.
- Book MCP-tools reference and guide in `docs/apps/book/` for the full catalog of the 24 agent tools and their schemas.
