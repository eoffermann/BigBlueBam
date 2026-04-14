import { pgTable, uuid, varchar, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { users } from './users.js';
import { projects } from './projects.js';

/**
 * Canonical mirror of apps/beacon-api/src/db/schema/beacon-entries.ts for
 * cross-app consumers (e.g. brief-api). Uses `varchar` for status/visibility
 * rather than the beacon-api-owned pgEnum to avoid duplicate enum
 * declarations when both this package and the beacon-api schema are loaded
 * into the same drizzle universe. The live database still enforces the
 * canonical enum via migration 0036.
 */
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
    status: varchar('status', { length: 50 }).default('Draft').notNull(),
    visibility: varchar('visibility', { length: 50 }).default('Project').notNull(),
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
