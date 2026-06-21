# Book — Scheduling & Calendar for BigBlueBam

## Software Design Specification

**Version:** 1.0
**Date:** April 8, 2026
**Product:** Book (Scheduling & Calendar)
**Suite:** BigBlueBam
**Author:** Eddie Offermann / Big Blue Ceiling Prototyping & Fabrication, LLC

---

## 1. Overview

### 1.1 Product Vision

Book is the scheduling and calendar platform for the BigBlueBam suite. It provides shared team calendars, personal scheduling, external booking pages (public links for clients/prospects to schedule time), and a unified timeline view that aggregates calendar events alongside Bam task due dates, sprint boundaries, Bearing goal deadlines, and Bond deal expected close dates.

Book solves the "where does time go?" problem for teams already using BigBlueBam. Without Book, time-based coordination requires leaving the suite for Google Calendar, Calendly, or Outlook — breaking the context that makes the suite valuable. Book keeps scheduling inside the same permission model, notification system, and AI agent layer as everything else.

The external booking page is a critical competitive feature: it replaces Calendly for teams that want a branded scheduling link that creates Bond contacts and Bam tasks automatically when someone books a meeting.

### 1.2 Core Principles

1. **Aggregation is the killer feature.** The calendar does not just show Book events — it overlays Bam task due dates, sprint start/end markers, Bearing goal deadlines, Bond deal expected close dates, and Blast campaign send dates as read-only items. One view for everything time-based.
2. **Booking pages replace Calendly.** A public scheduling link lets external contacts pick a time slot based on real availability. Bookings can auto-create Bond contacts and Bam tasks via Bolt.
3. **External calendar sync.** Two-way sync with Google Calendar and Outlook (via CalDAV/Google Calendar API/Microsoft Graph). Book is the aggregation layer, not a replacement for external calendars.
4. **AI scheduling via MCP.** Agents can find available slots, propose meeting times, create events, and manage booking pages — enabling natural-language scheduling in Banter.
5. **Team-first visibility.** Team calendars show who is available, who is overloaded, and where schedule conflicts exist. Resource planning meets scheduling.

### 1.3 Non-Goals

- Book is **not** a full resource management tool. It shows calendar-level availability, not capacity planning with hourly rates and utilization tracking. That's future scope.
- Book does **not** include video conferencing. It generates Banter huddle links or external meeting URLs (Zoom, Google Meet) in event details.
- Book does **not** support recurring events with complex RRULE semantics at launch. Simple recurrence (daily, weekly, biweekly, monthly) is supported. RRULE-level patterns (e.g., "third Thursday of every month") are future work.
- Book does **not** include room or equipment booking at launch.

---

## 2. Architecture

### 2.1 Monorepo Placement

```
apps/
  book-api/           → Fastify REST API (calendar CRUD, event management, booking pages, external sync)
  book/               → React SPA (calendar views, booking page builder, availability settings)
```

### 2.2 Infrastructure

| Component | Role |
|-----------|------|
| **book-api** (Fastify :4010) | REST API for calendars, events, booking pages, availability, external sync |
| **PostgreSQL 16** | Calendar and event data (shared DB, `book_` prefix) |
| **Redis 7** | Availability cache, sync lock management |
| **BullMQ Worker** | External calendar sync polling, booking confirmation emails, reminder notifications |
| **MCP Server** | Full scheduling tool surface for AI agents |

### 2.3 External Calendar Sync Architecture

```
┌────────────────────────────────────────────────────────┐
│                   Sync Engine (BullMQ Worker)            │
│                                                         │
│  1. Poll external calendars on schedule (every 5 min)   │
│  2. Fetch events via Google Calendar API / MS Graph      │
│  3. Diff against local mirror (book_external_events)    │
│  4. Upsert changes, delete removed events               │
│  5. Push local Book events to external calendar          │
│  6. Use Redis locks to prevent concurrent sync races     │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                   Availability Calculation               │
│                                                         │
│  User's available slots =                                │
│    (Working hours schedule)                              │
│    MINUS (Book events where user is attendee)            │
│    MINUS (External calendar events marked busy)          │
│    MINUS (Buffer time around events, if configured)      │
│                                                         │
│  Cached in Redis, invalidated on event create/update     │
└────────────────────────────────────────────────────────┘
```

