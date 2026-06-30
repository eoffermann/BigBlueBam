import { pgTable, uuid, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { blipTrackedApps } from './blip-tracked-apps.js';

/**
 * blip_saved_views: a reusable view over one (tracked_app, report_type) (Blip
 * §7.2). Optional; a report type is fully usable without any. `scope` controls
 * sharing: 'private' is visible only to the owner, 'org' to anyone who
 * can_access the tracked_app.
 */
export const blipSavedViews = pgTable(
  'blip_saved_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tracked_app_id: uuid('tracked_app_id')
      .notNull()
      .references(() => blipTrackedApps.id, { onDelete: 'cascade' }),
    report_type: text('report_type').notNull(),
    name: text('name').notNull(),
    owner_id: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().default('private'), // 'private' | 'org'
    is_default: boolean('is_default').notNull().default(false),
    // { filter, columns:[{field,label?,width?}], sort:[{field,dir}],
    //   liveTail:boolean, pageSize:number }
    spec: jsonb('spec').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('blip_saved_views_app_type_idx').on(t.tracked_app_id, t.report_type)],
);
