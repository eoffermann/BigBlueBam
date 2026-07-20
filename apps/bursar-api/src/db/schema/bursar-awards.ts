import { pgTable, uuid, varchar, boolean, integer, date, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bursarRequests } from './bursar-requests.js';
import { bursarOffers } from './bursar-offers.js';
import { bursarVendors } from './bursar-vendors.js';

/**
 * Awards (spec 6.1, 7, migration 0249). supersedes_award_id (guarded self-FK in the
 * migration) + chain_root_id chain amendments. term_start/term_end are nullable (open-ended).
 * baseline_hash is computed at freeze. contract_bin_asset_id is a dotted ref.
 */
export const bursarAwards = pgTable(
  'bursar_awards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    request_id: uuid('request_id')
      .notNull()
      .references(() => bursarRequests.id, { onDelete: 'restrict' }),
    offer_id: uuid('offer_id').references(() => bursarOffers.id, { onDelete: 'set null' }),
    vendor_id: uuid('vendor_id').references(() => bursarVendors.id, { onDelete: 'set null' }),
    supersedes_award_id: uuid('supersedes_award_id'),
    chain_root_id: uuid('chain_root_id').notNull(),
    baseline_hash: varchar('baseline_hash', { length: 64 }),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    term_start: date('term_start'),
    term_end: date('term_end'),
    auto_renew: boolean('auto_renew').notNull().default(false),
    renewal_notice_days: integer('renewal_notice_days'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
    contract_bin_asset_id: uuid('contract_bin_asset_id'),
    // active | superseded | terminated
    status: varchar('status', { length: 16 }).notNull().default('active'),
    awarded_by: uuid('awarded_by')
      .notNull()
      .references(() => users.id),
    awarded_at: timestamp('awarded_at', { withTimezone: true }).defaultNow().notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bursar_awards_org_status').on(table.organization_id, table.status),
    index('idx_bursar_awards_org_chain').on(table.organization_id, table.chain_root_id),
    index('idx_bursar_awards_org_vendor').on(table.organization_id, table.vendor_id),
    index('idx_bursar_awards_supersedes').on(table.supersedes_award_id),
    index('idx_bursar_awards_term_end').on(table.organization_id, table.term_end),
  ],
);
