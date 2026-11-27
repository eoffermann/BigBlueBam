import { pgTable, pgEnum, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { users } from './users.js';

/**
 * Durable cross-app entity links (AGENTIC_TODO §16, Wave 4, migration 0132).
 *
 * Replaces the "every app has its own FK column" pattern with a single
 * additive table that agents can query to answer "everything linked to this
 * entity" in one call. Existing per-app FKs are retained; this table is
 * populated in lockstep by the per-app write paths and was backfilled from
 * the known FK columns at migration time.
 *
 * Semantics:
 *   - Directional only. `parent_of` is the forward direction; the "child"
 *     relationship is queried by filtering on dst.
 *   - `(src_type, src_id, dst_type, dst_id, link_kind)` is unique (enforced
 *     by the entity_links_unique index). Re-creating an identical link is a
 *     no-op for callers that pass `idempotent: true`.
 *
 * RLS: org-isolated via `NULLIF(current_setting('app.current_org_id', true), '')::uuid` (0355).
 */
export const entityLinkKindEnum = pgEnum('entity_link_kind', [
  'related_to',
  'duplicates',
  'blocks',
  'references',
  'parent_of',
  'derived_from',
]);

export const entityLinks = pgTable(
  'entity_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    src_type: text('src_type').notNull(),
    src_id: uuid('src_id').notNull(),
    dst_type: text('dst_type').notNull(),
    dst_id: uuid('dst_id').notNull(),
    link_kind: entityLinkKindEnum('link_kind').notNull(),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('entity_links_unique').on(
      table.src_type,
      table.src_id,
      table.dst_type,
      table.dst_id,
      table.link_kind,
    ),
    index('idx_entity_links_src').on(table.src_type, table.src_id),
    index('idx_entity_links_dst').on(table.dst_type, table.dst_id),
    index('idx_entity_links_org_created').on(table.org_id, table.created_at),
  ],
);
