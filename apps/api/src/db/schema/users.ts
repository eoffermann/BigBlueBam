import { pgTable, pgEnum, uuid, varchar, text, jsonb, timestamp, boolean, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';

/**
 * Agent-identity actor type (AGENTIC_TODO §10, migration 0127). Distinguishes
 * human users from agent runtimes from service accounts without relying on
 * email-pattern inference. Mirrored onto activity_log.actor_type so auditors
 * can filter mutations by actor kind.
 */
export const actorTypeEnum = pgEnum('actor_type', ['human', 'agent', 'service']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).unique().notNull(),
    display_name: varchar('display_name', { length: 100 }).notNull(),
    avatar_url: text('avatar_url'),
    password_hash: text('password_hash'),
    // Wave E.F: users.role was dropped in migration 0159. The per-org role
    // is resolved from account_group_memberships → permission_groups.legacy_role
    // with scope_type='org' and scope_id=<org_id>. See services/role-resolver.ts.
    timezone: varchar('timezone', { length: 50 }).default('UTC').notNull(),
    notification_prefs: jsonb('notification_prefs').default({}).notNull(),
    is_active: boolean('is_active').default(true).notNull(),
    is_superuser: boolean('is_superuser').default(false).notNull(),
    kind: actorTypeEnum('kind').default('human').notNull(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }),
    disabled_at: timestamp('disabled_at', { withTimezone: true }),
    disabled_by: uuid('disabled_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    created_by: uuid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    email_verified: boolean('email_verified').default(true).notNull(),
    pending_email: varchar('pending_email', { length: 320 }),
    email_verification_token: text('email_verification_token'),
    email_verification_sent_at: timestamp('email_verification_sent_at', { withTimezone: true }),
    force_password_change: boolean('force_password_change').default(false).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('users_org_id_idx').on(table.org_id),
    index('users_email_idx').on(table.email),
    index('users_kind_idx').on(table.kind),
  ],
);
