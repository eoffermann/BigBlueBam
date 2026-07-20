import { pgTable, uuid, varchar, boolean, date, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bursarAwards } from './bursar-awards.js';
import { bursarVendors } from './bursar-vendors.js';

/**
 * Renewal radar (spec 6.1, 8, migration 0250). notice_deadline is anchored in the award
 * timezone; alerted_bands records which lead bands have fired for per-band idempotency. One
 * live radar row per award.
 */
export const bursarRenewals = pgTable(
  'bursar_renewals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    award_id: uuid('award_id')
      .notNull()
      .references(() => bursarAwards.id, { onDelete: 'cascade' }),
    chain_root_id: uuid('chain_root_id'),
    vendor_id: uuid('vendor_id').references(() => bursarVendors.id, { onDelete: 'set null' }),
    term_end: date('term_end'),
    notice_deadline: date('notice_deadline'),
    auto_renew: boolean('auto_renew').notNull().default(false),
    timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
    current_band: varchar('current_band', { length: 16 }),
    alerted_bands: jsonb('alerted_bands').notNull().default([]),
    // pending | decided | dismissed
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    decision: varchar('decision', { length: 16 }),
    decided_by: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_renewals_award').on(table.organization_id, table.award_id),
    index('idx_bursar_renewals_org_status').on(table.organization_id, table.status),
    index('idx_bursar_renewals_deadline').on(table.organization_id, table.notice_deadline),
  ],
);
