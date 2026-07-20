import { pgTable, pgEnum, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

// Local Drizzle view of the shared entity_links table (migration 0132). Bursar writes it
// directly at award (bursar.award -> bursar.request | bursar.offer | bursar.vendor | bin.asset,
// spec 16.3), including the Bulwark handoff edge to the contract asset.
//
// NOTE the column-name boundary: entity_links uses `org_id`, every bursar_* table uses
// `organization_id`. Getting this backwards is a compile error, which is the point of this
// local view. This mirrors apps/burn-api/src/db/schema/entity-links.ts.
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
