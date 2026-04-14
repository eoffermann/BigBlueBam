import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  bigint,
  integer,
  date,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './organizations.js';
import { users } from './users.js';

/**
 * Canonical mirror of apps/bond-api/src/db/schema/bond-deals.ts.
 *
 * Consumers outside bond-api (e.g. bill-api, blast-api) reference this table
 * via @bigbluebam/db-stubs so they can compose queries against the same
 * authoritative shape without importing from bond-api. FKs to
 * bond_pipelines, bond_pipeline_stages, and bond_companies are represented
 * as plain uuid columns here because those tables are not in db-stubs; the
 * live database still enforces them via migration 0068 and siblings.
 */
export const bondDeals = pgTable(
  'bond_deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    pipeline_id: uuid('pipeline_id').notNull(),
    stage_id: uuid('stage_id').notNull(),

    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    value: bigint('value', { mode: 'number' }),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    expected_close_date: date('expected_close_date'),
    probability_pct: integer('probability_pct'),
    weighted_value: bigint('weighted_value', { mode: 'number' }),

    closed_at: timestamp('closed_at', { withTimezone: true }),
    close_reason: text('close_reason'),
    lost_to_competitor: varchar('lost_to_competitor', { length: 255 }),

    owner_id: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),

    company_id: uuid('company_id'),

    custom_fields: jsonb('custom_fields').default({}).notNull(),

    stage_entered_at: timestamp('stage_entered_at', { withTimezone: true }).defaultNow().notNull(),
    last_activity_at: timestamp('last_activity_at', { withTimezone: true }),
    rotting_alerted_at: timestamp('rotting_alerted_at', { withTimezone: true }),

    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bond_deals_org').on(table.organization_id),
    index('idx_bond_deals_pipeline').on(table.pipeline_id, table.stage_id),
    index('idx_bond_deals_owner').on(table.owner_id),
    index('idx_bond_deals_company').on(table.company_id),
    index('idx_bond_deals_close').on(table.expected_close_date).where(sql`closed_at IS NULL`),
    index('idx_bond_deals_stale').on(table.stage_entered_at).where(sql`closed_at IS NULL`),
  ],
);
