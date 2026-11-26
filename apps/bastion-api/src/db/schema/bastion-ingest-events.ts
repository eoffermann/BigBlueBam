// Mirrors bastion_ingest_events as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

export const bastionIngestEvents = pgTable(
  'bastion_ingest_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    source: varchar('source', { length: 32 }).notNull(),
    event_type: varchar('event_type', { length: 128 }).notNull(),
    source_idempotency_key: varchar('source_idempotency_key', { length: 256 }).notNull(),
    payload: jsonb('payload').default({}).notNull(),
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    claimed_by: varchar('claimed_by', { length: 128 }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    attempts: integer('attempts').default(0).notNull(),
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }),
    last_error: text('last_error'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
