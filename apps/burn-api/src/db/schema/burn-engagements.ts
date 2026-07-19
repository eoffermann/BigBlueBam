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
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

/**
 * A priced engagement: an SOW, proposal, engagement letter, MSA, retainer, amendment, or
 * change order (spec 3.1).
 *
 * Chain semantics. `amends_engagement_id` ADDS to a live engagement: the base stays
 * `active`, its deliverables stay `is_active`, the amendment contributes
 * `contract_value_delta` plus its own deliverables, and both share `chain_root_id`.
 * `supersedes_engagement_id` is a genuine RESTATEMENT: the base becomes `superseded` and
 * attributions migrate by matching `dedup_key`, with unmatched attributions becoming
 * `pending_review` / `restatement_unmatched` rather than being silently dropped.
 *
 * `chain_root_id` is the denormalized chain root and ALL envelope math, rollups,
 * financials, and gate evaluation resolve over it, never over a single row.
 *
 * Both self-FKs (`amends_engagement_id`, `supersedes_engagement_id`, ON DELETE RESTRICT)
 * are declared in migration 0239 via guarded DO $$ blocks, not here, to avoid a circular
 * self-reference in Drizzle. `bin_asset_id`, `account_id`, `braid_profile_id`, and
 * `bill_client_id` are dotted cross-app refs with NO cross-schema FK (the entity_links
 * convention, spec 3 "join boundary").
 */
export const burnEngagements = pgTable(
  'burn_engagements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 512 }).notNull(),
    // sow | proposal | engagement_letter | msa | retainer | amendment | change_order | other
    engagement_kind: varchar('engagement_kind', { length: 32 }).notNull().default('sow'),
    amends_engagement_id: uuid('amends_engagement_id'),
    supersedes_engagement_id: uuid('supersedes_engagement_id'),
    chain_root_id: uuid('chain_root_id').notNull(),
    // Minor units. read_all-floored on every response (spec 2.4 point 17).
    contract_value: bigint('contract_value', { mode: 'number' }),
    // For an amendment. Chain value is sum(coalesce(contract_value_delta, contract_value)).
    contract_value_delta: bigint('contract_value_delta', { mode: 'number' }),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    // fixed | time_and_materials | retainer | not_to_exceed. Drives revenue_basis (spec 1.2.1).
    envelope_basis: varchar('envelope_basis', { length: 16 }).notNull().default('fixed'),
    // Required when envelope_basis='retainer' (CHECK in 0239).
    period_length_days: integer('period_length_days'),
    budget_hours: numeric('budget_hours', { precision: 10, scale: 2 }),
    bin_asset_id: uuid('bin_asset_id'),
    account_type: varchar('account_type', { length: 32 }),
    account_id: uuid('account_id'),
    braid_profile_id: uuid('braid_profile_id'),
    bill_client_id: uuid('bill_client_id'),
    start_date: date('start_date'),
    end_date: date('end_date'),
    // IANA. Retainer period boundaries are computed in this zone (spec 1.2.1).
    timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
    // draft | extracting | active | superseded | closed
    status: varchar('status', { length: 16 }).notNull().default('active'),
    // pending | running | extracted | partial | failed | rejected_limits | not_applicable
    extraction_status: varchar('extraction_status', { length: 16 }).notNull().default('pending'),
    source_doc_hash: varchar('source_doc_hash', { length: 64 }),
    extracted_at: timestamp('extracted_at', { withTimezone: true }),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_burn_engagements_org_status').on(table.organization_id, table.status),
    index('idx_burn_engagements_org_chain').on(table.organization_id, table.chain_root_id),
    index('idx_burn_engagements_org_account').on(
      table.organization_id,
      table.account_type,
      table.account_id,
    ),
    index('idx_burn_engagements_org_braid').on(table.organization_id, table.braid_profile_id),
    index('idx_burn_engagements_org_bin_asset').on(table.organization_id, table.bin_asset_id),
    index('idx_burn_engagements_amends').on(table.amends_engagement_id),
    index('idx_burn_engagements_supersedes').on(table.supersedes_engagement_id),
  ],
);
