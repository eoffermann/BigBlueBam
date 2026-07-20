import { pgTable, uuid, varchar, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

/**
 * RFQ / scoping requests (spec 6.1, migration 0247). bin_asset_id + bin_asset_version_id pin
 * the exact parsed bytes; injection_* carry the request-document pre-scan result.
 */
export const bursarRequests = pgTable(
  'bursar_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 512 }).notNull(),
    description: text('description'),
    // draft | ...
    status: varchar('status', { length: 16 }).notNull().default('draft'),
    source_format: varchar('source_format', { length: 24 }),
    // Dotted Bin refs, no cross-schema FK.
    bin_asset_id: uuid('bin_asset_id'),
    bin_asset_version_id: uuid('bin_asset_version_id'),
    source_doc_hash: varchar('source_doc_hash', { length: 64 }),
    // none | deriving | derived | confirmed | awarded
    scope_status: varchar('scope_status', { length: 16 }).notNull().default('none'),
    scope_confirmed_at: timestamp('scope_confirmed_at', { withTimezone: true }),
    scope_confirmed_by: uuid('scope_confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    injection_suspected: boolean('injection_suspected').notNull().default(false),
    injection_signals: jsonb('injection_signals').notNull().default({}),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bursar_requests_org_status').on(table.organization_id, table.status),
    index('idx_bursar_requests_org_scope_status').on(table.organization_id, table.scope_status),
    index('idx_bursar_requests_org_bin_asset').on(table.organization_id, table.bin_asset_id),
  ],
);
