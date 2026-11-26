// Mirrors bastion_export_packets as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, boolean, date, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionFrameworks } from './bastion-frameworks.js';
import { organizations, users } from './bbb-refs.js';

export const bastionExportPackets = pgTable(
  'bastion_export_packets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    framework_id: uuid('framework_id').references(() => bastionFrameworks.id, { onDelete: 'set null' }),
    period_start: date('period_start'),
    period_end: date('period_end'),
    include_restricted: boolean('include_restricted').default(false).notNull(),
    status: varchar('status', { length: 16 }).default('queued').notNull(),
    stage: varchar('stage', { length: 32 }),
    stage_progress: integer('stage_progress').default(0).notNull(),
    object_key: varchar('object_key', { length: 512 }),
    content_sha256: varchar('content_sha256', { length: 64 }),
    size_bytes: bigint('size_bytes', { mode: 'number' }),
    requested_by: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    claimed_by: varchar('claimed_by', { length: 128 }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
