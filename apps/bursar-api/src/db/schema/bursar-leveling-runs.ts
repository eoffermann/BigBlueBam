import { pgTable, uuid, varchar, integer, jsonb, text, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bursarRequests } from './bursar-requests.js';

/**
 * Leveling-run checkpoint (spec 6.1, migration 0248). The 3-D resume cursor
 * (last_processed_offer_index / node_index / window_index) lets a reclaimed run resume rather
 * than restart. heartbeat_at + claimed_by are the lease.
 */
export const bursarLevelingRuns = pgTable(
  'bursar_leveling_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    request_id: uuid('request_id')
      .notNull()
      .references(() => bursarRequests.id, { onDelete: 'cascade' }),
    // running | succeeded | partial | failed | blocked | rejected_limits
    status: varchar('status', { length: 16 }).notNull().default('running'),
    last_processed_offer_index: integer('last_processed_offer_index').notNull().default(-1),
    last_processed_node_index: integer('last_processed_node_index').notNull().default(-1),
    last_processed_window_index: integer('last_processed_window_index').notNull().default(-1),
    offer_count: integer('offer_count'),
    node_count: integer('node_count'),
    llm_calls_used: integer('llm_calls_used').notNull().default(0),
    coverage_written: integer('coverage_written').notNull().default(0),
    // The per-run caps enforced, persisted as used for audit (spec 3.9, migration 0255).
    caps_used: jsonb('caps_used').notNull().default({}),
    claimed_by: varchar('claimed_by', { length: 64 }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    error: text('error'),
    started_at: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_bursar_leveling_runs_request').on(table.organization_id, table.request_id, table.started_at),
  ],
);
