import {
  pgTable,
  uuid,
  varchar,
  integer,
  numeric,
  boolean,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { burnDeliverables } from './burn-deliverables.js';

/**
 * Deterministic attribution rules, applied BEFORE any LLM call (spec 2.3.3 / 3.1).
 *
 * `priority` ascending, first match wins.
 *
 * `match` is `{ project_ids?, phase_ids?, label_ids?, account_ids?, title_pattern?,
 * expense_categories?, source_types? }`. A DB CHECK rejects a match object with no
 * discriminating key, mirrored by a Zod refinement: an empty `match` is a rule that
 * silently swallows every work item in the org.
 *
 * `title_pattern` is GLOB OR SUBSTRING, NEVER REGEX. There is no regex timeout in Node, so
 * a member-authored catastrophic-backtracking pattern would be a denial of service on the
 * attribution worker with no bound. Regex metacharacters are rejected at write.
 *
 * Rules are a gate-neutralization vector, so `non_billable` and broad-scope rules require
 * `burn.rule.write` (owner/admin). `last_match_pct` above `match_ceiling_pct` is rejected
 * at write and raises a `rule_overreach` variance if the rule drifts there later.
 */
export const burnAttributionRules = pgTable(
  'burn_attribution_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    priority: integer('priority').notNull().default(100),
    match: jsonb('match').notNull(),
    // attribute | non_billable
    outcome_kind: varchar('outcome_kind', { length: 24 }).notNull(),
    outcome_deliverable_id: uuid('outcome_deliverable_id').references(() => burnDeliverables.id, {
      onDelete: 'cascade',
    }),
    outcome_reason: varchar('outcome_reason', { length: 24 }),
    is_enabled: boolean('is_enabled').notNull().default(true),
    match_count: integer('match_count').notNull().default(0),
    last_match_pct: numeric('last_match_pct', { precision: 5, scale: 2 }),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_burn_attribution_rules_org_enabled_priority').on(
      table.organization_id,
      table.is_enabled,
      table.priority,
    ),
    index('idx_burn_attribution_rules_outcome_deliverable').on(table.outcome_deliverable_id),
  ],
);
