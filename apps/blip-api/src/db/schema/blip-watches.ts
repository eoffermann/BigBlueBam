import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { blipTrackedApps } from './blip-tracked-apps.js';

/**
 * blip_watches: a server-side condition that emits a Bolt event when satisfied
 * (Blip §12.1). `match` reuses the §7.1 filter predicate; `window` holds the
 * window, aggregate, and comparator. Org-scoped operational config.
 */
export const blipWatches = pgTable(
  'blip_watches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tracked_app_id: uuid('tracked_app_id')
      .notNull()
      .references(() => blipTrackedApps.id, { onDelete: 'cascade' }),
    report_type: text('report_type'), // null = all report types for the app
    name: text('name').notNull(), // stable handle Bolt rules filter on
    description: text('description'),
    kind: text('kind').notNull(), // 'match' | 'window'
    enabled: boolean('enabled').notNull().default(true),
    predicate: jsonb('predicate').notNull(),
    cooldown_sec: integer('cooldown_sec').notNull().default(60),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    last_fired_at: timestamp('last_fired_at', { withTimezone: true }),
  },
  (t) => [index('blip_watches_app_idx').on(t.tracked_app_id)],
);