### 2.4 nginx Routing

```nginx
location /book/ {
    alias /usr/share/nginx/html/book/;
    try_files $uri $uri/ /book/index.html;
}

location /book/api/ {
    proxy_pass http://book-api:4010/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

# Public booking pages (no auth required)
location /meet/ {
    proxy_pass http://book-api:4010/meet/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### 2.5 Docker Service

```yaml
book-api:
  build:
    context: .
    dockerfile: apps/book-api/Dockerfile
  environment:
    - DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/bigbluebam
    - REDIS_URL=redis://redis:6379
    - MCP_INTERNAL_URL=http://mcp-server:3001
    - SESSION_SECRET=${SESSION_SECRET}
    - GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
    - GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:-}
    - MICROSOFT_CLIENT_ID=${MICROSOFT_CLIENT_ID:-}
    - MICROSOFT_CLIENT_SECRET=${MICROSOFT_CLIENT_SECRET:-}
    - PUBLIC_URL=${PUBLIC_URL}
  ports:
    - "4010:4010"
  depends_on:
    - postgres
    - redis
    - mcp-server
```

---

## 3. Data Model

### 3.1 PostgreSQL Schema

```sql
-- ============================================================
-- BOOK: Scheduling & Calendar
-- ============================================================

-- Calendars (each user has a personal calendar; teams/projects can have shared calendars)
CREATE TABLE book_calendars (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    owner_user_id       UUID REFERENCES users(id) ON DELETE CASCADE,     -- NULL = shared calendar
    project_id          UUID REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-level or personal
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    color               VARCHAR(7) NOT NULL DEFAULT '#3b82f6',
    calendar_type       VARCHAR(20) NOT NULL DEFAULT 'personal'
                        CHECK (calendar_type IN ('personal', 'team', 'project', 'booking')),
    is_default          BOOLEAN NOT NULL DEFAULT false,
    timezone            VARCHAR(50) NOT NULL DEFAULT 'UTC',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_book_cal_org ON book_calendars(organization_id);
CREATE INDEX idx_book_cal_owner ON book_calendars(owner_user_id);
CREATE INDEX idx_book_cal_project ON book_calendars(project_id);

-- Events
CREATE TABLE book_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    calendar_id         UUID NOT NULL REFERENCES book_calendars(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Event data
    title               VARCHAR(500) NOT NULL,
    description         TEXT,
    location            TEXT,                    -- physical address or virtual meeting URL
    meeting_url         TEXT,                    -- Banter huddle link, Zoom, Google Meet, etc.

    -- Timing
    start_at            TIMESTAMPTZ NOT NULL,
    end_at              TIMESTAMPTZ NOT NULL,
    all_day             BOOLEAN NOT NULL DEFAULT false,
    timezone            VARCHAR(50) NOT NULL DEFAULT 'UTC',

    -- Recurrence
    recurrence_rule     VARCHAR(30) CHECK (recurrence_rule IN ('daily', 'weekly', 'biweekly', 'monthly')),
    recurrence_end_at   TIMESTAMPTZ,             -- NULL = no end
    recurrence_parent_id UUID REFERENCES book_events(id) ON DELETE CASCADE,  -- links instances to parent

    -- Status
    status              VARCHAR(20) NOT NULL DEFAULT 'confirmed'
                        CHECK (status IN ('tentative', 'confirmed', 'cancelled')),
    visibility          VARCHAR(20) NOT NULL DEFAULT 'busy'
                        CHECK (visibility IN ('free', 'busy', 'tentative', 'out_of_office')),

    -- Cross-product links
    linked_entity_type  VARCHAR(20) CHECK (linked_entity_type IN ('bam_task', 'bond_deal', 'helpdesk_ticket')),
    linked_entity_id    UUID,

    -- Booking source (if created via booking page)
    booking_page_id     UUID REFERENCES book_booking_pages(id) ON DELETE SET NULL,
    booked_by_name      VARCHAR(200),
    booked_by_email     VARCHAR(255),

    -- Metadata
    created_by          UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_event_times CHECK (end_at > start_at)
);

CREATE INDEX idx_book_events_calendar ON book_events(calendar_id);
CREATE INDEX idx_book_events_org ON book_events(organization_id);
CREATE INDEX idx_book_events_time ON book_events(start_at, end_at);
CREATE INDEX idx_book_events_recurrence ON book_events(recurrence_parent_id);

-- Event attendees
CREATE TABLE book_event_attendees (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id            UUID NOT NULL REFERENCES book_events(id) ON DELETE CASCADE,
    user_id             UUID REFERENCES users(id) ON DELETE CASCADE,      -- NULL for external attendees
    email               VARCHAR(255) NOT NULL,
    name                VARCHAR(200),
    response_status     VARCHAR(20) NOT NULL DEFAULT 'needs_action'
                        CHECK (response_status IN ('needs_action', 'accepted', 'declined', 'tentative')),
    is_organizer        BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_book_attendees_event ON book_event_attendees(event_id);
CREATE INDEX idx_book_attendees_user ON book_event_attendees(user_id);

-- Working hours (per-user availability windows)
CREATE TABLE book_working_hours (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day_of_week         SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sunday
    start_time          TIME NOT NULL,
    end_time            TIME NOT NULL,
    timezone            VARCHAR(50) NOT NULL DEFAULT 'UTC',
    enabled             BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (user_id, day_of_week),
    CONSTRAINT valid_work_times CHECK (end_time > start_time)
);

-- Booking pages (public scheduling links)
CREATE TABLE book_booking_pages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    owner_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Page config
    slug                VARCHAR(60) NOT NULL,    -- URL path: /meet/:slug
    title               VARCHAR(255) NOT NULL,   -- e.g., "30-Minute Intro Call with Eddie"
    description         TEXT,
    duration_minutes    INTEGER NOT NULL DEFAULT 30,
    buffer_before_min   INTEGER NOT NULL DEFAULT 0,
    buffer_after_min    INTEGER NOT NULL DEFAULT 15,
    max_advance_days    INTEGER NOT NULL DEFAULT 60,  -- how far ahead bookings are allowed
    min_notice_hours    INTEGER NOT NULL DEFAULT 4,   -- minimum hours before a slot can be booked

    -- Branding
    color               VARCHAR(7) DEFAULT '#3b82f6',
    logo_url            TEXT,

    -- Confirmation
    confirmation_message TEXT DEFAULT 'Your meeting has been booked! You will receive a confirmation email.',
    redirect_url        TEXT,                    -- optional redirect after booking

    -- Integration
    auto_create_bond_contact BOOLEAN NOT NULL DEFAULT true,    -- create Bond contact on booking
    auto_create_bam_task     BOOLEAN NOT NULL DEFAULT false,   -- create Bam task on booking
    bam_project_id           UUID REFERENCES projects(id),     -- which project for auto-tasks

    -- Status
    enabled             BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug)
);

