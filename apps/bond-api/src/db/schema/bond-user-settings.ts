import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';

/**
 * Per-user Bond preferences. Currently just the reply-to email used when Bond
 * reaches out to a client on the user's behalf (e.g. the default reply-to for a
 * Blast campaign), so client replies land in a monitored inbox. One row per
 * user; absent row means "no reply-to configured".
 */
export const bondUserSettings = pgTable('bond_user_settings', {
  user_id: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  reply_to_email: varchar('reply_to_email', { length: 255 }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
