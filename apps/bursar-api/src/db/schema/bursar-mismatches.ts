import { pgTable, uuid, varchar, bigint, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bursarVendors } from './bursar-vendors.js';
import { bursarAwards } from './bursar-awards.js';
import { bursarRequests } from './bursar-requests.js';
import { bursarOffers } from './bursar-offers.js';
import { bursarScopeNodes } from './bursar-scope-nodes.js';
import { bursarBaselineItems } from './bursar-baseline-items.js';
import { bursarSpendEvents } from './bursar-spend-events.js';

/**
 * Detector output ledger (spec 6.1, 8, migration 0250). dollars_at_stake_minor is NULL when
 * unquantifiable (UI shows "not quantified"). dedup_key upserts and bumps last_seen_at;
 * dismissed is sticky by dedup_key unless evidence_hash changes. Unique
 * (organization_id, dedup_key).
 */
export const bursarMismatches = pgTable(
  'bursar_mismatches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    detector: varchar('detector', { length: 48 }).notNull(),
    // low | medium | high | critical
    severity: varchar('severity', { length: 16 }).notNull().default('medium'),
    // open | resolved | dismissed
    status: varchar('status', { length: 16 }).notNull().default('open'),
    dedup_key: varchar('dedup_key', { length: 64 }).notNull(),
    evidence_hash: varchar('evidence_hash', { length: 64 }),
    vendor_id: uuid('vendor_id').references(() => bursarVendors.id, { onDelete: 'set null' }),
    award_id: uuid('award_id').references(() => bursarAwards.id, { onDelete: 'set null' }),
    chain_root_id: uuid('chain_root_id'),
    request_id: uuid('request_id').references(() => bursarRequests.id, { onDelete: 'set null' }),
    offer_id: uuid('offer_id').references(() => bursarOffers.id, { onDelete: 'set null' }),
    scope_node_id: uuid('scope_node_id').references(() => bursarScopeNodes.id, { onDelete: 'set null' }),
    baseline_item_id: uuid('baseline_item_id').references(() => bursarBaselineItems.id, { onDelete: 'set null' }),
    spend_event_id: uuid('spend_event_id').references(() => bursarSpendEvents.id, { onDelete: 'set null' }),
    normalized_payee: varchar('normalized_payee', { length: 512 }),
    dollars_at_stake_minor: bigint('dollars_at_stake_minor', { mode: 'number' }),
    currency: varchar('currency', { length: 3 }),
    basis: varchar('basis', { length: 32 }),
    cited_span: jsonb('cited_span').notNull().default({}),
    details: jsonb('details').notNull().default({}),
    resolved_by: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    dismissed_by: uuid('dismissed_by').references(() => users.id, { onDelete: 'set null' }),
    dismissed_at: timestamp('dismissed_at', { withTimezone: true }),
    first_seen_at: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_mismatches_dedup').on(table.organization_id, table.dedup_key),
    index('idx_bursar_mismatches_org_status').on(table.organization_id, table.status, table.detector),
    index('idx_bursar_mismatches_org_vendor').on(table.organization_id, table.vendor_id),
    index('idx_bursar_mismatches_org_payee').on(table.organization_id, table.normalized_payee),
    index('idx_bursar_mismatches_org_chain').on(table.organization_id, table.chain_root_id),
  ],
);
