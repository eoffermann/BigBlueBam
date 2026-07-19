import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  numeric,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bulwarkContracts } from './bulwark-contracts.js';
import { bulwarkExtractionRuns } from './bulwark-extraction-runs.js';

// One typed, clause-cited obligation (spec 3.1). dedup_key is the stable per-obligation
// upsert/supersession key (DI1/DI2/DK1), free of non-deterministic LLM prose; clause_ref is
// EVIDENCE only. supersedes_obligation_id is a self-FK declared in the migration (0234) via
// a guarded DO $$ block, not here, to avoid a circular self-reference in Drizzle. The GIN
// index on event_binding and the partial WHERE-is_armed index live in the migration only.
export const bulwarkObligations = pgTable(
  'bulwark_obligations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contract_id: uuid('contract_id')
      .notNull()
      .references(() => bulwarkContracts.id, { onDelete: 'cascade' }),
    clause_ref: varchar('clause_ref', { length: 64 }),
    dedup_key: varchar('dedup_key', { length: 64 }).notNull(),
    supersedes_obligation_id: uuid('supersedes_obligation_id'),
    obligation_type: varchar('obligation_type', { length: 32 }).notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    trigger_description: text('trigger_description'),
    event_binding: jsonb('event_binding').notNull().default('{}'),
    deadline_rule: jsonb('deadline_rule').notNull().default('{}'),
    mandated_doc_types: jsonb('mandated_doc_types').notNull().default('[]'),
    cited_span: jsonb('cited_span').notNull().default('{}'),
    confidence: numeric('confidence', { precision: 5, scale: 2 }),
    review_status: varchar('review_status', { length: 16 }).notNull().default('pending_review'),
    is_armed: boolean('is_armed').notNull().default(false),
    reviewed_by: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
    extraction_run_id: uuid('extraction_run_id').references(() => bulwarkExtractionRuns.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bulwark_obligations_dedup').on(
      table.organization_id,
      table.contract_id,
      table.dedup_key,
    ),
    index('idx_bulwark_obligations_org_contract').on(table.organization_id, table.contract_id),
    index('idx_bulwark_obligations_org_review').on(table.organization_id, table.review_status),
    index('idx_bulwark_obligations_org_type').on(table.organization_id, table.obligation_type),
    index('idx_bulwark_obligations_supersedes').on(table.supersedes_obligation_id),
  ],
);
