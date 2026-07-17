import {
  pgTable,
  uuid,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { basisMetrics } from './basis-metrics.js';

// Immutable version lineage. Never updated or deleted.
export const basisMetricVersions = pgTable(
  'basis_metric_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    metric_id: uuid('metric_id')
      .notNull()
      .references(() => basisMetrics.id, { onDelete: 'cascade' }),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    version_number: integer('version_number').notNull(),
    definition: jsonb('definition').notNull(),
    lineage: jsonb('lineage').notNull(),
    change_note: text('change_note'),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_basis_versions_metric_number').on(table.metric_id, table.version_number),
    index('idx_basis_versions_org_created').on(table.organization_id, table.created_at),
  ],
);
