import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  numeric,
  boolean,
  jsonb,
  date,
  timestamp,
  customType,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { burnEngagements } from './burn-engagements.js';
import { burnExtractionRuns } from './burn-extraction-runs.js';

// Drizzle has no first-class tsvector column kind. This is the platform idiom, from
// apps/braid-api/src/db/schema/braid-profiles.ts:15-18 (which in turn mirrors the helpdesk
// tickets.ts). Declaring it as text() instead would leave scripts/db-check.mjs emitting a
// NON-FATAL type warning at :468 rather than catching anything, which is why the idiom is
// named explicitly here (spec 3, R2-B8d).
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * One priced line of what was actually sold (spec 3.1).
 *
 * `dedup_key` is `hash(normalized_clause_ref, deliverable_kind, ordinal)` by ascending
 * `cited_span.char_start`; for null-section items it is `hash(verified_quote_content, kind)`
 * tied to `source_doc_hash`. LLM prose is never in the identity hash.
 *
 * AN AMENDMENT DELIVERABLE IS A PURE ENVELOPE-DELTA CARRIER (round-3 blocker R3-D2).
 * A row with `amends_deliverable_id IS NOT NULL` is NEVER an attribution target: it is
 * excluded from candidate assembly (2.3.4) and from all three deterministic resolution
 * paths in the gate (5.3), never rendered in DeliverablePicker, and any attribution naming
 * one resolves to its base row in the service layer. Its activation has its OWN state
 * (`delta_confirmed_by` / `delta_confirmed_at`, set on `proposal.decided`) precisely so
 * that `is_active` keeps exactly one writer.
 *
 * `effective_envelope = envelope_amount + sum(envelope_amount_delta)` over the
 * deliverable's `delta_confirmed_at IS NOT NULL` amendment set. Consumption stays on the
 * BASE row, so no attribution migration is needed and ON DELETE RESTRICT is never violated.
 *
 * `is_active` has EXACTLY ONE WRITER: POST /v1/deliverables/:id/confirm-envelope under
 * `burn.envelope.confirm` (spec 2.2.1). Not PATCH, not the MCP tool, not any
 * service-account token on any path. That single-writer property is a security boundary.
 *
 * `envelope_amount` NULL means UNPRICED: hours only, and it can never produce a deny.
 *
 * `description` and `cited_span->>'quote'` are `burn.financials.read_all`-floored (R2-S9):
 * both are clause content, one paraphrase removed, and Bin's private assets have no
 * org-admin bypass. `title` is the member-visible handle. A floored field that stays
 * searchable is not floored (R3-S4), so no member-reachable endpoint may filter, sort,
 * rank, or highlight on `search_tsv`; a member-tier `q` filter matches `title` only,
 * through the separate GIN trigram index.
 *
 * `supersedes_deliverable_id` and `amends_deliverable_id` are self-FKs declared in
 * migration 0239 via guarded DO $$ blocks, not here, to avoid a circular self-reference in
 * Drizzle. `search_tsv` is a GENERATED ALWAYS ... STORED column defined in the migration.
 */
export const burnDeliverables = pgTable(
  'burn_deliverables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    engagement_id: uuid('engagement_id')
      .notNull()
      .references(() => burnEngagements.id, { onDelete: 'cascade' }),
    dedup_key: varchar('dedup_key', { length: 64 }).notNull(),
    clause_ref: varchar('clause_ref', { length: 64 }),
    title: varchar('title', { length: 512 }).notNull(),
    description: text('description'),
    // work_product | milestone | recurring_service | support | expense_allowance | other
    deliverable_kind: varchar('deliverable_kind', { length: 32 }).notNull().default('work_product'),
    amends_deliverable_id: uuid('amends_deliverable_id'),
    envelope_amount_delta: bigint('envelope_amount_delta', { mode: 'number' }),
    envelope_amount: bigint('envelope_amount', { mode: 'number' }),
    envelope_hours: numeric('envelope_hours', { precision: 10, scale: 2 }),
    // proposed | human | stated | unpriced. ('even_split' is deliberately deleted.)
    envelope_source: varchar('envelope_source', { length: 24 }).notNull().default('proposed'),
    // open | complete | closed. 'closed' is what makes verdict_reason='deliverable_closed'
    // reachable at all.
    lifecycle_status: varchar('lifecycle_status', { length: 16 }).notNull().default('open'),
    cited_span: jsonb('cited_span').notNull().default({}),
    due_date: date('due_date'),
    confidence: numeric('confidence', { precision: 5, scale: 2 }),
    // pending_review | confirmed | rejected | superseded
    review_status: varchar('review_status', { length: 16 }).notNull().default('pending_review'),
    is_active: boolean('is_active').notNull().default(false),
    delta_confirmed_by: uuid('delta_confirmed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    delta_confirmed_at: timestamp('delta_confirmed_at', { withTimezone: true }),
    supersedes_deliverable_id: uuid('supersedes_deliverable_id'),
    search_tsv: tsvector('search_tsv'),
    qdrant_point_id: uuid('qdrant_point_id'),
    qdrant_synced_at: timestamp('qdrant_synced_at', { withTimezone: true }),
    reviewed_by: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
    envelope_confirmed_by: uuid('envelope_confirmed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    envelope_confirmed_at: timestamp('envelope_confirmed_at', { withTimezone: true }),
    extraction_run_id: uuid('extraction_run_id').references(() => burnExtractionRuns.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_burn_deliverables_dedup').on(
      table.organization_id,
      table.engagement_id,
      table.dedup_key,
    ),
    index('idx_burn_deliverables_org_engagement').on(table.organization_id, table.engagement_id),
    index('idx_burn_deliverables_org_review').on(table.organization_id, table.review_status),
    index('idx_burn_deliverables_org_lifecycle').on(table.organization_id, table.lifecycle_status),
    index('idx_burn_deliverables_org_due').on(table.organization_id, table.due_date),
    index('idx_burn_deliverables_amends').on(table.amends_deliverable_id),
  ],
);
