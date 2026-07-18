import { pgTable, uuid, varchar, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

// Per-org, per-field winner selection when two profiles merge (spec 3.1). The
// company_profile_id field resolves which linked employer-company survives when two
// people merge (default most_recent by source_synced_at).
export const braidSurvivorshipRules = pgTable(
  'braid_survivorship_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 8 }).notNull(),
    field: varchar('field', { length: 64 }).notNull(),
    strategy: varchar('strategy', { length: 20 }).notNull(),
    source_priority: jsonb('source_priority').notNull().default('[]'),
    pinned_value: jsonb('pinned_value'),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_braid_survivorship_org_kind_field').on(
      table.organization_id,
      table.kind,
      table.field,
    ),
  ],
);
