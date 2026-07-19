import {
  pgTable,
  uuid,
  varchar,
  smallint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bulwarkContracts } from './bulwark-contracts.js';

// A lower-tier vendor in the compliance chain (spec 3.1). contract_id is the compliance-read
// scoping anchor (SH3); a null contract_id makes the tier owner/admin-only. parent_tier_id is
// a self-FK declared in the migration (0235) via a guarded DO $$ block, not here.
// required_doc_types is RECOMPUTED from scratch each sweep (DI5), never incrementally edited.
export const bulwarkVendorTiers = pgTable(
  'bulwark_vendor_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contract_id: uuid('contract_id').references(() => bulwarkContracts.id, {
      onDelete: 'set null',
    }),
    parent_tier_id: uuid('parent_tier_id'),
    vendor_type: varchar('vendor_type', { length: 32 }),
    vendor_id: uuid('vendor_id'),
    tier_level: smallint('tier_level').notNull().default(1),
    required_doc_types: jsonb('required_doc_types').notNull().default('[]'),
    chase_status: varchar('chase_status', { length: 16 }).notNull().default('idle'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bulwark_vendor_tiers_org_contract').on(table.organization_id, table.contract_id),
    index('idx_bulwark_vendor_tiers_org_chase').on(table.organization_id, table.chase_status),
    index('idx_bulwark_vendor_tiers_parent').on(table.parent_tier_id),
    uniqueIndex('idx_bulwark_vendor_tiers_vendor').on(
      table.organization_id,
      table.contract_id,
      table.vendor_type,
      table.vendor_id,
    ),
  ],
);