CREATE INDEX idx_book_pages_org ON book_booking_pages(organization_id);
CREATE INDEX idx_book_pages_owner ON book_booking_pages(owner_user_id);
CREATE INDEX idx_book_pages_slug ON book_booking_pages(slug) WHERE enabled = true;

-- External calendar connections (Google Calendar, Outlook)
CREATE TABLE book_external_connections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider            VARCHAR(20) NOT NULL CHECK (provider IN ('google', 'microsoft')),
    -- OAuth tokens (encrypted at rest)
    access_token        TEXT NOT NULL,
    refresh_token       TEXT,
    token_expires_at    TIMESTAMPTZ,
    -- Sync config
    external_calendar_id VARCHAR(255) NOT NULL,   -- provider's calendar ID
    sync_direction      VARCHAR(10) NOT NULL DEFAULT 'both'
                        CHECK (sync_direction IN ('inbound', 'outbound', 'both')),
    last_sync_at        TIMESTAMPTZ,
    sync_status         VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (sync_status IN ('active', 'paused', 'error')),
    sync_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_book_ext_user ON book_external_connections(user_id);

-- External events mirror (read-only copy of external calendar events for availability calculation)
CREATE TABLE book_external_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id       UUID NOT NULL REFERENCES book_external_connections(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_event_id   VARCHAR(255) NOT NULL,
    title               VARCHAR(500),            -- may be "(busy)" if external calendar hides details
    start_at            TIMESTAMPTZ NOT NULL,
    end_at              TIMESTAMPTZ NOT NULL,
    all_day             BOOLEAN NOT NULL DEFAULT false,
    visibility          VARCHAR(20) NOT NULL DEFAULT 'busy',
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (connection_id, external_event_id)
);

