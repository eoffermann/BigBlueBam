import { pgTable, uuid, varchar, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

/**
 * Durable event inbox (spec 6.1, 16.2, migration 0250). Like burn_ingest_events it has claim
 * + heartbeat columns: rows are CLAIMED (never bare-selected) because the drain is both
 * event-driven and scheduled. The reaper scan index is per org. Unique
 * (organization_id, source_idempotency_key).
 */
export const bursarIngestEvents = pgTable(
  'bursar_ingest_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    source_idempotency_key: varchar('source_idempotency_key', { length: 128 }).notNull(),
    bolt_event_id: uuid('bolt_event_id'),
    source: varchar('source', { length: 48 }).notNull(),
    event_type: varchar('event_type', { length: 96 }).notNull(),
    scope_fields: jsonb('scope_fields').notNull().default({}),
    occurred_at: timestamp('occurred_at', { withTimezone: true }),
    logged_at: timestamp('logged_at', { withTimezone: true }),
    // pending | claimed | processed | skipped
    status: varchar('status', { length: 12 }).notNull().default('pending'),
    claimed_by: varchar('claimed_by', { length: 64 }),
    claimed_at: timestamp('claimed_at', { withTimezone: true }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    received_at: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processed_at: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('idx_bursar_ingest_events_idem').on(table.organization_id, table.source_idempotency_key),
    index('idx_bursar_ingest_events_pending').on(table.organization_id, table.status, table.received_at),
    index('idx_bursar_ingest_events_source_type').on(table.source, table.event_type),
  ],
);
