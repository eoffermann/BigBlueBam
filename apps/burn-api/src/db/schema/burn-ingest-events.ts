import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

/**
 * The durable event inbox (spec 3.1 / 8.3).
 *
 * `source_idempotency_key` is the payload `_event_id` when present
 * (`apps/bolt-api/src/routes/event-ingestion.routes.ts:230`), else the bolt event id.
 *
 * WHY THIS HAS CLAIM COLUMNS AND `bulwark_ingest_events` DOES NOT.
 * `bulwark_ingest_events` (0234_bulwark_core.sql:123-136) has only `status pending|processed`
 * and no claim column. It survives that shape solely because its sweeps run at
 * `concurrency: 1` under a lock. Burn's batch is BOTH event-driven AND scheduled, so two
 * drains can legitimately observe the same pending row. Rows are therefore CLAIMED:
 *   UPDATE ... SET status='claimed', claimed_by, claimed_at WHERE status='pending' ...
 *   RETURNING     (or SELECT ... FOR UPDATE SKIP LOCKED)
 * never a bare SELECT.
 *
 * `claimed_at` is HEARTBEATED by the holding drain (R2-T9) at `claim_lease_seconds / 3`, so
 * the reaper reclaims only genuinely cold rows rather than yanking work out from under a
 * batch that is merely slow.
 *
 * The reaper scan index is deliberately PER ORG, not global (spec 2.4 point 14). Under
 * `BBB_RLS_ENFORCE=1` a global scan on `(status, claimed_at)` with no GUC set returns ZERO
 * rows, so expired claims would never be released and `burn-attribute-batch` would
 * permanently stop draining for any org whose worker died mid-claim. `burn-claim-reaper`
 * iterates orgs, taking the per-org lock and setting the GUC per org.
 *
 * `scope_fields` is id-typed and uuid-validated on write; non-conforming values are dropped
 * rather than stored.
 */
export const burnIngestEvents = pgTable(
  'burn_ingest_events',
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
    // Worker instance id.
    claimed_by: varchar('claimed_by', { length: 64 }),
    claimed_at: timestamp('claimed_at', { withTimezone: true }),
    received_at: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processed_at: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('idx_burn_ingest_events_idem').on(
      table.organization_id,
      table.source_idempotency_key,
    ),
    index('idx_burn_ingest_events_pending').on(
      table.organization_id,
      table.status,
      table.received_at,
    ),
    index('idx_burn_ingest_events_source_type').on(table.source, table.event_type),
  ],
);
