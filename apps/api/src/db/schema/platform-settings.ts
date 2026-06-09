import { pgTable, integer, boolean, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Singleton row (id=1, enforced by a CHECK constraint in the migration) that
 * holds platform-wide toggles visible only to SuperUsers. Two switches today:
 *
 *  - `public_signup_disabled` — when true, the Bam (B3) register endpoint
 *    rejects new account creation and the login-page "Create one" link
 *    redirects users to a beta-gate page. Used during limited beta.
 *
 *  - `helpdesk_signup_disabled` — when true, the Helpdesk customer-signup
 *    endpoint rejects new account creation. Decoupled from the Bam flag
 *    (migration 0172) so closing internal signup doesn't simultaneously
 *    block legitimate customers from filing tickets.
 */
export const platformSettings = pgTable('platform_settings', {
  id: integer('id').primaryKey().default(1),
  public_signup_disabled: boolean('public_signup_disabled').notNull().default(false),
  helpdesk_signup_disabled: boolean('helpdesk_signup_disabled').notNull().default(false),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

export type PlatformSettings = typeof platformSettings.$inferSelect;
