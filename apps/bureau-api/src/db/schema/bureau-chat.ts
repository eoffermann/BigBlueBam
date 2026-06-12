/**
 * Bureau room chat — mirrors infra/postgres/migrations/0187_bureau_chat.sql.
 *
 * Ephemeral-by-default text chat scoped to a Bureau room identity (the
 * same surface id presence/calls use, or a spatial room id). Messages
 * carry their own expires_at (computed from the room's retention policy
 * at insert time); reads filter expired rows so the worker sweep is
 * cleanup, not enforcement.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { organizations, users } from '@bigbluebam/db-stubs';

export const bureauChatRooms = pgTable(
  'bureau_chat_rooms',
  {
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    room_key: varchar('room_key', { length: 160 }).notNull(),
    label: text('label'),
    app: varchar('app', { length: 40 }),
    retention_hours: integer('retention_hours').notNull().default(24),
    retain_forever: boolean('retain_forever').notNull().default(false),
    last_message_at: timestamp('last_message_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.org_id, t.room_key] })],
);

export const bureauChatMessages = pgTable(
  'bureau_chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    room_key: varchar('room_key', { length: 160 }).notNull(),
    author_id: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    author_name: text('author_name').notNull(),
    body: text('body').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    index('bureau_chat_messages_room_idx').on(t.org_id, t.room_key, t.created_at),
    index('bureau_chat_messages_expiry_idx').on(t.expires_at),
  ],
);

export const bureauChatParticipants = pgTable(
  'bureau_chat_participants',
  {
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    room_key: varchar('room_key', { length: 160 }).notNull(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    first_seen_at: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.org_id, t.room_key, t.user_id] }),
    index('bureau_chat_participants_user_idx').on(t.user_id, t.last_seen_at),
  ],
);
