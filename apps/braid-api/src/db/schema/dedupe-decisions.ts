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
import { organizations, users } from './bbb-refs.js';

/**
 * Shared dedupe_decisions table (migration 0136, Wave 5 §7).
 *
 * Physical table is shared across api / bond-api / helpdesk-api. Each
 * service declares its own Drizzle view so it can read/write the shared
 * decision memory without crossing an HTTP hop. Canonical ordered pair
 * (id_a < id_b) is enforced by the CHECK constraint in the migration;
 * callers MUST sort before inserting.
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
