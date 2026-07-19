import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';

/**
 * One unit of work the org logged, priced and classified (spec 3.1). HIGHEST-CHURN TABLE.
 *
 * THE THREE EPOCHS (spec 2.3.2A / 2.3.2B) are the identity and staleness machinery:
 *   - `source_epoch`         a stored concatenation of the source record's identity-bearing
 *                            fields. A PLAIN COMPARED COLUMN, deliberately NOT part of any
 *                            unique key (R2-T4): making it part of the key is what produced
 *                            the 23505-on-revert bug, because minutes 60 -> 90 -> 60 would
 *                            collide with the row excluded on the first change.
 *   - `classification_epoch` a change here MAY re-classify, subject to the 2.3.10
 *                            carry-forward rule that preserves a human decision.
 *   - `cost_epoch`           a change here revalues ONLY. It never re-classifies and never
 *                            issues an llm-provider call.
 * `updated_at` appears in NO epoch input, which is what makes a task moved across the board
 * three times produce one work item, zero classifications, and zero LLM calls.
 *
 * `valuation_epoch` is a hash of `bill_rate_id`, `burn_cost_rate_id`, `user_id`, and both
 * rate rows' `updated_at`; `valued_at` records the last successful valuation and is what
 * makes `burn-revalue` fail-safe (it writes `unrated` only where `valued_at IS NULL`).
 *
 * `reconcile_until` is `ingested_at + reconcile_window_days` and is the anchor for
 * reconcile passes 2 and 3 (R2-T3). Anchoring on `ingested_at` rather than `occurred_at` is
 * what lets a timesheet dated 120 days ago but created today still be observed for edits
 * and deletes.
 *
 * `project_id` is THE SCOPING ANCHOR for this row (spec 2.4 point 6). Work-item and
 * attribution rows are scoped by the row's own project, not by chain reachability: a member
 * of the low-sensitivity project in a multi-project chain must not read items sourced from
 * the project they are not in.
 *
 * `billable_amount` / `cost_amount` both pass through `redactFinancialFields`. For a single
 * `bam.time_entry` row `cost_amount / (minutes / 60)` IS that person's hourly cost rate to
 * the cent, so one unfloored row is a full disclosure (R2-S3).
 *
 * THE LIVE-ROW UNIQUE INDEX replaces the four-column key and is declared in migration 0239:
 *   CREATE UNIQUE INDEX idx_burn_work_items_live
 *     ON burn_work_items (organization_id, source_type, source_id)
 *     WHERE attribution_state <> 'excluded';
 *
 * `attribution_state` is the one deliberate denormalization of `burn_attributions.state`.
 * The two enums differ on purpose; the mapping is:
 *   auto_attributed | confirmed -> 'attributed'; pending_review -> 'pending_review';
 *   unscoped -> 'unscoped'; excluded_non_billable -> 'excluded_non_billable';
 *   rejected -> 'pending'.
 *
 * Partitioning posture: first candidate for monthly partitioning on `occurred_at` per
 * 0220_blip_entries_partitioned.sql; v1 ships unpartitioned at the 2-50 seat target.
 */
export const burnWorkItems = pgTable(
  'burn_work_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    source_type: varchar('source_type', { length: 32 }).notNull(),
    source_id: uuid('source_id').notNull(),
    source_epoch: varchar('source_epoch', { length: 64 }).notNull(),
    classification_epoch: varchar('classification_epoch', { length: 64 }).notNull(),
    cost_epoch: varchar('cost_epoch', { length: 64 }).notNull(),
    valuation_epoch: varchar('valuation_epoch', { length: 64 }),
    valued_at: timestamp('valued_at', { withTimezone: true }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    actor_id: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
    ingested_at: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
    reconcile_until: timestamp('reconcile_until', { withTimezone: true }).notNull(),
    // PII-redacted on write; text_snapshot truncated to TEXT_SNAPSHOT_MAX (4000).
    title_snapshot: varchar('title_snapshot', { length: 512 }),
    text_snapshot: text('text_snapshot'),
    minutes: integer('minutes'),
    billable_amount: bigint('billable_amount', { mode: 'number' }),
    cost_amount: bigint('cost_amount', { mode: 'number' }),
    currency: varchar('currency', { length: 3 }),
    // rate | expense | invoice | none | unrated | no_cost_rate
    valuation_basis: varchar('valuation_basis', { length: 16 }).notNull().default('none'),
    // no_rate_configured | rate_service_unavailable | currency_mismatch
    unrated_reason: varchar('unrated_reason', { length: 32 }),
    bill_rate_id: uuid('bill_rate_id'),
    burn_cost_rate_id: uuid('burn_cost_rate_id'),
    // pending | pending_attribution | attributed | pending_review | unscoped |
    // excluded_non_billable | excluded
    attribution_state: varchar('attribution_state', { length: 24 }).notNull().default('pending'),
    // superseded_epoch | source_deleted | source_voided | internal | pre_sales | pto |
    // warranty | overhead | rework
    exclusion_reason: varchar('exclusion_reason', { length: 32 }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_burn_work_items_org_state_occurred').on(
      table.organization_id,
      table.attribution_state,
      table.occurred_at,
    ),
    index('idx_burn_work_items_org_project_occurred').on(
      table.organization_id,
      table.project_id,
      table.occurred_at,
    ),
    index('idx_burn_work_items_org_source').on(
      table.organization_id,
      table.source_type,
      table.source_id,
    ),
    // A partial index WHERE reconcile_until > now() is not immutable-safe, so this is a
    // plain composite (spec 3.1).
    index('idx_burn_work_items_org_reconcile').on(table.organization_id, table.reconcile_until),
    // Supports the burn-revalue scan.
    index('idx_burn_work_items_org_valued').on(table.organization_id, table.valued_at),
  ],
);
