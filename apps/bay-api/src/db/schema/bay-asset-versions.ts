import {
  pgTable,
  uuid,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';
import { bayAssets } from './bay-assets.js';

// Bay asset versions (Bay master). Versions are immutable and monotonic per
// asset (unique (asset_id, version_number)). Each version points at the Bin
// asset/version holding the canonical bytes (bin_asset_id / bin_version_id,
// nullable until the upload lands in Bin) and carries denormalized media_meta
// (duration_sec, width, height, codec, ...) used by the review UI without a
// round-trip to Bin.
export const bayAssetVersions = pgTable(
  'bay_asset_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    asset_id: uuid('asset_id')
      .notNull()
      .references(() => bayAssets.id, { onDelete: 'cascade' }),
    version_number: integer('version_number').notNull(),
    // The Bin asset/version holding the canonical bytes (nullable until bytes
    // are registered in Bin).
    bin_asset_id: uuid('bin_asset_id'),
    bin_version_id: uuid('bin_version_id'),
    // Denormalized media metadata: duration_sec, width, height, codec, etc.
    media_meta: jsonb('media_meta').default({}).notNull(),
    uploaded_by: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_bay_asset_versions_asset_number').on(table.asset_id, table.version_number),
    index('idx_bay_asset_versions_asset').on(table.asset_id),
  ],
);
