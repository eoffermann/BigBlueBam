import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  index,
  customType,
} from 'drizzle-orm/pg-core';
import { users, organizations, projects, beaconEntries } from './bbb-refs.js';
import { briefFolders } from './brief-folders.js';
import { briefTemplates } from './brief-templates.js';

const bytea = customType<{ data: Buffer; driverInput: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const briefDocumentStatusEnum = pgEnum('brief_document_status', [
  'draft',
  'in_review',
  'approved',
  'archived',
]);

export const briefVisibilityEnum = pgEnum('brief_visibility', [
  'private',
  'project',
  'organization',
]);

export const briefDocuments = pgTable(
  'brief_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    folder_id: uuid('folder_id').references(() => briefFolders.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 512 }).default('Untitled').notNull(),
    slug: varchar('slug', { length: 300 }).unique().notNull(),
    yjs_state: bytea('yjs_state'),
    plain_text: text('plain_text'),
    html_snapshot: text('html_snapshot'),
    // Short editor-supplied abstract shown above the body. Kept current by the
    // collaborative meta-sync (yjs-persistence) and the PATCH/create routes.
    summary: text('summary'),
    icon: varchar('icon', { length: 100 }),
    cover_image_url: text('cover_image_url'),
    template_id: uuid('template_id').references(() => briefTemplates.id, { onDelete: 'set null' }),
    status: briefDocumentStatusEnum('status').default('draft').notNull(),
    visibility: briefVisibilityEnum('visibility').default('project').notNull(),
    pinned: boolean('pinned').default(false).notNull(),
    word_count: integer('word_count').default(0).notNull(),
    promoted_to_beacon_id: uuid('promoted_to_beacon_id').references(() => beaconEntries.id, {
      onDelete: 'set null',
    }),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    updated_by: uuid('updated_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    // Wave 2 — 0103_brief_yjs_state_tracking.sql
    // Tracks the last time Hocuspocus persistence flushed yjs_state so we can
    // debounce redundant writes and skip re-embedding documents whose binary
    // state has not changed.
    yjs_last_saved_at: timestamp('yjs_last_saved_at', { withTimezone: true }),
    // Wave 2 — 0104_brief_qdrant_embedded_at.sql
    // NULL until the document has been chunked, embedded, and upserted into
    // the Qdrant `brief_documents` collection. Compared against updated_at to
    // detect stale embeddings that need re-indexing.
    qdrant_embedded_at: timestamp('qdrant_embedded_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_brief_documents_org_project_status').on(
      table.org_id,
      table.project_id,
      table.status,
    ),
    index('idx_brief_documents_folder_id').on(table.folder_id),
    index('idx_brief_documents_slug').on(table.slug),
    index('idx_brief_documents_created_by').on(table.created_by),
    index('idx_brief_documents_updated_at').on(table.updated_at),
  ],
);
