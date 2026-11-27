import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './organizations.js';
import { users } from './users.js';

/**
 * Shared dedupe_decisions table (migration 0136, Wave 5 §7).
 *
 * Persistent decision memory for "is A a duplicate of B" resolutions
 * across bond contacts, helpdesk tickets, and any future per-app
 * dedupe surface. Keyed by the canonical ordered pair (id_a < id_b)
 * so a given entity pair has at most one row regardless of which side
 * the scan discovered first. The CHECK constraint is enforced in the
 * migration; MCP tooling (dedupe_record_decision) always sorts before
 * insert so callers never see an ordered-pair error in the common path.
 *
 * decision ∈ { 'duplicate', 'not_duplicate', 'needs_review' }.
 *
 * RLS: org-isolated via `NULLIF(current_setting('app.current_org_id', true), '')::uuid` (0355).
 */
export const dedupeDecisions = pgTable(
  'dedupe_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entity_type: text('entity_type').notNull(),
    id_a: uuid('id_a').notNull(),
    id_b: uuid('id_b').notNull(),
    decision: text('decision').notNull(),
    decided_by: uuid('decided_by')
      .notNull()
      .references(() => users.id),
    decided_at: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
    reason: text('reason'),
    confidence_at_decision: numeric('confidence_at_decision', { precision: 5, scale: 2 }),
    resurface_after: timestamp('resurface_after', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_dedupe_pair').on(table.entity_type, table.id_a, table.id_b),
    index('idx_dedupe_entity_type').on(table.entity_type, table.decided_at),
    index('idx_dedupe_org_entity').on(table.org_id, table.entity_type, table.decided_at),
    check('dedupe_ordered_pair', sql`${table.id_a} < ${table.id_b}`),
  ],
);
