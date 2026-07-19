import { pgTable, uuid, varchar, integer, text, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bulwarkContracts } from './bulwark-contracts.js';

// Extraction audit + chunk checkpoint (spec 3.1 / ST6). Never purged (audit). A retry
// resumes at last_processed_chunk + 1.
export const bulwarkExtractionRuns = pgTable(
  'bulwark_extraction_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contract_id: uuid('contract_id')
      .notNull()
      .references(() => bulwarkContracts.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 }).notNull().default('running'),
    chunk_count: integer('chunk_count'),
    last_processed_chunk: integer('last_processed_chunk').notNull().default(-1),
    source_doc_hash: varchar('source_doc_hash', { length: 64 }),
    obligations_extracted: integer('obligations_extracted').notNull().default(0),
    low_confidence_count: integer('low_confidence_count').notNull().default(0),
    provider_id: uuid('provider_id'),
    error: text('error'),
    started_at: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_bulwark_extraction_runs_contract').on(
      table.organization_id,
      table.contract_id,
      table.started_at,
    ),
    index('idx_bulwark_extraction_runs_status').on(table.status),
  ],
);
