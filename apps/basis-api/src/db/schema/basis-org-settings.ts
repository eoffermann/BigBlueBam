import { pgTable, uuid, integer, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

// Per-org configuration the retention + cache-precedence logic reads (spec 3.1).
// Modeled on blip-retention-policies.ts: `snapshot_max_age_days` null = unbounded
// (feeds the sweep's "skip coarse tier if any org unbounded"). One row per org.
export const basisOrgSettings = pgTable(
  'basis_org_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    snapshot_max_age_days: integer('snapshot_max_age_days'),
    explanation_cache_ttl_seconds: integer('explanation_cache_ttl_seconds'),
    default_dimension: varchar('default_dimension', { length: 80 }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('idx_basis_org_settings_org').on(table.organization_id)],
);
