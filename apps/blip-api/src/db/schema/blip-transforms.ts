import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { blipTrackedApps } from './blip-tracked-apps.js';

/**
 * blip_transforms: ordered redaction rules for a tracked_app, optionally
 * narrowed to one report_type (Blip §9). Compiled and cached per (tracked_app,
 * report_type); the active version is carried in the ingest-key cache so the
 * edge always applies the current ruleset.
 */
export const blipTransforms = pgTable(
  'blip_transforms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tracked_app_id: uuid('tracked_app_id')
      .notNull()
      .references(() => blipTrackedApps.id, { onDelete: 'cascade' }),
    report_type: text('report_type'), // null = applies to all report types for the app
    enabled: boolean('enabled').notNull().default(true),
    // [{ match: 'payload:user.email' | 'glob:*token*' | 'regex:...',
    //    action: 'drop' | 'mask' | 'hash' | 'truncate',
    //    params: { keep_last?: 4, max_len?: 256 } }, ...]
    rules: jsonb('rules').notNull(),
    version: integer('version').notNull().default(1),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('blip_transforms_app_idx').on(t.tracked_app_id)],
);
