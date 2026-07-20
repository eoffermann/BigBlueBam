import { pgTable, uuid, varchar, integer, text, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bursarRequests } from './bursar-requests.js';

/**
 * Scope-extraction run audit (spec 6.1, migration 0247). status covers blocked (injection)
 * and rejected_limits (cap exceeded). heartbeat_at + claimed_by are the reclaim lease;
 * last_processed_chunk resumes a retry.
 */
export const bursarExtractionRuns = pgTable(
  'bursar_extraction_runs',
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
    chunk_count: integer('chunk_count'),
    last_processed_chunk: integer('last_processed_chunk').notNull().default(-1),
    chunks_failed: integer('chunks_failed').notNull().default(0),
    nodes_extracted: integer('nodes_extracted').notNull().default(0),
    low_confidence_count: integer('low_confidence_count').notNull().default(0),
    llm_calls_used: integer('llm_calls_used').notNull().default(0),
    source_doc_hash: varchar('source_doc_hash', { length: 64 }),
    provider_id: uuid('provider_id'),
    claimed_by: varchar('claimed_by', { length: 64 }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    error: text('error'),
    started_at: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_bursar_extraction_runs_request').on(table.organization_id, table.request_id, table.started_at),
    index('idx_bursar_extraction_runs_status').on(table.organization_id, table.status),
  ],
);
