import { pgTable, uuid, varchar, numeric, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bursarOfferLines } from './bursar-offer-lines.js';
import { bursarScopeNodes } from './bursar-scope-nodes.js';
import { bursarOfferCoverage } from './bursar-offer-coverage.js';

/**
 * Line-to-node allocation matches (spec 6.1, migration 0248). Both section 4.3 caps are
 * computed from this table. allocation_weight is numeric(6,5); weights per line sum to 1.0.
 * Unique (organization_id, offer_line_id, scope_node_id).
 */
export const bursarLineNodeMatches = pgTable(
  'bursar_line_node_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    offer_line_id: uuid('offer_line_id')
      .notNull()
      .references(() => bursarOfferLines.id, { onDelete: 'cascade' }),
    scope_node_id: uuid('scope_node_id')
      .notNull()
      .references(() => bursarScopeNodes.id, { onDelete: 'restrict' }),
    coverage_id: uuid('coverage_id').references(() => bursarOfferCoverage.id, { onDelete: 'set null' }),
    allocation_weight: numeric('allocation_weight', { precision: 6, scale: 5 }).notNull().default('1.00000'),
    allocation_method: varchar('allocation_method', { length: 24 }),
    match_method: varchar('match_method', { length: 24 }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_line_node_matches_unique').on(
      table.organization_id,
      table.offer_line_id,
      table.scope_node_id,
    ),
    index('idx_bursar_line_node_matches_line').on(table.organization_id, table.offer_line_id),
    index('idx_bursar_line_node_matches_node').on(table.organization_id, table.scope_node_id),
    index('idx_bursar_line_node_matches_coverage').on(table.coverage_id),
  ],
);
