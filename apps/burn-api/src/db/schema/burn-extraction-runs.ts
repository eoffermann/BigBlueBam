import { pgTable, uuid, varchar, integer, bigint, text, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { burnEngagements } from './burn-engagements.js';

/**
 * Deliverable-extraction audit and chunk checkpoint (spec 3.1 / 4.1). Never purged.
 *
 * A retry resumes at `last_processed_chunk + 1` rather than restarting at chunk zero,
 * which is what makes the "no HTTP inside a lock-holding transaction" rule survivable:
 * `burn-extract-deliverables` commits each chunk checkpoint in its own transaction and
 * holds no advisory lock across the llm-provider call (spec 4.0, R3-T1).
 *
 * `doc_bytes` / `doc_pages` record what the bounded, inert parser actually saw; a breach
 * of MAX_DOC_BYTES / MAX_DOC_PAGES records status `rejected_limits` and extracts nothing
 * partial (spec 2.4 point 15).
 */
export const burnExtractionRuns = pgTable(
  'burn_extraction_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    engagement_id: uuid('engagement_id')
      .notNull()
      .references(() => burnEngagements.id, { onDelete: 'cascade' }),
    // running | succeeded | partial | failed | rejected_limits
    status: varchar('status', { length: 16 }).notNull().default('running'),
    chunk_count: integer('chunk_count'),
    last_processed_chunk: integer('last_processed_chunk').notNull().default(-1),
    source_doc_hash: varchar('source_doc_hash', { length: 64 }),
    doc_bytes: bigint('doc_bytes', { mode: 'number' }),
    doc_pages: integer('doc_pages'),
    deliverables_extracted: integer('deliverables_extracted').notNull().default(0),
    low_confidence_count: integer('low_confidence_count').notNull().default(0),
    provider_id: uuid('provider_id'),
    error: text('error'),
    started_at: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_burn_extraction_runs_engagement').on(
      table.organization_id,
      table.engagement_id,
      table.started_at,
    ),
    index('idx_burn_extraction_runs_status').on(table.status),
  ],
);
