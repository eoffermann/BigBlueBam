import { pgTable, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { blipTrackedApps } from './blip-tracked-apps.js';

/**
 * blip_timelapse_jobs: a timelapse compilation job (Blip §23.4). The compiled
 * video is a Bin asset (video_asset_ref, content_type video/mp4) with its own
 * retention, independent of entry purges. Params are captured so a job is
 * reproducible and auditable.
 */
export const blipTimelapseJobs = pgTable(
  'blip_timelapse_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tracked_app_id: uuid('tracked_app_id')
      .notNull()
      .references(() => blipTrackedApps.id, { onDelete: 'cascade' }),
    report_type: text('report_type'),
    // { filter, order, frame_duration_sec, image_selection, max_dimension }
    params: jsonb('params').notNull(),
    status: text('status').notNull().default('queued'), // queued|running|ready|failed
    frame_count: integer('frame_count'),
    video_asset_ref: jsonb('video_asset_ref'), // Bin ref to the compiled MP4 when ready
    error: text('error'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('blip_timelapse_jobs_app_idx').on(t.tracked_app_id, t.created_at)],
);
