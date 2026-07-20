import { pgTable, uuid, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bursarBaselineItems } from './bursar-baseline-items.js';
import { bursarScopeNodes } from './bursar-scope-nodes.js';

/**
 * Links a frozen baseline item to the scope node(s) it covered at award (spec 6.1, migration
 * 0249). Unique (organization_id, baseline_item_id, scope_node_id).
 */
export const bursarBaselineItemNodes = pgTable(
  'bursar_baseline_item_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    baseline_item_id: uuid('baseline_item_id')
      .notNull()
      .references(() => bursarBaselineItems.id, { onDelete: 'cascade' }),
    scope_node_id: uuid('scope_node_id')
      .notNull()
      .references(() => bursarScopeNodes.id, { onDelete: 'restrict' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_baseline_item_nodes_unique').on(
      table.organization_id,
      table.baseline_item_id,
      table.scope_node_id,
    ),
    index('idx_bursar_baseline_item_nodes_node').on(table.organization_id, table.scope_node_id),
  ],
);
