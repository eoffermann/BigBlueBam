// Mirrors bastion_outbox as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

export const bastionOutbox = pgTable(
  'bastion_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 24 }).notNull(),
    ordering_key: varchar('ordering_key', { length: 160 }).notNull(),
    idempotency_key: varchar('idempotency_key', { length: 256 }).notNull(),
    payload: jsonb('payload').default({}).notNull(),
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    redrive_count: integer('redrive_count').default(0).notNull(),
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }),
    last_error: text('last_error'),
    claimed_by: varchar('claimed_by', { length: 128 }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    delivered_at: timestamp('delivered_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
