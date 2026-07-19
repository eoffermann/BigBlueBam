import {
  pgTable,
  uuid,
  varchar,
  bigint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { burnEngagements } from './burn-engagements.js';
import { burnDeliverables } from './burn-deliverables.js';
import { agentProposals } from './agent-proposals.js';

/**
 * A detected deviation between what was sold and what is being done (spec 3.1 / 4.3).
 *
 * `amount` is `burn.financials.read_all`-floored on read and is NEVER in a Bolt payload:
 * Bolt is org-level with no per-rule visibility, so every published `burn` event carries
 * refs plus a coarse band only (spec 2.4 point 13).
 *
 * `detail` refs are capped at `variance_detail_max_refs` (50) and the whole object passes
 * through `redactFinancialFields`, because it is one of the eight serializer surfaces.
 *
 * UNPRICED DELIVERABLES ARE EXCLUDED from `envelope_overrun` and `consumption_erosion`
 * (spec 2.2.2): a deliverable with a NULL `envelope_amount` has no envelope to overrun, and
 * treating one as zero would fire a critical variance on every unpriced line.
 *
 * `sweep_marker` records the OBSERVED sweep time, never `now()` mid-compute, so a sweep
 * that spans a minute does not silently split its own window.
 */
export const burnVariances = pgTable(
  'burn_variances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    engagement_id: uuid('engagement_id').references(() => burnEngagements.id, {
      onDelete: 'cascade',
    }),
    chain_root_id: uuid('chain_root_id'),
    deliverable_id: uuid('deliverable_id').references(() => burnDeliverables.id, {
      onDelete: 'set null',
    }),
    // unscoped_work | envelope_overrun | envelope_at_risk | silent_deliverable |
    // ungated_charge | consumption_erosion | phantom_consumption | gate_outage |
    // rule_overreach | awaiting_valuation | precheck_probing
    variance_kind: varchar('variance_kind', { length: 32 }).notNull(),
    // low | medium | high | critical
    severity: varchar('severity', { length: 8 }).notNull(),
    dedup_key: varchar('dedup_key', { length: 128 }).notNull(),
    amount: bigint('amount', { mode: 'number' }),
    detail: jsonb('detail').notNull().default({}),
    // open | acknowledged | resolved | dismissed
    status: varchar('status', { length: 12 }).notNull().default('open'),
    proposal_id: uuid('proposal_id').references(() => agentProposals.id, { onDelete: 'set null' }),
    resolved_by: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    detected_at: timestamp('detected_at', { withTimezone: true }),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    sweep_marker: timestamp('sweep_marker', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_burn_variances_dedup').on(table.organization_id, table.dedup_key),
    index('idx_burn_variances_org_status_severity').on(
      table.organization_id,
      table.status,
      table.severity,
    ),
    index('idx_burn_variances_org_chain').on(table.organization_id, table.chain_root_id),
    index('idx_burn_variances_org_kind_detected').on(
      table.organization_id,
      table.variance_kind,
      table.detected_at,
    ),
  ],
);
