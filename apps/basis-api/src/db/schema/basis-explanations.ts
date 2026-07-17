import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { basisMetrics } from './basis-metrics.js';

// Cached DETERMINISTIC driver decomposition only. Per-viewer correlation is
// never stored here (spec 2.1). Class-B rows store opaque uuids + amounts that
// are never served raw; read-time filtering drops denied rows into "Other".
export const basisExplanations = pgTable(
  'basis_explanations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    metric_id: uuid('metric_id')
      .notNull()
      .references(() => basisMetrics.id, { onDelete: 'cascade' }),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    version_id: uuid('version_id').notNull(),
    cache_key: varchar('cache_key', { length: 64 }).notNull(),
    period_a: jsonb('period_a').notNull(),
    period_b: jsonb('period_b').notNull(),
    dimension: varchar('dimension', { length: 80 }),
    dimension_class: varchar('dimension_class', { length: 1 }),
    delta_abs: numeric('delta_abs'),
    delta_pct: numeric('delta_pct'),
    drivers: jsonb('drivers').notNull(),
    narrative: text('narrative'),
    model: varchar('model', { length: 60 }),
    computed_at: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_basis_explanations_cache_key').on(table.cache_key),
    index('idx_basis_explanations_metric_computed').on(table.metric_id, table.computed_at),
  ],
);
