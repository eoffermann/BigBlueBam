import {
  pgTable,
  uuid,
  varchar,
  bigint,
  timestamp,
  index,
  text,
  doublePrecision,
  jsonb,
} from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';
import { binFolders } from './bin-folders.js';

// Bin DAM assets (Bin master §9.1). An asset is the catalog entry for a stored
// object; it carries a denormalized current_version_id plus the active-version
// reference shape (binding_id, object_key, size, integrity, content_type — §5.4)
// and does NOT store the provider id directly (reads resolve binding_id ->
// active provider). scan_status gates serving (§9.3): a `pending` asset is
// listable but not served by a presigned GET until the AV scan marks it clean.
//
// Note: current_version_id references bin_asset_versions, but that table
// references bin_assets, so the FK is added in the migration (not via a Drizzle
// .references() here) to avoid a circular import / chicken-and-egg insert.
export const binAssets = pgTable(
  'bin_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    folder_id: uuid('folder_id').references(() => binFolders.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 512 }).notNull(),
    content_type: varchar('content_type', { length: 255 }).notNull(),
    // Denormalized pointer to the active version (FK declared in migration).
    current_version_id: uuid('current_version_id'),
    // Active-version reference shape (§5.4). binding_id is nullable until the
    // per-org binding resolver lands; the bootstrap `local` provider has no
    // binding row yet.
    binding_id: uuid('binding_id'),
    object_key: varchar('object_key', { length: 1024 }).notNull(),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    integrity: varchar('integrity', { length: 255 }),
    // pending | clean | infected | error | skipped  (CHECK in migration).
    scan_status: varchar('scan_status', { length: 20 }).notNull().default('pending'),
    // Media transcode bookkeeping (0216). The worker generates a web-friendly
    // proxy + poster for clean media versions; serving prefers them. Reset to
    // 'pending' (and keys nulled) on every new version.
    // pending | done | skipped | error
    transcode_status: varchar('transcode_status', { length: 20 }).notNull().default('pending'),
    proxy_object_key: varchar('proxy_object_key', { length: 1024 }),
    poster_object_key: varchar('poster_object_key', { length: 1024 }),
    proxy_content_type: varchar('proxy_content_type', { length: 255 }),
    duration_sec: doublePrecision('duration_sec'),
    // Probe metadata describing the bytes (0223). For models: bounds, counts,
    // skeleton, animations, source up-axis/unit (Bay FBX §3). Copied forward to
    // bay_asset_versions.media_meta at version create so the viewer reads it
    // without a byte round-trip. Generic jsonb; null/{} for un-probed assets.
    media_meta: jsonb('media_meta'),
    // Persistent per-file scan override (0225). When scan_override_at is set an
    // admin/SuperUser has cleared this specific file's scan prohibition for
    // everyone (false-positive resolution): the serving gate treats it as
    // servable regardless of scan_status, including over Bay guest review links.
    // scan_overridden_by/scan_override_reason are the audit trail (who/why).
    scan_override_at: timestamp('scan_override_at', { withTimezone: true }),
    scan_overridden_by: uuid('scan_overridden_by'),
    scan_override_reason: text('scan_override_reason'),
    // organization | project | private (denormalized for the visibility gate).
    visibility: varchar('visibility', { length: 20 }).notNull().default('organization'),
    // Arbitrary user-applied tags for cross-cutting organization + filtering.
    tags: text('tags').array().notNull().default([]),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_bin_assets_org').on(table.org_id),
    index('idx_bin_assets_folder').on(table.folder_id),
    index('idx_bin_assets_project').on(table.project_id),
  ],
);
