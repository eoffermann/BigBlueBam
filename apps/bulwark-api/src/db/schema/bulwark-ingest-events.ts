import { pgTable, uuid, varchar, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

// The durable event inbox (spec 3.1, THEME D). Every event bolt-api dispatches is
// persisted here before firing. source_idempotency_key is the INBOX redelivery dedup atom
// ONLY, decoupled from the deterministic arm key (STK1). Highest-churn table; the first
// candidate for monthly partitioning (ST9 / IN6). scope_fields carries only uuid-shaped,
// entity_filter-referenced id fields (SM1).
export const bulwarkIngestEvents = pgTable(
  'bulwark_ingest_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    source_idempotency_key: varchar('source_idempotency_key', { length: 128 }).notNull(),
    bolt_event_id: uuid('bolt_event_id'),
    source: varchar('source', { length: 48 }).notNull(),
    event_type: varchar('event_type', { length: 96 }).notNull(),
    logged_at: timestamp('logged_at', { withTimezone: true }).notNull(),
    trigger_at: timestamp('trigger_at', { withTimezone: true }),
    scope_fields: jsonb('scope_fields').notNull().default('{}'),
    status: varchar('status', { length: 12 }).notNull().default('pending'),
    received_at: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processed_at: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('idx_bulwark_ingest_events_idem').on(
      table.organization_id,
      table.source_idempotency_key,
    ),
    index('idx_bulwark_ingest_events_pending').on(
      table.organization_id,
      table.status,
      table.received_at,
    ),
    index('idx_bulwark_ingest_events_source_type').on(table.source, table.event_type),
  ],
);
