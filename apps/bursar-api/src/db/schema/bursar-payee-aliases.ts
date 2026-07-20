import { pgTable, uuid, varchar, numeric, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bursarVendors } from './bursar-vendors.js';

/**
 * Payee aliases (spec 6.1, migration 0247). Bursar's OWN payee resolution, not Braid's.
 * Unique (organization_id, normalized_payee); DB also carries a GIN trigram index on
 * normalized_payee for fuzzy match (not modeled here).
 */
export const bursarPayeeAliases = pgTable(
  'bursar_payee_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    vendor_id: uuid('vendor_id').references(() => bursarVendors.id, { onDelete: 'cascade' }),
    raw_payee: varchar('raw_payee', { length: 512 }).notNull(),
    normalized_payee: varchar('normalized_payee', { length: 512 }).notNull(),
    // auto | human
    source: varchar('source', { length: 24 }).notNull().default('auto'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    resolved_by: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    first_seen_at: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_payee_aliases_norm').on(table.organization_id, table.normalized_payee),
    index('idx_bursar_payee_aliases_vendor').on(table.organization_id, table.vendor_id),
  ],
);
