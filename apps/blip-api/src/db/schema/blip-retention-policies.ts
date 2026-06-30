import { pgTable, uuid, text, integer, bigint, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { blipTrackedApps } from './blip-tracked-apps.js';

/**
 * blip_retention_policies: policy per (tracked_app, report_type) with a
 * tracked-app default (report_type null) (Blip §11.2). A new app is seeded with
 * a 14-day app-wide default; removing the age limit is an explicit edit.
 */
export const blipRetentionPolicies = pgTable(
  'blip_retention_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tracked_app_id: uuid('tracked_app_id')
      .notNull()
      .references(() => blipTrackedApps.id, { onDelete: 'cascade' }),
    report_type: text('report_type'), // null = the app-wide default
    max_age_days: integer('max_age_days'), // null = no age limit
    max_rows: bigint('max_rows', { mode: 'bigint' }),
    max_bytes: bigint('max_bytes', { mode: 'bigint' }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('blip_retention_policies_app_idx').on(t.tracked_app_id)],
);
