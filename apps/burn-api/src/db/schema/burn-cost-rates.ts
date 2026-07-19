import { pgTable, uuid, varchar, bigint, date, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';

/**
 * THE PRIMITIVE THE PLATFORM LACKS ENTIRELY (spec 1.2 / 3.1).
 *
 * `bill_rates.rate_amount` is the rate charged TO THE CLIENT: `invoice.service.ts:583`
 * resolves it straight into `unit_price` on an invoice line item. Grepping every
 * `apps/*\/src/db/schema/` for `cost_rate` or `internal_rate` returns nothing. So a naive
 * `contract_value - sum(billing_rate x hours)` is contract consumption at list price, not
 * margin. This table is what makes `metric_basis='true_margin'` possible at all, and Burn
 * refuses to mislabel the number when coverage is zero.
 *
 * The shape deliberately mirrors `bill_rates` so the two resolvers can be held to a parity
 * test: resolution precedence is `user+project > user > project > org`, and `effective_to`
 * is INCLUSIVE, matching `apps/bill-api/src/services/rate.service.ts:117`.
 *
 * Reads AND writes are floored to owner/admin (`burn.costrate.read` /
 * `burn.costrate.write`), each with a second independent in-route org-role guard so a
 * resolver outage cannot open them. This is per-person compensation data.
 *
 * A write here enqueues `burn-revalue` (spec 2.3.2B), which revalues existing work items at
 * ZERO llm-provider cost and never re-classifies.
 */
export const burnCostRates = pgTable(
  'burn_cost_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // Minor units, per hour.
    cost_amount: bigint('cost_amount', { mode: 'number' }).notNull(),
    rate_type: varchar('rate_type', { length: 10 }).notNull().default('hourly'),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    effective_from: date('effective_from').notNull().defaultNow(),
    // INCLUSIVE, matching rate.service.ts:117.
    effective_to: date('effective_to'),
    // e.g. "fully loaded incl. benefits"
    note: varchar('note', { length: 255 }),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_burn_cost_rates_org').on(table.organization_id),
    // A supporting b-tree, NOT a statement of precedence. Precedence is resolver logic.
    index('idx_burn_cost_rates_org_project_user_from').on(
      table.organization_id,
      table.project_id,
      table.user_id,
      table.effective_from,
    ),
  ],
);
