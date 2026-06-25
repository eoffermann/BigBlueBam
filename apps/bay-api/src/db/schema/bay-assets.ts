import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';

// Bay review assets (Bay master). A Bay asset is the review-and-approval catalog
// entry for a piece of media. Unlike Bin, Bay is folder-less: organization is by
// project + review state, not a folder tree. The canonical bytes live in Bin;
// each Bay asset version references a Bin asset/version rather than storing bytes.
//
// Note: current_version_id references bay_asset_versions, but that table
// references bay_assets, so the FK is added in the migration (not via a Drizzle
// .references() here) to avoid a circular import / chicken-and-egg insert.
export const bayAssets = pgTable(
  'bay_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 512 }).notNull(),
    // image | video | audio | model  (CHECK in migration).
    media_kind: text('media_kind').notNull(),
    // Denormalized pointer to the active version (FK declared in migration).
    current_version_id: uuid('current_version_id'),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_bay_assets_org').on(table.org_id),
    index('idx_bay_assets_project').on(table.project_id),
  ],
);
