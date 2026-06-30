import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  bigint,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

/**
 * blip_entries: the append-only telemetry store (Blip §5).
 *
 * Range-partitioned monthly by received_at (the partitioning and the
 * blip_entry_seq sequence live in raw migration SQL; Drizzle declares the
 * columns only). One row per accepted, redacted report. The full redacted
 * report is kept verbatim in `payload`; a small set of reserved fields is
 * promoted to typed, indexed columns for fast filter/sort.
 *
 * No FK references are declared here: the table is created by the partitioning
 * migration (the source of truth), and the hot insert path avoids FK overhead.
 */
export const blipEntries = pgTable(
  'blip_entries',
  {
    received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    id: uuid('id').notNull().defaultRandom(),
    // Shared monotonic sequence: stable cursor + live-tail resume across partitions.
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    org_id: uuid('org_id').notNull(),
    tracked_app_id: uuid('tracked_app_id').notNull(),
    report_type: text('report_type').notNull(),
    ingest_key_id: uuid('ingest_key_id'),
    // --- promoted reserved fields (null when absent) ---
    client_ts: timestamp('client_ts', { withTimezone: true }),
    level: text('level'), // CHECK-constrained enum: debug|info|warn|error|fatal
    session_id: text('session_id'),
    app_version: text('app_version'),
    platform: text('platform'),
    elapsed_ms: doublePrecision('elapsed_ms'),
    capture_count: integer('capture_count').notNull().default(0),
    // --- the report itself (redacted), plus accounting ---
    payload: jsonb('payload').notNull(),
    payload_bytes: integer('payload_bytes').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.received_at, t.id] }),
    index('blip_entries_app_type_seq').on(t.tracked_app_id, t.report_type, t.seq),
    index('blip_entries_app_type_time').on(t.tracked_app_id, t.report_type, t.received_at),
    index('blip_entries_app_type_level').on(t.tracked_app_id, t.report_type, t.level),
    index('blip_entries_app_type_elapsed').on(t.tracked_app_id, t.report_type, t.elapsed_ms),
    index('blip_entries_app_type_captures').on(t.tracked_app_id, t.report_type, t.capture_count),
  ],
);
