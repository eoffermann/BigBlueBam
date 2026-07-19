import { pgTable, uuid, varchar, date, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bulwarkVendorTiers } from './bulwark-vendor-tiers.js';
import { agentProposals } from './agent-proposals.js';

// One required/collected compliance doc (spec 3.1). Validity and collection lifecycle are
// separated (D9): collection_status tracks whether we have it, validity_status tracks
// whether it is current. bin_asset_id / blank_form_id are dotted refs with NO cross-schema FK.
export const bulwarkComplianceDocs = pgTable(
  'bulwark_compliance_docs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vendor_tier_id: uuid('vendor_tier_id')
      .notNull()
      .references(() => bulwarkVendorTiers.id, { onDelete: 'cascade' }),
    doc_type: varchar('doc_type', { length: 24 }).notNull(),
    collection_status: varchar('collection_status', { length: 16 }).notNull().default('missing'),
    validity_status: varchar('validity_status', { length: 12 }).notNull().default('unknown'),
    chase_status: varchar('chase_status', { length: 16 }).notNull().default('none'),
    bin_asset_id: uuid('bin_asset_id'),
    effective_date: date('effective_date'),
    expires_at: date('expires_at'),
    chase_proposal_id: uuid('chase_proposal_id').references(() => agentProposals.id, {
      onDelete: 'set null',
    }),
    blank_form_id: uuid('blank_form_id'),
    last_chased_at: timestamp('last_chased_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bulwark_compliance_docs_tier').on(table.organization_id, table.vendor_tier_id),
    index('idx_bulwark_compliance_docs_validity').on(table.organization_id, table.validity_status),
    index('idx_bulwark_compliance_docs_collection').on(
      table.organization_id,
      table.collection_status,
    ),
    index('idx_bulwark_compliance_docs_expires').on(table.organization_id, table.expires_at),
    index('idx_bulwark_compliance_docs_type').on(table.organization_id, table.doc_type),
    index('idx_bulwark_compliance_docs_proposal').on(table.chase_proposal_id),
  ],
);
