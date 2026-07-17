import {
  pgTable,
  uuid,
  varchar,
  numeric,
  timestamp,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { basisMetrics } from './basis-metrics.js';

// Captured metric values for movement detection + sparklines ONLY.
// /explain never reads this table (spec 2.1 invariant).
//
// Range-partitioned monthly by `captured_at` in the migration; Drizzle declares
// the PARENT ONLY (partition children are DB-managed) so `pnpm db:check` stays
// green. `captured_at` is part of the PK and the UNIQUE key because it is the
// partition key. Idempotency (spec 3.1) relies on captured_at being
// bucket-aligned (date_trunc to the grain boundary, UTC) so a retried tick
// no-ops via INSERT ON CONFLICT DO UPDATE.
export const basisMetricSnapshots = pgTable(
  'basis_metric_snapshots',
  {
    id: uuid('id').notNull().defaultRandom(),
    metric_id: uuid('metric_id')
      .notNull()
      .references(() => basisMetrics.id, { onDelete: 'cascade' }),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    version_id: uuid('version_id').notNull(),
    captured_at: timestamp('captured_at', { withTimezone: true }).notNull(),
    grain: varchar('grain', { length: 10 }).notNull(),
    value: numeric('value').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.captured_at] }),
    index('idx_basis_snapshots_metric_grain').on(
      table.metric_id,
      table.grain,
      table.captured_at,
    ),
  ],
);
