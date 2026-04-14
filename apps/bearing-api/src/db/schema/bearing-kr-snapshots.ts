import { pgTable, uuid, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { bearingKeyResults } from './bearing-key-results.js';

export const bearingKrSnapshots = pgTable('bearing_kr_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  key_result_id: uuid('key_result_id').notNull().references(() => bearingKeyResults.id, { onDelete: 'cascade' }),
  value: numeric('value', { precision: 12, scale: 2 }).notNull(),
  progress: numeric('progress', { precision: 5, scale: 2 }).notNull(),
  recorded_at: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  // created_at lives in the DB from migration 0028 but was never declared in
  // Drizzle; db-check surfaced it as an unknown-in-Drizzle column after the
  // 0023 cold-start abort stopped masking drift. See migration 0078 for the
  // reconciliation pass that landed with this change.
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_bearing_kr_snapshots_kr').on(table.key_result_id),
  index('idx_bearing_kr_snapshots_date').on(table.recorded_at),
]);
