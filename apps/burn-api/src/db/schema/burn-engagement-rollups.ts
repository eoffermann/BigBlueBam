import {
  pgTable,
  uuid,
  varchar,
  bigint,
  integer,
  numeric,
  date,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

/**
 * Per-chain financial rollup (spec 3.1). THE ROLLUP GRAIN IS THE CHAIN, not the engagement.
 *
 * `metric_basis` is `true_margin` when cost-rate coverage is non-zero and
 * `contract_consumption` otherwise. The `suppressed` variant of spec 1.2.2 is a RESPONSE
 * SHAPE, never a stored value.
 *
 * `revenue_basis` branches on the engagement's `envelope_basis` (spec 1.2.1), and the
 * branch is load-bearing rather than cosmetic:
 *   fixed              -> contract_value              revenue = chain contract value
 *   not_to_exceed      -> billable_recognized_capped  revenue = min(billable, cap). NOT the
 *                                                     cap: NTE bills actual work up to a
 *                                                     ceiling and never the ceiling itself,
 *                                                     so grouping it with `fixed` would book
 *                                                     revenue that can never be invoiced.
 *   retainer           -> contract_value_per_period   per period, boundaries in the
 *                                                     engagement's timezone
 *   time_and_materials -> billable_recognized         revenue = attributed_billable
 * An unbranched formula measures, on a fixed-fee SOW, "the T&M invoice we did not send,
 * minus cost", which moves the WRONG WAY: delivering under budget shows less margin.
 *
 * THE THREE UNSCOPED BUCKETS ARE NEVER SUMMED INTO ONE (spec 2.3.8). "Work nobody sold",
 * "work we have not classified yet", and "work outside any contract window" are different
 * problems with different owners, and merging them is what makes an unscoped number
 * unactionable.
 *
 * RETAINER PERIODS (R3-D3). The unique key stays `(organization_id, chain_root_id)` and the
 * row is ALWAYS THE CURRENT PERIOD, carrying `period_start` / `period_end` / `period_index`
 * as descriptive columns. Prior periods come from the burn-down series, not from additional
 * rollup rows. NULL for every non-retainer basis. Without stored bounds an implementer
 * silently picks current, trailing, or lifetime and renders whichever with no label.
 *
 * `frozen_at` is set by `burn-retention` on purge, and A FROZEN ROW IS NEVER RECOMPUTED
 * (R2-T5). Without this the hourly full recompute would, on the first pass after retention
 * purged a closed chain's work items, recompute from surviving rows (near zero), DO UPDATE a
 * three-year-old $18,000 figure to $0, and stamp a fresh `computed_at` so it would not even
 * read as stale.
 *
 * `computed_at` is served as `as_of` on every money response.
 */
export const burnEngagementRollups = pgTable(
  'burn_engagement_rollups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    chain_root_id: uuid('chain_root_id').notNull(),
    contract_value: bigint('contract_value', { mode: 'number' }),
    attributed_billable: bigint('attributed_billable', { mode: 'number' }),
    attributed_cost: bigint('attributed_cost', { mode: 'number' }),
    // The three buckets (spec 2.3.8). Never summed into one.
    unscoped_sold_by_nobody: bigint('unscoped_sold_by_nobody', { mode: 'number' }),
    unscoped_unclassified: bigint('unscoped_unclassified', { mode: 'number' }),
    unscoped_outside_contract: bigint('unscoped_outside_contract', { mode: 'number' }),
    pending_review_amount: bigint('pending_review_amount', { mode: 'number' }),
    awaiting_valuation_amount: bigint('awaiting_valuation_amount', { mode: 'number' }),
    non_billable_amount: bigint('non_billable_amount', { mode: 'number' }),
    consumption_pct: numeric('consumption_pct', { precision: 6, scale: 2 }),
    // Null unless cost coverage is non-zero.
    margin_amount: bigint('margin_amount', { mode: 'number' }),
    margin_pct: numeric('margin_pct', { precision: 6, scale: 2 }),
    cost_rate_coverage_pct: numeric('cost_rate_coverage_pct', { precision: 6, scale: 2 }),
    // Gates promotion to blocking (spec 5.4).
    priced_deliverable_coverage_pct: numeric('priced_deliverable_coverage_pct', {
      precision: 6,
      scale: 2,
    }),
    // Drives the spec 2.4 point 17 contributor-floor suppression.
    distinct_contributor_count: integer('distinct_contributor_count').notNull().default(0),
    // true_margin | contract_consumption
    metric_basis: varchar('metric_basis', { length: 24 }).notNull(),
    // contract_value | billable_recognized_capped | contract_value_per_period |
    // billable_recognized
    revenue_basis: varchar('revenue_basis', { length: 32 }).notNull(),
    period_start: date('period_start'),
    period_end: date('period_end'),
    period_index: integer('period_index'),
    // in_progress | final
    margin_state: varchar('margin_state', { length: 16 }),
    work_item_count: integer('work_item_count').notNull().default(0),
    frozen_at: timestamp('frozen_at', { withTimezone: true }),
    computed_at: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_burn_engagement_rollups_chain').on(table.organization_id, table.chain_root_id),
    index('idx_burn_engagement_rollups_org_computed').on(table.organization_id, table.computed_at),
    index('idx_burn_engagement_rollups_org_frozen').on(table.organization_id, table.frozen_at),
  ],
);
