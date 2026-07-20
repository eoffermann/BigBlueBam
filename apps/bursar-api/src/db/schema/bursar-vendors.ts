import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

/**
 * Vendors (spec 6.1, migration 0247). braid_profile_id / bond_company_id are dotted
 * cross-app refs with no cross-schema FK. Unique on (organization_id, lower(display_name)).
 */
export const bursarVendors = pgTable(
  'bursar_vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    display_name: varchar('display_name', { length: 512 }).notNull(),
    braid_profile_id: uuid('braid_profile_id'),
    bond_company_id: uuid('bond_company_id'),
    category: varchar('category', { length: 64 }),
    // standard | ... (advisory label)
    criticality: varchar('criticality', { length: 16 }).notNull().default('standard'),
    owner_user_id: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    // active | archived
    status: varchar('status', { length: 16 }).notNull().default('active'),
    notes: text('notes'),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // DB enforces UNIQUE (organization_id, lower(display_name)); the Drizzle index is
    // cosmetic (migrations are hand-authored) so the case-fold is documented, not modeled.
    uniqueIndex('idx_bursar_vendors_org_name').on(table.organization_id, table.display_name),
    index('idx_bursar_vendors_org_status').on(table.organization_id, table.status),
    index('idx_bursar_vendors_org_braid').on(table.organization_id, table.braid_profile_id),
    index('idx_bursar_vendors_org_bond').on(table.organization_id, table.bond_company_id),
  ],
);
