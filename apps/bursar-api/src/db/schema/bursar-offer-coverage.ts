import {
  pgTable,
  uuid,
  varchar,
  numeric,
  bigint,
  boolean,
  jsonb,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bursarOffers } from './bursar-offers.js';
import { bursarScopeNodes } from './bursar-scope-nodes.js';
import { bursarLevelingRuns } from './bursar-leveling-runs.js';

/**
 * Per-(offer, node) coverage adjudication (spec 6.1, migration 0248). verdict is one of six;
 * decided_by is deterministic/llm/human with NO 'agent' value in v1. The absent CHECK
 * (verdict <> 'absent' OR decided_by = 'human' OR jsonb_array_length(rejected_candidates) > 0)
 * lives in the migration. subsumed_by_coverage_id is a guarded self-FK declared in the
 * migration. Unique (organization_id, offer_id, scope_node_id).
 */
export const bursarOfferCoverage = pgTable(
  'bursar_offer_coverage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    offer_id: uuid('offer_id')
      .notNull()
      .references(() => bursarOffers.id, { onDelete: 'cascade' }),
    scope_node_id: uuid('scope_node_id')
      .notNull()
      .references(() => bursarScopeNodes.id, { onDelete: 'restrict' }),
    leveling_run_id: uuid('leveling_run_id').references(() => bursarLevelingRuns.id, { onDelete: 'set null' }),
    // covered | partial | excluded_explicit | absent | ambiguous | not_applicable
    verdict: varchar('verdict', { length: 24 }).notNull(),
    // deterministic | llm | human (NO 'agent' in v1)
    decided_by: varchar('decided_by', { length: 16 }).notNull().default('deterministic'),
    matched_line_ids: uuid('matched_line_ids').array().notNull().default([]),
    cited_span: jsonb('cited_span').notNull().default({}),
    rejected_candidates: jsonb('rejected_candidates').notNull().default([]),
    node_term_overlap: numeric('node_term_overlap', { precision: 5, scale: 4 }),
    classifier_confidence: numeric('classifier_confidence', { precision: 5, scale: 4 }),
    composite_confidence: numeric('composite_confidence', { precision: 5, scale: 4 }),
    confidence_band: varchar('confidence_band', { length: 16 }),
    review_status: varchar('review_status', { length: 16 }).notNull().default('pending_review'),
    withheld_reason: varchar('withheld_reason', { length: 24 }),
    provisional: boolean('provisional').notNull().default(false),
    blanket_suspected: boolean('blanket_suspected').notNull().default(false),
    window_coverage: numeric('window_coverage', { precision: 5, scale: 4 }),
    subsumed_by_coverage_id: uuid('subsumed_by_coverage_id'),
    derived_covered: boolean('derived_covered').notNull().default(false),
    delta_kind: varchar('delta_kind', { length: 24 }),
    delta_quantity: numeric('delta_quantity', { precision: 18, scale: 4 }),
    delta_unit: varchar('delta_unit', { length: 32 }),
    delta_amount_minor: bigint('delta_amount_minor', { mode: 'number' }),
    priced_amount_minor: bigint('priced_amount_minor', { mode: 'number' }),
    overridden_by: uuid('overridden_by').references(() => users.id, { onDelete: 'set null' }),
    overridden_at: timestamp('overridden_at', { withTimezone: true }),
    overridden_reason: text('overridden_reason'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_offer_coverage_unique').on(
      table.organization_id,
      table.offer_id,
      table.scope_node_id,
    ),
    index('idx_bursar_offer_coverage_offer').on(table.organization_id, table.offer_id),
    index('idx_bursar_offer_coverage_node').on(table.organization_id, table.scope_node_id),
    index('idx_bursar_offer_coverage_verdict').on(table.organization_id, table.offer_id, table.verdict),
  ],
);
