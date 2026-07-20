import {
  pgTable,
  uuid,
  varchar,
  integer,
  numeric,
  bigint,
  boolean,
  timestamp,
  customType,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bursarOffers } from './bursar-offers.js';

// Drizzle has no first-class tsvector column kind; this is the platform idiom (from
// burn-deliverables.ts / braid-profiles.ts). search_tsv is a GENERATED ALWAYS ... STORED
// column defined in migration 0248 for UI search only.
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * Parsed offer line ledger (spec 6.1, migration 0248). raw_text bounded 4,000 chars. NO
 * trigram index by design (it died with retrieval). Unique (organization_id, offer_id, ordinal).
 */
export const bursarOfferLines = pgTable(
  'bursar_offer_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    offer_id: uuid('offer_id')
      .notNull()
      .references(() => bursarOffers.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    raw_text: varchar('raw_text', { length: 4000 }).notNull().default(''),
    char_start: integer('char_start'),
    char_end: integer('char_end'),
    page: integer('page'),
    quantity: numeric('quantity', { precision: 18, scale: 4 }),
    unit: varchar('unit', { length: 32 }),
    unit_price_minor: bigint('unit_price_minor', { mode: 'number' }),
    extended_minor: bigint('extended_minor', { mode: 'number' }),
    currency: varchar('currency', { length: 3 }),
    line_role: varchar('line_role', { length: 24 }),
    blanket_claim: boolean('blanket_claim').notNull().default(false),
    exclusion_hit: boolean('exclusion_hit').notNull().default(false),
    parsed_by: varchar('parsed_by', { length: 24 }),
    search_tsv: tsvector('search_tsv'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_offer_lines_ordinal').on(table.organization_id, table.offer_id, table.ordinal),
    index('idx_bursar_offer_lines_offer').on(table.organization_id, table.offer_id),
    index('idx_bursar_offer_lines_search').on(table.search_tsv),
  ],
);
