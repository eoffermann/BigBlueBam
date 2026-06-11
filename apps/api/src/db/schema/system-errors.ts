/**
 * Drizzle schema for the system_errors table (migration 0181). Every
 * service that runs the shared @bigbluebam/logging error handler writes
 * a row here on 5xx so the SuperUser Console's Log Analysis tab has a
 * single place to surface app-wide errors.
 */

import { pgTable, uuid, varchar, integer, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { organizations } from './organizations.js';

export const systemErrors = pgTable('system_errors', {
  id: uuid('id').primaryKey().defaultRandom(),
  service: varchar('service', { length: 40 }).notNull(),
  request_id: varchar('request_id', { length: 80 }),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  org_id: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  method: varchar('method', { length: 10 }),
  route: varchar('route', { length: 255 }),
  status_code: integer('status_code'),
  error_code: varchar('error_code', { length: 80 }),
  message: text('message').notNull(),
  stack: text('stack'),
  payload: jsonb('payload').notNull().default('{}'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
