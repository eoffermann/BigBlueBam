// Mirrors bastion_evidence_objects as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, integer, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

export const bastionEvidenceObjects = pgTable(
  'bastion_evidence_objects',
  {
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    content_sha256: varchar('content_sha256', { length: 64 }).notNull(),
    object_key: varchar('object_key', { length: 512 }).notNull(),
    size_bytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    content_type: varchar('content_type', { length: 255 }),
    holder_count: integer('holder_count').default(0).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    bytes_redacted_at: timestamp('bytes_redacted_at', { withTimezone: true }),
    mirrored_at: timestamp('mirrored_at', { withTimezone: true }),
    // Per-object mirror failures, so one object cannot block the rest (0317, #332).
    mirror_attempts: integer('mirror_attempts').default(0).notNull(),
    mirror_last_error: varchar('mirror_last_error', { length: 500 }),
    mirror_last_attempt_at: timestamp('mirror_last_attempt_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.organization_id, table.content_sha256] })],
);
