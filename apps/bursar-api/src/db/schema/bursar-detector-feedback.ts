import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bursarMismatches } from './bursar-mismatches.js';

/**
 * Detector mark-wrong feedback loop (spec 8, migration 0250): a human verdict on whether a
 * detector fired correctly, feeding threshold calibration.
 */
export const bursarDetectorFeedback = pgTable(
  'bursar_detector_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    mismatch_id: uuid('mismatch_id')
      .notNull()
      .references(() => bursarMismatches.id, { onDelete: 'cascade' }),
    detector: varchar('detector', { length: 48 }).notNull(),
    // wrong | right
    verdict: varchar('verdict', { length: 16 }).notNull(),
    reason: text('reason'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bursar_detector_feedback_mismatch').on(table.organization_id, table.mismatch_id),
    index('idx_bursar_detector_feedback_detector').on(table.organization_id, table.detector, table.verdict),
  ],
);
