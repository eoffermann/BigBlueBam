import {
  pgTable,
  uuid,
  numeric,
  boolean,
  jsonb,
  integer,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

// Per-org tunables (modeled on basis_org_settings). One row per org. Thresholds are
// prospective-only; rescan re-evaluates on change (spec 3.1, ST8). enabled_source_types
// is opt-in per org and only offers a type whose visibility branch is verified (spec 2.5).
export const braidOrgSettings = pgTable(
  'braid_org_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    auto_merge_threshold: numeric('auto_merge_threshold', { precision: 5, scale: 2 })
      .notNull()
      .default('0.92'),
    review_threshold: numeric('review_threshold', { precision: 5, scale: 2 })
      .notNull()
      .default('0.60'),
    require_strong_signal_for_auto: boolean('require_strong_signal_for_auto')
      .notNull()
      .default(true),
    enabled_source_types: jsonb('enabled_source_types').notNull().default('[]'),
    rescan_max_age_days: integer('rescan_max_age_days'),
    last_rescan_at: timestamp('last_rescan_at', { withTimezone: true }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('idx_braid_org_settings_org').on(table.organization_id)],
);
