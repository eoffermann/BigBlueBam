import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { blipWatches } from './blip-watches.js';
import { blipTrackedApps } from './blip-tracked-apps.js';

/**
 * blip_watch_events: append-only firing log for watches (Blip §12.1). Powers
 * watch history, dedup, and the watch health panel. Time-pruned (short
 * retention; operational, not the telemetry store).
 */
export const blipWatchEvents = pgTable(
  'blip_watch_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    watch_id: uuid('watch_id')
      .notNull()
      .references(() => blipWatches.id, { onDelete: 'cascade' }),
    tracked_app_id: uuid('tracked_app_id')
      .notNull()
      .references(() => blipTrackedApps.id, { onDelete: 'cascade' }),
    report_type: text('report_type'),
    event_name: text('event_name').notNull(), // 'entry.matched'|'window.breached'|'window.recovered'
    fired_at: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
    context: jsonb('context').notNull(),
  },
  (t) => [index('blip_watch_events_watch_idx').on(t.watch_id, t.fired_at)],
);