CREATE INDEX idx_book_ext_events_user ON book_external_events(user_id, start_at, end_at);
```

---

## 4. API Endpoints

### 4.1 Calendars

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/book/api/calendars` | List user's calendars (personal + shared team/project calendars they can see) |
| `POST` | `/book/api/calendars` | Create a calendar (team or project) |
| `PATCH` | `/book/api/calendars/:id` | Update calendar metadata |
| `DELETE` | `/book/api/calendars/:id` | Delete calendar |

### 4.2 Events

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/book/api/events` | List events in a date range (across multiple calendars) |
| `POST` | `/book/api/events` | Create an event |
| `GET` | `/book/api/events/:id` | Get event detail with attendees |
| `PATCH` | `/book/api/events/:id` | Update event |
| `DELETE` | `/book/api/events/:id` | Cancel/delete event |
| `POST` | `/book/api/events/:id/rsvp` | Accept/decline/tentative RSVP for an attendee |

### 4.3 Availability

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/book/api/availability/:userId` | Get available time slots for a user in a date range |
| `GET` | `/book/api/availability/team` | Get team availability overlay (multiple users) |
| `GET` | `/book/api/working-hours` | Get current user's working hours |
| `PUT` | `/book/api/working-hours` | Set current user's working hours (full replacement) |

### 4.4 Booking Pages

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/book/api/booking-pages` | List user's booking pages |
| `POST` | `/book/api/booking-pages` | Create a booking page |
| `PATCH` | `/book/api/booking-pages/:id` | Update booking page |
| `DELETE` | `/book/api/booking-pages/:id` | Delete booking page |

### 4.5 Public Booking Endpoints (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/meet/:slug` | Render booking page (public HTML) |
| `GET` | `/meet/:slug/slots` | Get available slots for a date range |
| `POST` | `/meet/:slug/book` | Book a slot (name, email, optional notes) |

### 4.6 External Calendar Sync

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/book/api/connections` | List external calendar connections |
| `POST` | `/book/api/connections/google` | Initiate Google Calendar OAuth flow |
| `POST` | `/book/api/connections/microsoft` | Initiate Microsoft OAuth flow |
| `DELETE` | `/book/api/connections/:id` | Disconnect external calendar |
| `POST` | `/book/api/connections/:id/sync` | Force immediate sync |

### 4.7 Aggregated Timeline

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/book/api/timeline` | Aggregated timeline: Book events + Bam due dates + sprint boundaries + Bearing deadlines + Bond close dates |

