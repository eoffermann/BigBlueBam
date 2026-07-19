import {
  pgTable,
  uuid,
  varchar,
  date,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';

// A contract (or amendment) Bulwark tracks (spec 3.1). project_id is the scoping anchor
// for read AND write project-membership checks (spec 2.5); a null-job contract holds only
// manual-trigger or calendar obligations. supersedes_contract_id is a self-FK declared in
// the migration (0234) via a guarded DO $$ block, not here, to avoid a circular
// self-reference in Drizzle. bin_asset_id / counterparty_id are dotted refs with NO
// cross-schema FK (the entity_links convention, D8).
export const bulwarkContracts = pgTable(
  'bulwark_contracts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 512 }).notNull(),
    contract_kind: varchar('contract_kind', { length: 32 }).notNull().default('subcontract'),
    supersedes_contract_id: uuid('supersedes_contract_id'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
    jurisdiction: varchar('jurisdiction', { length: 32 }),
    bin_asset_id: uuid('bin_asset_id').notNull(),
    counterparty_type: varchar('counterparty_type', { length: 32 }),
    counterparty_id: uuid('counterparty_id'),
    effective_date: date('effective_date'),
    expiry_date: date('expiry_date'),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    extraction_status: varchar('extraction_status', { length: 16 }).notNull().default('pending'),
    extracted_at: timestamp('extracted_at', { withTimezone: true }),
    source_doc_hash: varchar('source_doc_hash', { length: 64 }),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bulwark_contracts_org_status').on(table.organization_id, table.status),
    index('idx_bulwark_contracts_org_project').on(table.organization_id, table.project_id),
    index('idx_bulwark_contracts_org_bin_asset').on(table.organization_id, table.bin_asset_id),
    index('idx_bulwark_contracts_org_expiry').on(table.organization_id, table.expiry_date),
    index('idx_bulwark_contracts_supersedes').on(table.supersedes_contract_id),
  ],
);
