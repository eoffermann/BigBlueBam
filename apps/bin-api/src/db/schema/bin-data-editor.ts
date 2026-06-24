import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './bbb-refs.js';
import { binAssets } from './bin-assets.js';

// Postgres BYTEA <-> Node Buffer. Holds the debounced Yjs CRDT snapshot for a
// live editing session (mirrors Brief's yjs_state column). Reused here rather
// than imported so bin-api owns its own schema surface.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// Live editing buffer over a Bin asset (Bin master §10.4/§11, D-3). One active
// session per (asset, branch). The CRDT binary lives here BETWEEN commits so a
// session survives reconnects without minting a version per keystroke — the
// canonical artifact remains the immutable asset version, this is just a buffer.
export const binDataSessions = pgTable(
  'bin_data_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    asset_id: uuid('asset_id')
      .notNull()
      .references(() => binAssets.id, { onDelete: 'cascade' }),
    base_version_id: uuid('base_version_id').notNull(),
    branch: text('branch').notNull().default('main'),
    shape: text('shape').notNull(), // 'record' | 'tree' (CHECK in migration)
    yjs_state: bytea('yjs_state'),
    dialect: jsonb('dialect').notNull().default({}),
    schema_source: text('schema_source').notNull(), // 'sidecar' | 'pinned' | 'inferred'
    schema_json: jsonb('schema_json'),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    last_flushed_at: timestamp('last_flushed_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('bin_data_sessions_one_active').on(table.asset_id, table.branch)],
);

// Confirmed/pinned or sidecar-linked schemas for an asset's structured data
// (Bin master §10.2). At most one pinned schema per asset.
export const binDataSchemas = pgTable(
  'bin_data_schemas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    asset_id: uuid('asset_id')
      .notNull()
      .references(() => binAssets.id, { onDelete: 'cascade' }),
    source: text('source').notNull(), // 'pinned' | 'sidecar'
    schema_json: jsonb('schema_json').notNull(),
    sidecar_asset_id: uuid('sidecar_asset_id'),
    pinned_by: uuid('pinned_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bin_data_schemas_asset').on(table.asset_id),
    uniqueIndex('bin_data_schemas_one_pinned')
      .on(table.asset_id)
      .where(sql`source = 'pinned'`),
  ],
);

// Anchored review comments on cells/paths (Bin master §10.7). Authored by humans
// or agents identically; gated by the parent asset's visibility predicate.
export const binDataComments = pgTable(
  'bin_data_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    asset_id: uuid('asset_id')
      .notNull()
      .references(() => binAssets.id, { onDelete: 'cascade' }),
    version_id: uuid('version_id').notNull(),
    shape: text('shape').notNull(), // 'record' | 'tree'
    anchor: jsonb('anchor').notNull(), // record: { rid, colId? } ; tree: { pointer }
    body: text('body').notNull(), // markdown
    author_id: uuid('author_id').references(() => users.id),
    thread_parent_id: uuid('thread_parent_id'),
    resolved: boolean('resolved').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bin_data_comments_asset').on(table.asset_id),
    index('idx_bin_data_comments_thread').on(table.thread_parent_id),
  ],
);
