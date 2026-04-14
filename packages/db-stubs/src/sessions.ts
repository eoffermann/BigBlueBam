import { pgTable, text, uuid, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { organizations } from './organizations.js';

/**
 * Canonical mirror of apps/api/src/db/schema/sessions.ts.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    data: jsonb('data').default({}).notNull(),
    active_org_id: uuid('active_org_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.user_id),
    index('sessions_expires_at_idx').on(table.expires_at),
    index('sessions_active_org_id_idx').on(table.active_org_id),
  ],
);