### 4.8 iCal Feed

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/book/api/calendars/:id/ical` | iCal feed URL for subscribing in external clients |

---

## 5. MCP Tools

| Tool | Description |
|------|-------------|
| `book_list_events` | List events in a date range |
| `book_create_event` | Create a calendar event with attendees |
| `book_update_event` | Update an event |
| `book_cancel_event` | Cancel an event |
| `book_get_availability` | Get available slots for a user |
| `book_get_team_availability` | Find common free slots across multiple users |
| `book_find_meeting_time` | AI proposes optimal meeting times for a set of attendees (respects working hours, existing events, time zones) |
| `book_create_booking_page` | Create a public booking page |
| `book_get_timeline` | Get aggregated cross-product timeline |
| `book_rsvp_event` | Accept or decline an event on behalf of the user |

### 5.1 Agent Scheduling Workflow

Natural-language scheduling in Banter:

> User in Banter: "@agent schedule a 30-min sync with @alice and @bob sometime this week"

1. Agent calls `book_get_team_availability` for the three users this week
2. Agent calls `book_find_meeting_time` to propose 3 optimal slots
3. Agent posts to Banter thread: "Here are 3 available times — react with 1️⃣, 2️⃣, or 3️⃣ to vote"
4. On reaction, agent calls `book_create_event` with the chosen time and all attendees
5. Attendees receive Book notifications and email confirmations

---

## 6. Frontend

### 6.1 Routes

| Route | View |
|-------|------|
| `/book` | Calendar view (week view default, toggleable: day/week/month) |
| `/book/day/:date` | Day view |
| `/book/month/:month` | Month view |
| `/book/timeline` | Aggregated cross-product timeline (Gantt-style horizontal) |
| `/book/events/:id` | Event detail (modal overlay) |
| `/book/booking-pages` | Booking page management |
| `/book/booking-pages/:id/edit` | Booking page editor |
| `/book/settings/working-hours` | Working hours configuration |
| `/book/settings/connections` | External calendar connections |

### 6.2 Calendar Views

- **Week view:** 7-column grid with hourly rows, events as positioned blocks. Overlapping events shown side-by-side.
- **Day view:** Single column, hourly detail. Shows external calendar events as translucent blocks.
- **Month view:** Date grid with event dots/previews. Click to expand day.
- **Aggregated items:** Bam due dates (triangular markers on date), sprint boundaries (horizontal bars), Bearing deadlines (diamond markers), Bond close dates (circle markers). All read-only, click to navigate to source entity.

### 6.3 Booking Page Public UI

Clean, single-purpose page:
1. Header with title, description, organizer name/photo, duration
2. Date picker (calendar month view showing available dates)
3. Time slot picker (list of available slots for selected date)
4. Booking form (name, email, optional notes)
5. Confirmation screen with event details and calendar add link (.ics download)

Branded with org color and optional logo. No BigBlueBam branding unless the org wants it.

---

## 7. Events (Bolt Integration)

| Event | Trigger | Payload |
|-------|---------|---------|
| `book.event.created` | Event created | `{ event_id, calendar_id, title, start_at, end_at, attendee_count }` |
| `book.event.updated` | Event modified | `{ event_id, changes }` |
| `book.event.cancelled` | Event cancelled | `{ event_id, title, start_at }` |
| `book.event.rsvp` | Attendee responded | `{ event_id, user_id, response_status }` |
| `book.booking.created` | External person booked via booking page | `{ event_id, booking_page_id, booked_by_email, booked_by_name }` |

---

## 8. Cross-Product Integration

### 8.1 Bam Integration
- Task due dates appear as read-only markers on Book calendar views
- Sprint start/end dates appear as horizontal range bars
- Booking page can auto-create a Bam task when an external person books

### 8.2 Bond Integration
- Deal expected close dates appear on the timeline
- Booking page auto-creates a Bond contact when `auto_create_bond_contact` is enabled
- Bond contact detail page shows related Book events (meetings with this contact)

### 8.3 Banter Integration
- Event creation in Book can auto-generate a Banter huddle link as the meeting URL
- Event reminders can be sent as Banter DMs (via Bolt)
- AI scheduling workflow operates through Banter conversation

### 8.4 Bearing Integration
- Goal deadlines and KR target dates appear on the aggregated timeline

---

## 9. Permissions

| Permission | Admin | Manager | Member | Viewer |
|-----------|-------|---------|--------|--------|
| View shared calendars | ✓ | ✓ | ✓ | ✓ |
| Create events | ✓ | ✓ | ✓ | ✗ |
| Edit any event | ✓ | ✓ | Own/organizer only | ✗ |
| Create team calendars | ✓ | ✓ | ✗ | ✗ |
| Create booking pages | ✓ | ✓ | ✓ | ✗ |
| Configure external sync | ✓ | ✓ | Own only | ✗ |
| View other users' availability | ✓ | ✓ | ✓ | ✓ |
| View event details on others' calendars | ✓ | ✓ | Titles only | ✗ |
