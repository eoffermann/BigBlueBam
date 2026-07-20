import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bursarRequests } from './bursar-requests.js';
import { bursarVendors } from './bursar-vendors.js';
import { bursarAwards } from './bursar-awards.js';
import { bursarMismatches } from './bursar-mismatches.js';

/**
 * Draft HITL rows (spec 3.6, 16.2, migration 0250): the only thing that leaves the building,
 * a clarification or negotiation-brief with a content-free agent_proposals summary. NO
 * outbound transport in v1. Owner-scoped reads. proposal_id is a dotted ref to the shared
 * agent_proposals row.
 */
export const bursarDrafts = pgTable(
  'bursar_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // clarification | negotiation_brief
    kind: varchar('kind', { length: 24 }).notNull(),
    // draft | pending | approved | rejected
    status: varchar('status', { length: 16 }).notNull().default('draft'),
    request_id: uuid('request_id').references(() => bursarRequests.id, { onDelete: 'set null' }),
    vendor_id: uuid('vendor_id').references(() => bursarVendors.id, { onDelete: 'set null' }),
    award_id: uuid('award_id').references(() => bursarAwards.id, { onDelete: 'set null' }),
    mismatch_id: uuid('mismatch_id').references(() => bursarMismatches.id, { onDelete: 'set null' }),
    proposal_id: uuid('proposal_id'),
    owner_user_id: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 512 }),
    body: text('body'),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    approved_by: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    rejected_by: uuid('rejected_by').references(() => users.id, { onDelete: 'set null' }),
    rejected_at: timestamp('rejected_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bursar_drafts_owner').on(table.organization_id, table.owner_user_id, table.status),
    index('idx_bursar_drafts_org_status').on(table.organization_id, table.status),
    index('idx_bursar_drafts_proposal').on(table.proposal_id),
  ],
);
