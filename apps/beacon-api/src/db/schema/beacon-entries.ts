import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  customType,
} from 'drizzle-orm/pg-core';
import { users, organizations, projects } from './bbb-refs.js';

// Matches the declaration in apps/brief-api/src/db/schema/brief-documents.ts so
// Yjs binary state round-trips as a Buffer through the postgres-js driver.
const bytea = customType<{ data: Buffer; driverInput: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const beaconStatusEnum = pgEnum('beacon_status', [
  'Draft',
  'Active',
  'PendingReview',
  'Expired',
  'Archived',
  'Retired',
]);

export const beaconVisibilityEnum = pgEnum('beacon_visibility', [
  'Public',
  'Organization',
  'Project',
  'Private',
]);

export const beaconEntries = pgTable(
  'beacon_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 256 }).unique().notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    summary: text('summary'),
    body_markdown: text('body_markdown').notNull(),
    body_html: text('body_html'),
    version: integer('version').default(1).notNull(),
    status: beaconStatusEnum('status').default('Draft').notNull(),
    visibility: beaconVisibilityEnum('visibility').default('Project').notNull(),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    owned_by: uuid('owned_by')
      .notNull()
      .references(() => users.id),
    project_id: uuid('project_id').references(() => projects.id),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    last_verified_at: timestamp('last_verified_at', { withTimezone: true }),
    last_verified_by: uuid('last_verified_by').references(() => users.id),
    verification_count: integer('verification_count').default(0).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    retired_at: timestamp('retired_at', { withTimezone: true }),
    vector_id: varchar('vector_id', { length: 128 }),
    metadata: jsonb('metadata').default({}),
    // T4 real-time co-editing — 0203_beacon_yjs_state.sql
    // Binary Yjs CRDT state for the collaborative body (ydoc.getText('body')).
    // NULL until the first edit; on first room open the Y.Doc is seeded from
    // body_markdown so legacy markdown articles open intact.
    yjs_state: bytea('yjs_state'),
    // Tracks the last time the Yjs persistence service flushed yjs_state so we
    // can debounce redundant writes. NOT a substitute for updated_at: body
    // autosave deliberately leaves updated_at alone (the stale-write guard).
    yjs_last_saved_at: timestamp('yjs_last_saved_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_beacon_entries_org_project_status').on(
      table.organization_id,
      table.project_id,
      table.status,
    ),
    index('idx_beacon_entries_slug').on(table.slug),
  ],
);
