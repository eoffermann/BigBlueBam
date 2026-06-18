import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';
import { bookCalendars } from './book-calendars.js';

export const bookExternalConnections = pgTable(
  'book_external_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 'ics' | 'google' | 'microsoft'. ICS is the no-secret provider; the other
    // two are slots that activate only when operator OAuth creds are present.
    provider: varchar('provider', { length: 20 }).notNull(),
    // Human-friendly label shown in the Connections list.
    name: varchar('name', { length: 255 }),
    // Target Book calendar inbound events are mirrored into (0199). Nullable:
    // the sync engine lazily picks/provisions one when absent.
    calendar_id: uuid('calendar_id').references(() => bookCalendars.id, {
      onDelete: 'set null',
    }),
    // For provider='ics': the .ics feed URL. NULL for OAuth providers.
    feed_url: text('feed_url'),
    // OAuth tokens (Google/Microsoft). Nullable since 0199 — ICS carries none.
    access_token: text('access_token'),
    refresh_token: text('refresh_token'),
    token_expires_at: timestamp('token_expires_at', { withTimezone: true }),
    external_calendar_id: varchar('external_calendar_id', { length: 255 }).notNull(),
    sync_direction: varchar('sync_direction', { length: 10 }).notNull().default('both'),
    last_sync_at: timestamp('last_sync_at', { withTimezone: true }),
    last_sync_event_count: integer('last_sync_event_count').notNull().default(0),
    sync_status: varchar('sync_status', { length: 20 }).notNull().default('active'),
    sync_error: text('sync_error'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_book_ext_user').on(table.user_id)],
);
