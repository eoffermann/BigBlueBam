import {
  pgTable,
  uuid,
  varchar,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bursarOffers } from './bursar-offers.js';

/**
 * Comparable totals per offer (spec 10, migration 0248). total_kind is one of
 * stated / base_only / gap_adjusted / should_have_supplement. renderable = false when gaps
 * cannot be valued above ladder rung 3, so the UI shows an unpriced-gap count rather than a
 * fabricated number. Unique (organization_id, offer_id, total_kind).
 */
export const bursarOfferTotals = pgTable(
  'bursar_offer_totals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    offer_id: uuid('offer_id')
      .notNull()
      .references(() => bursarOffers.id, { onDelete: 'cascade' }),
    total_kind: varchar('total_kind', { length: 24 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    amount_minor: bigint('amount_minor', { mode: 'number' }),
    estimated: boolean('estimated').notNull().default(false),
    unvalued_gap_count: integer('unvalued_gap_count').notNull().default(0),
    renderable: boolean('renderable').notNull().default(true),
    provenance: jsonb('provenance').notNull().default({}),
    computed_at: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_offer_totals_unique').on(table.organization_id, table.offer_id, table.total_kind),
    index('idx_bursar_offer_totals_offer').on(table.organization_id, table.offer_id),
  ],
);
