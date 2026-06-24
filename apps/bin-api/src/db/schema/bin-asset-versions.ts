import {
  pgTable,
  uuid,
  varchar,
  bigint,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';
import { binAssets } from './bin-assets.js';

// Bin asset versions (Bin master §9.1). Versions are IMMUTABLE — each upload
// or structured-editor commit mints a new row; you never edit a version in
// place. version_number is monotonic per asset (unique (asset_id, version_number)).
// Like the asset, a version stores (binding_id, object_key, size, integrity,
// content_type) and does NOT store the provider id directly (§5.4); reads
// resolve binding_id -> active provider.
export const binAssetVersions = pgTable(
  'bin_asset_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    asset_id: uuid('asset_id')
      .notNull()
      .references(() => binAssets.id, { onDelete: 'cascade' }),
    version_number: integer('version_number').notNull(),
    // Storage binding the bytes live on (nullable until the per-org binding
    // resolver lands; the bootstrap `local` provider has no binding row yet).
    binding_id: uuid('binding_id'),
    object_key: varchar('object_key', { length: 1024 }).notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    integrity: varchar('integrity', { length: 255 }),
    content_type: varchar('content_type', { length: 255 }).notNull(),
    uploaded_by: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_bin_asset_versions_asset_number').on(table.asset_id, table.version_number),
    index('idx_bin_asset_versions_asset').on(table.asset_id),
  ],
);
