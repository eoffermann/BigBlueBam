import { pgTable, uuid, text, inet, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const loginHistory = pgTable(
  'login_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    email: text('email').notNull(),
    ip_address: inet('ip_address'),
    user_agent: text('user_agent'),
    success: boolean('success').notNull(),
    failure_reason: text('failure_reason'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_login_history_user_time').on(table.user_id, table.created_at),
    index('idx_login_history_email_time').on(table.email, table.created_at),
  ],
);
