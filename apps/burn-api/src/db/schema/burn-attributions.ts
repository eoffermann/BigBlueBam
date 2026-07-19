import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { burnWorkItems } from './burn-work-items.js';
import { burnDeliverables } from './burn-deliverables.js';
import { burnEngagements } from './burn-engagements.js';

/**
 * Which priced envelope a work item belongs to (spec 3.1).
 *
 * THE ATTRIBUTION CARRIES THE CLASSIFICATION DECISION AND NO MONEY (round-3 blocker R3-T2).
 * There are deliberately no `billable_amount` / `cost_amount` snapshot columns here. Every
 * consumption and rollup query, and the gate's deny arithmetic in 5.3, JOINS
 * `burn_work_items` for amounts and uses this table solely to answer "which deliverable
 * does this belong to."
 *
 * The reason is that `burn-revalue` rewrites amounts on `burn_work_items` while explicitly
 * never superseding an attribution. With a snapshot here, both readings are wrong: summing
 * the snapshot leaves `attributed_cost` null forever once cost rates arrive (R2-T2's
 * failure exactly relocated), and summing the work item leaves the snapshot permanently
 * divergent, so the gate and the rollup disagree about the same dollars with no
 * reconciliation path. Deleting the columns removes an entire staleness class rather than
 * adding a cache-coherence invariant to maintain. `burn_work_items.attribution_state`
 * remains the one deliberate denormalization.
 *
 * `deliverable_id` is ON DELETE RESTRICT: a live classification blocks an accidental
 * deliverable delete. Null means unscoped or non-billable.
 *
 * `method='inherited'` is the 2.3.10 carry-forward marker. The predicate that preserves a
 * human decision across a `classification_epoch` change must accept it, not only
 * `method='human'`, or the decision survives the first edit and is lost on the second
 * (R3-T6).
 *
 * `superseded_by` is a self-FK declared in migration 0239 via a guarded DO $$ block.
 */
export const burnAttributions = pgTable(
  'burn_attributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    work_item_id: uuid('work_item_id')
      .notNull()
      .references(() => burnWorkItems.id, { onDelete: 'cascade' }),
    deliverable_id: uuid('deliverable_id').references(() => burnDeliverables.id, {
      onDelete: 'restrict',
    }),
    engagement_id: uuid('engagement_id').references(() => burnEngagements.id, {
      onDelete: 'set null',
    }),
    chain_root_id: uuid('chain_root_id'),
    // auto_attributed | confirmed | pending_review | unscoped | excluded_non_billable |
    // rejected
    state: varchar('state', { length: 24 }).notNull(),
    // no_matching_deliverable | low_confidence | no_active_engagement |
    // outside_engagement_window | restatement_unmatched | aged_out
    unscoped_reason: varchar('unscoped_reason', { length: 32 }),
    non_billable_reason: varchar('non_billable_reason', { length: 24 }),
    confidence: numeric('confidence', { precision: 5, scale: 2 }),
    // rule | structural | precedent | lexical | llm | human | inherited
    method: varchar('method', { length: 24 }).notNull(),
    // Decision reproducibility: the bounded candidate set the decision was made against.
    candidate_set: jsonb('candidate_set').notNull().default([]),
    rationale: text('rationale'),
    superseded_at: timestamp('superseded_at', { withTimezone: true }),
    superseded_by: uuid('superseded_by'),
    decided_by: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    vocabulary_version: integer('vocabulary_version').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_burn_attributions_org_state_created').on(
      table.organization_id,
      table.state,
      table.created_at,
    ),
  ],
);
