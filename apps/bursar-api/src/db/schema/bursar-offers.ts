import {
  pgTable,
  uuid,
  varchar,
  boolean,
  numeric,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bursarRequests } from './bursar-requests.js';
import { bursarVendors } from './bursar-vendors.js';

/**
 * Vendor offers (spec 6.1, migration 0248). parse_quality, blanket_suspected,
 * unsubpriced_mandatory_count, and evidence_concentration are computed and persisted for
 * auditability. sealed_until backs the shared seal predicate. Unique
 * (organization_id, request_id, vendor_id, source_doc_hash).
 */
export const bursarOffers = pgTable(
  'bursar_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    request_id: uuid('request_id')
      .notNull()
      .references(() => bursarRequests.id, { onDelete: 'cascade' }),
    vendor_id: uuid('vendor_id').references(() => bursarVendors.id, { onDelete: 'set null' }),
    label: varchar('label', { length: 512 }),
    status: varchar('status', { length: 16 }).notNull().default('received'),
    parse_quality: numeric('parse_quality', { precision: 5, scale: 4 }),
    injection_suspected: boolean('injection_suspected').notNull().default(false),
    injection_signals: jsonb('injection_signals').notNull().default({}),
    blanket_suspected: boolean('blanket_suspected').notNull().default(false),
    unsubpriced_mandatory_count: integer('unsubpriced_mandatory_count').notNull().default(0),
    evidence_concentration: numeric('evidence_concentration', { precision: 5, scale: 4 }),
    sealed_until: timestamp('sealed_until', { withTimezone: true }),
    source_format: varchar('source_format', { length: 24 }),
    bin_asset_id: uuid('bin_asset_id'),
    bin_asset_version_id: uuid('bin_asset_version_id'),
    source_doc_hash: varchar('source_doc_hash', { length: 64 }).notNull().default(''),
    uncompressed_bytes: bigint('uncompressed_bytes', { mode: 'number' }),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_offers_dedup').on(
      table.organization_id,
      table.request_id,
      table.vendor_id,
      table.source_doc_hash,
    ),
    index('idx_bursar_offers_org_request').on(table.organization_id, table.request_id),
    index('idx_bursar_offers_org_vendor').on(table.organization_id, table.vendor_id),
  ],
);
