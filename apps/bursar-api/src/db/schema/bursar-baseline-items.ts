import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  bigint,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bursarAwards } from './bursar-awards.js';

/**
 * FROZEN baseline item ledger (spec 6.1, 7, migration 0249). kind is one of included /
 * excluded_at_award / absent_at_award. coverage_verdict_at_award stamps the coverage at the
 * moment the award froze. Four-path immutability (BEFORE UPDATE with a content-scoped WHEN,
 * BEFORE DELETE, award-side ON DELETE RESTRICT, BEFORE TRUNCATE) is enforced in migration
 * 0249; rows are insert-only from the service layer.
 */
export const bursarBaselineItems = pgTable(
  'bursar_baseline_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    award_id: uuid('award_id')
      .notNull()
      .references(() => bursarAwards.id, { onDelete: 'restrict' }),
    ordinal: integer('ordinal').notNull().default(0),
    // included | excluded_at_award | absent_at_award
    kind: varchar('kind', { length: 24 }).notNull().default('included'),
    title: varchar('title', { length: 512 }).notNull(),
    description: text('description'),
    unit: varchar('unit', { length: 32 }),
    quantity: numeric('quantity', { precision: 18, scale: 4 }),
    unit_price_minor: bigint('unit_price_minor', { mode: 'number' }),
    extended_minor: bigint('extended_minor', { mode: 'number' }),
    currency: varchar('currency', { length: 3 }),
    delta_kind: varchar('delta_kind', { length: 24 }),
    delta_amount_minor: bigint('delta_amount_minor', { mode: 'number' }),
    coverage_verdict_at_award: varchar('coverage_verdict_at_award', { length: 24 }),
    source_offer_line_id: uuid('source_offer_line_id'),
    cited_span: jsonb('cited_span').notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bursar_baseline_items_award').on(table.organization_id, table.award_id),
    index('idx_bursar_baseline_items_kind').on(table.organization_id, table.award_id, table.kind),
  ],
);
