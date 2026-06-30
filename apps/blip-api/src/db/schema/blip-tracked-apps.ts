import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';

/**
 * blip_tracked_apps: the unit of control (Blip §3). Owns the collection on/off
 * switch, the default rate limit, the active transform version, and is the
 * gating entity for visibility (`blip.tracked_app`). Org-scoped.
 */
export const blipTrackedApps = pgTable(
  'blip_tracked_apps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description'),
    // Collection master switch. When false the ingest edge rejects with 409.
    collection_enabled: boolean('collection_enabled').notNull().default(true),
    // Default token-bucket params: { refill_per_sec, burst, max_body_bytes,
    // max_batch_count, max_capture_body_bytes, max_capture_bytes,
    // max_captures_per_report }. Null fields fall back to env defaults.
    rate_limit: jsonb('rate_limit'),
    // Active compiled-transform version; bumped on transform edits so the ingest
    // key cache invalidates and the edge applies the current ruleset.
    transform_version: integer('transform_version').notNull().default(1),
    owner_id: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('blip_tracked_apps_org_idx').on(t.org_id)],
);
