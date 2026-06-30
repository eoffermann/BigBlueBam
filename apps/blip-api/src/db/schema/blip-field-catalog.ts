import { pgTable, uuid, text, boolean, bigint, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { blipTrackedApps } from './blip-tracked-apps.js';

/**
 * blip_field_catalog: observed-field catalog, upserted by the ingest worker
 * (Blip §7.3). Drives column pickers and sort options with zero client config.
 *   is_metric  -> included in the numeric Bench rollup
 *   is_indexed -> a btree expression index exists on payload->>field_path
 */
export const blipFieldCatalog = pgTable(
  'blip_field_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tracked_app_id: uuid('tracked_app_id')
      .notNull()
      .references(() => blipTrackedApps.id, { onDelete: 'cascade' }),
    report_type: text('report_type').notNull(),
    field_path: text('field_path').notNull(), // 'payload:fn', 'level', ...
    inferred_type: text('inferred_type').notNull(), // 'string'|'number'|'bool'|'object'|'array'|'mixed'
    is_metric: boolean('is_metric').notNull().default(false),
    is_indexed: boolean('is_indexed').notNull().default(false),
    first_seen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    last_seen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
    observation_count: bigint('observation_count', { mode: 'bigint' }).notNull().default(0n),
  },
  (t) => [uniqueIndex('blip_field_catalog_uniq').on(t.tracked_app_id, t.report_type, t.field_path)],
);
