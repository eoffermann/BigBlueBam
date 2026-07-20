import {
  pgTable,
  uuid,
  varchar,
  integer,
  bigint,
  numeric,
  date,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bursarSpendImports } from './bursar-spend-imports.js';
import { bursarVendors } from './bursar-vendors.js';
import { bursarBaselineItems } from './bursar-baseline-items.js';

/**
 * Observed spend stream (spec 6.1, migration 0249). source_type is one of bill.expense /
 * import.csv / manual. occurrence_ordinal is the row's index within its dedup group in the
 * source file, so genuine identical same-day charges get distinct rows. dedup_key is a plain
 * local sha256; unique (organization_id, dedup_key). Index (organization_id, normalized_payee)
 * drives unbaselined-vendor grouping.
 */
export const bursarSpendEvents = pgTable(
  'bursar_spend_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    source_type: varchar('source_type', { length: 24 }).notNull(),
    spend_import_id: uuid('spend_import_id').references(() => bursarSpendImports.id, { onDelete: 'set null' }),
    vendor_id: uuid('vendor_id').references(() => bursarVendors.id, { onDelete: 'set null' }),
    occurred_on: date('occurred_on').notNull(),
    amount_minor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    payee_raw: varchar('payee_raw', { length: 512 }),
    normalized_payee: varchar('normalized_payee', { length: 512 }),
    funding_source: varchar('funding_source', { length: 64 }),
    external_ref: varchar('external_ref', { length: 256 }),
    matched_baseline_item_id: uuid('matched_baseline_item_id').references(() => bursarBaselineItems.id, {
      onDelete: 'set null',
    }),
    match_method: varchar('match_method', { length: 24 }),
    match_confidence: numeric('match_confidence', { precision: 5, scale: 4 }),
    dedup_key: varchar('dedup_key', { length: 64 }).notNull(),
    occurrence_ordinal: integer('occurrence_ordinal').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_spend_events_dedup').on(table.organization_id, table.dedup_key),
    index('idx_bursar_spend_events_org_payee').on(table.organization_id, table.normalized_payee),
    index('idx_bursar_spend_events_org_occurred').on(table.organization_id, table.occurred_on),
    index('idx_bursar_spend_events_vendor').on(table.organization_id, table.vendor_id),
    index('idx_bursar_spend_events_baseline_item').on(table.matched_baseline_item_id),
  ],
);
