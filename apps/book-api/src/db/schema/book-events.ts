import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bookCalendars } from './book-calendars.js';
import { bookBookingPages } from './book-booking-pages.js';

export const bookEvents = pgTable(
  'book_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    calendar_id: uuid('calendar_id')
      .notNull()
      .references(() => bookCalendars.id, { onDelete: 'cascade' }),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description'),
    location: text('location'),
    meeting_url: text('meeting_url'),
    /**
     * Canonical LiveKit room for this event (D-4). Book-native events get
     * `huddle-book-{eventId}` (joined by the Bureau docked box when anyone
     * opens /book/events/{id}); Bureau room reservations carry
     * `bureau-room-{roomId}`. Null when the organizer supplied an external
     * meeting_url (Zoom et al.) — we don't double-book a room for those.
     */
    livekit_room_name: text('livekit_room_name'),
    start_at: timestamp('start_at', { withTimezone: true }).notNull(),
    end_at: timestamp('end_at', { withTimezone: true }).notNull(),
    all_day: boolean('all_day').notNull().default(false),
    timezone: varchar('timezone', { length: 50 }).notNull().default('UTC'),
    recurrence_rule: varchar('recurrence_rule', { length: 30 }),
    recurrence_end_at: timestamp('recurrence_end_at', { withTimezone: true }),
    recurrence_parent_id: uuid('recurrence_parent_id'),
    status: varchar('status', { length: 20 }).notNull().default('confirmed'),
    visibility: varchar('visibility', { length: 20 }).notNull().default('busy'),
    linked_entity_type: varchar('linked_entity_type', { length: 20 }),
    linked_entity_id: uuid('linked_entity_id'),
    booking_page_id: uuid('booking_page_id').references(() => bookBookingPages.id, {
      onDelete: 'set null',
    }),
    booked_by_name: varchar('booked_by_name', { length: 200 }),
    booked_by_email: varchar('booked_by_email', { length: 255 }),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_book_events_calendar').on(table.calendar_id),
    index('idx_book_events_org').on(table.organization_id),
    index('idx_book_events_time').on(table.start_at, table.end_at),
    index('idx_book_events_recurrence').on(table.recurrence_parent_id),
  ],
);
