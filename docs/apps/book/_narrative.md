# Book - Scheduling

Book is BigBlueBam's scheduling and calendar app. It manages events across multiple calendars, computes availability from your working hours, publishes public booking pages, and gathers Book events alongside Bam task due dates and Bond deal close dates on a cross-app timeline. Every user gets a personal **My Calendar** automatically on first use, so there is nothing to set up before adding events.

## Key Features

- **Calendar views** in week, day, and month layouts, plus a cross-app timeline that groups Book events, Bam task due dates, and Bond deal close dates by day.
- **Events** with title, time, location, description, status, and a Show as (free/busy/tentative/out-of-office) setting that drives availability. Cancelling is a soft delete, and every Book-native event gets a LiveKit huddle room.
- **Multiple calendars** per user, each with a type, color, and timezone. The default **My Calendar** cannot be deleted.
- **Working hours** set per day of the week. These windows minus your busy events produce the free slots used for availability and booking pages.
- **Booking pages** that publish a public scheduling link at `/book/meet/<slug>` with duration, buffers, and brand styling. Creation, listing, and deletion are shipped; the visitor-facing booking flow and editing an existing page are still being finished.
- **Availability and find-a-meeting-time**, including multi-person and mixed human-plus-agent rosters, exposed through MCP tools.
- **iCal feed** that exposes a single calendar as a token-authenticated `.ics` URL through the API.

## Integrations

Events can link to a Bam task, a Bond deal, or a Helpdesk ticket. The timeline pulls Bam task due dates and Bond deal close dates next to Book events. Book publishes five Bolt automation events from source `book` (`event.created`, `event.updated`, `event.cancelled`, `event.rsvp`, `booking.created`), so Bolt rules can react when an event changes or a booking arrives, for example by posting to a Banter channel. AI agents drive Book through 24 MCP tools and the shared agentic platform (identity and heartbeat, approval queues, visibility preflight, and policy-governed tool access), letting them create events, find meeting times across people, and manage booking pages. External calendar connections (Google, Microsoft) are modeled in the backend but two-way sync is not yet implemented.

## Getting Started

Open Book from the Launchpad at `/book/`. Sign in to BigBlueBam first if prompted; Book has no login of its own. Your **My Calendar** is created automatically. Set your working hours under **Book Settings > Working Hours**, then create events from any calendar view with **New Event**. Publish a booking page under **Booking Pages** when you want outside people to schedule time, and use the **Timeline** to see the week across Book, Bam, and Bond.
