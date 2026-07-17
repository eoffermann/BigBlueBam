import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

// Governed metric. One certified definition per number, per org.
// `current_version_id` intentionally has no Drizzle .references() to avoid a
// circular import with basis-metric-versions; the FK is declared in the migration.
export const basisMetrics = pgTable(
  'basis_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 80 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    description: text('description'),
    unit: varchar('unit', { length: 20 }).notNull(),
    favorable_direction: varchar('favorable_direction', { length: 8 }).notNull().default('up'),
    owner_id: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    certification: varchar('certification', { length: 12 }).notNull().default('draft'),
    current_version_id: uuid('current_version_id'),
    related_apps: jsonb('related_apps').notNull().default('[]'),
    target: jsonb('target'),
    resolve_status: varchar('resolve_status', { length: 12 }).notNull().default('ok'),
    resolve_failed_at: timestamp('resolve_failed_at', { withTimezone: true }),
    last_breach_at: timestamp('last_breach_at', { withTimezone: true }),
    last_breach_direction: varchar('last_breach_direction', { length: 8 }),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_basis_metrics_org_slug').on(table.organization_id, table.slug),
    index('idx_basis_metrics_org_cert').on(table.organization_id, table.certification),
    index('idx_basis_metrics_org_owner').on(table.organization_id, table.owner_id),
  ],
);
