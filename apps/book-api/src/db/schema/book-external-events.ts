import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';
import { bookExternalConnections } from './book-external-connections.js';
import { bookEvents } from './book-events.js';

export const bookExternalEvents = pgTable(
  'book_external_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connection_id: uuid('connection_id')
      .notNull()
      .references(() => bookExternalConnections.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    external_event_id: varchar('external_event_id', { length: 255 }).notNull(),
    title: varchar('title', { length: 500 }),
    start_at: timestamp('start_at', { withTimezone: true }).notNull(),
    end_at: timestamp('end_at', { withTimezone: true }).notNull(),
    all_day: boolean('all_day').notNull().default(false),
    visibility: varchar('visibility', { length: 20 }).notNull().default('busy'),
    // The mirrored book_events row this external event maps to (0199). Lets a
    // re-sync update in place and a disconnect clean up the mirror.
    book_event_id: uuid('book_event_id').references(() => bookEvents.id, {
      onDelete: 'set null',
    }),
    synced_at: timestamp('synced_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('book_ext_events_conn_ext_idx').on(table.connection_id, table.external_event_id),
    index('idx_book_ext_events_user').on(table.user_id, table.start_at, table.end_at),
    index('idx_book_ext_events_book_event').on(table.book_event_id),
  ],
);
