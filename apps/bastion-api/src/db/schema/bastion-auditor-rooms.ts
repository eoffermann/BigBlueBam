// Mirrors bastion_auditor_rooms as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { date, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionFrameworks } from './bastion-frameworks.js';
import { organizations, users } from './bbb-refs.js';

export const bastionAuditorRooms = pgTable(
  'bastion_auditor_rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    framework_id: uuid('framework_id').references(() => bastionFrameworks.id, { onDelete: 'set null' }),
    label: varchar('label', { length: 256 }).notNull(),
    token_sha256: varchar('token_sha256', { length: 64 }).notNull(),
    token_hint: varchar('token_hint', { length: 16 }),
    passcode_hash: text('passcode_hash'),
    passcode_failures: integer('passcode_failures').default(0).notNull(),
    locked_at: timestamp('locked_at', { withTimezone: true }),
    unlocked_by: uuid('unlocked_by').references(() => users.id, { onDelete: 'set null' }),
    unlocked_at: timestamp('unlocked_at', { withTimezone: true }),
    period_start: date('period_start'),
    period_end: date('period_end'),
    control_ids: uuid('control_ids').array().default([]).notNull(),
    restricted_evidence_ids: uuid('restricted_evidence_ids').array().default([]).notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    last_accessed_at: timestamp('last_accessed_at', { withTimezone: true }),
    access_count: integer('access_count').default(0).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
