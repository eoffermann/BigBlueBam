import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bursarRequests } from './bursar-requests.js';
import { bursarVendors } from './bursar-vendors.js';

/**
 * Advisory-only scope-gap check records (spec 9, migration 0250). The enforcing bill-api gate
 * is cut from v1: verdict is pass / advisory and never blocks. acting_user_id flows through
 * viewer-caps.
 */
export const bursarGateChecks = pgTable(
  'bursar_gate_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    check_kind: varchar('check_kind', { length: 24 }).notNull().default('scope_gap'),
    // pass | advisory
    verdict: varchar('verdict', { length: 16 }).notNull(),
    request_id: uuid('request_id').references(() => bursarRequests.id, { onDelete: 'set null' }),
    vendor_id: uuid('vendor_id').references(() => bursarVendors.id, { onDelete: 'set null' }),
    subject_ref: varchar('subject_ref', { length: 96 }),
    reasons: jsonb('reasons').notNull().default([]),
    acting_user_id: uuid('acting_user_id').references(() => users.id, { onDelete: 'set null' }),
    // api | internal
    source: varchar('source', { length: 16 }).notNull().default('api'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bursar_gate_checks_org_created').on(table.organization_id, table.created_at),
    index('idx_bursar_gate_checks_org_verdict').on(table.organization_id, table.verdict),
  ],
);
