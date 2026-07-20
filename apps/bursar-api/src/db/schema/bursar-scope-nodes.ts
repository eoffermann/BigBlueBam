import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bursarRequests } from './bursar-requests.js';
import { bursarExtractionRuns } from './bursar-extraction-runs.js';

/**
 * Derived scope tree (spec 6.1, migration 0247). parent_id is a guarded self-FK (RESTRICT)
 * declared in the migration, not here, to avoid a circular self-reference in Drizzle.
 * Soft-archive only (archived_at). Unique (organization_id, request_id, dedup_key).
 */
export const bursarScopeNodes = pgTable(
  'bursar_scope_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    request_id: uuid('request_id')
      .notNull()
      .references(() => bursarRequests.id, { onDelete: 'cascade' }),
    // Self-FK (RESTRICT) declared in migration 0247.
    parent_id: uuid('parent_id'),
    path: text('path'),
    ordinal: integer('ordinal').notNull().default(0),
    title: varchar('title', { length: 512 }).notNull(),
    description: text('description'),
    node_kind: varchar('node_kind', { length: 32 }).notNull().default('requirement'),
    // mandatory | should_have | nice_to_have | informational
    normative_strength: varchar('normative_strength', { length: 16 }).notNull().default('mandatory'),
    unit: varchar('unit', { length: 32 }),
    quantity: numeric('quantity', { precision: 18, scale: 4 }),
    derived_from: varchar('derived_from', { length: 24 }),
    contributing_offer_ids: uuid('contributing_offer_ids').array().notNull().default([]),
    cited_span: jsonb('cited_span').notNull().default({}),
    confidence: numeric('confidence', { precision: 5, scale: 2 }),
    review_status: varchar('review_status', { length: 16 }).notNull().default('pending_review'),
    dedup_key: varchar('dedup_key', { length: 64 }).notNull(),
    extraction_run_id: uuid('extraction_run_id').references(() => bursarExtractionRuns.id, {
      onDelete: 'set null',
    }),
    tree_suspect: boolean('tree_suspect').notNull().default(false),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_scope_nodes_dedup').on(table.organization_id, table.request_id, table.dedup_key),
    index('idx_bursar_scope_nodes_org_request').on(table.organization_id, table.request_id),
    index('idx_bursar_scope_nodes_parent').on(table.parent_id),
    index('idx_bursar_scope_nodes_org_strength').on(
      table.organization_id,
      table.request_id,
      table.normative_strength,
    ),
  ],
);
