import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { users } from './users.js';

export const guestInvitations = pgTable(
  'guest_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    invited_by: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'set null' }),
    email: varchar('email', { length: 320 }).notNull(),
    role: varchar('role', { length: 20 }).default('guest').notNull(),
    project_ids: text('project_ids').array(), // uuid[] stored as text[]
    channel_ids: text('channel_ids').array(), // banter channel ids stored as text[]
    token: varchar('token', { length: 100 }).unique().notNull(),
    accepted_at: timestamp('accepted_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('guest_invitations_org_id_idx').on(table.org_id),
    index('guest_invitations_email_idx').on(table.email),
    index('guest_invitations_token_idx').on(table.token),
  ],
);
