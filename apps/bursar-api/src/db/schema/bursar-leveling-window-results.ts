import { pgTable, uuid, varchar, integer, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bursarLevelingRuns } from './bursar-leveling-runs.js';
import { bursarOffers } from './bursar-offers.js';
import { bursarScopeNodes } from './bursar-scope-nodes.js';

/**
 * Durable per-window leveling verdicts (spec 6.1, migration 0248), so a resumed run does not
 * recompute a settled window. Unique on all five of
 * (leveling_run_id, offer_id, scope_node_id, window_index, verdict).
 */
export const bursarLevelingWindowResults = pgTable(
  'bursar_leveling_window_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leveling_run_id: uuid('leveling_run_id')
      .notNull()
      .references(() => bursarLevelingRuns.id, { onDelete: 'cascade' }),
    offer_id: uuid('offer_id')
      .notNull()
      .references(() => bursarOffers.id, { onDelete: 'cascade' }),
    scope_node_id: uuid('scope_node_id')
      .notNull()
      .references(() => bursarScopeNodes.id, { onDelete: 'restrict' }),
    window_index: integer('window_index').notNull(),
    verdict: varchar('verdict', { length: 24 }).notNull(),
    cited_span: jsonb('cited_span').notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_leveling_window_results_unique').on(
      table.leveling_run_id,
      table.offer_id,
      table.scope_node_id,
      table.window_index,
      table.verdict,
    ),
    index('idx_bursar_leveling_window_results_run').on(table.organization_id, table.leveling_run_id),
  ],
);
