// Mirrors bastion_audit_log as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

export const bastionAuditLog = pgTable(
  'bastion_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    actor_id: uuid('actor_id'),
    actor_kind: varchar('actor_kind', { length: 16 }),
    impersonator_id: uuid('impersonator_id'),
    action: varchar('action', { length: 96 }).notNull(),
    subject_type: varchar('subject_type', { length: 48 }),
    subject_id: uuid('subject_id'),
    details: jsonb('details').default({}).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
