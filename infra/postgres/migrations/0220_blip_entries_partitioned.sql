-- 0220_blip_entries_partitioned.sql
-- Why: Create the append-only blip_entries telemetry store as a monthly
--   range-partitioned table (by received_at), mirroring the banter_messages
--   pattern (0124/0106) so the cheap bulk purge path is "drop a partition".
--   A shared blip_entry_seq sequence gives a monotonic cursor across partitions
--   for live-tail resume.
-- Client impact: additive only (new partitioned table + sequence).

-- Monotonic cursor sequence shared across all partitions (Blip §5).
CREATE SEQUENCE IF NOT EXISTS blip_entry_seq;

-- Partitioned parent. PK must include the partition key (received_at).
CREATE TABLE IF NOT EXISTS blip_entries (
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  seq BIGINT NOT NULL DEFAULT nextval('blip_entry_seq'),
  org_id UUID NOT NULL,
  tracked_app_id UUID NOT NULL,
  report_type TEXT NOT NULL,
  ingest_key_id UUID,
  client_ts TIMESTAMPTZ,
  level TEXT,
  session_id TEXT,
  app_version TEXT,
  platform TEXT,
  elapsed_ms DOUBLE PRECISION,
  capture_count INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  payload_bytes INTEGER NOT NULL,
  PRIMARY KEY (received_at, id),
  CONSTRAINT blip_entries_level_check
    CHECK (level IS NULL OR level IN ('debug', 'info', 'warn', 'error', 'fatal'))
) PARTITION BY RANGE (received_at);

-- Default partition catches anything outside explicit monthly ranges.
CREATE TABLE IF NOT EXISTS blip_entries_default PARTITION OF blip_entries DEFAULT;

-- Monthly partitions: 2 months back (seed backlog spans ~14 days, may cross a
-- month boundary) through 12 months ahead. The blip-partition-provision worker
-- keeps the leading edge topped up after this.
DO $$
DECLARE
  cur_date DATE;
  next_month DATE;
  part_name TEXT;
BEGIN
  cur_date := DATE_TRUNC('month', NOW())::date - INTERVAL '2 months';
  FOR i IN 0..14 LOOP
    next_month := cur_date + INTERVAL '1 month';
    part_name := 'blip_entries_' || TO_CHAR(cur_date, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF blip_entries FOR VALUES FROM (%L) TO (%L)',
      part_name, cur_date::text, next_month::text
    );
    cur_date := next_month;
  END LOOP;
END $$;

-- Indexes on the parent propagate to every partition (Blip §5).
CREATE INDEX IF NOT EXISTS blip_entries_app_type_seq
  ON blip_entries (tracked_app_id, report_type, seq);
CREATE INDEX IF NOT EXISTS blip_entries_app_type_time
  ON blip_entries (tracked_app_id, report_type, received_at);
CREATE INDEX IF NOT EXISTS blip_entries_app_type_level
  ON blip_entries (tracked_app_id, report_type, level);
CREATE INDEX IF NOT EXISTS blip_entries_app_type_elapsed
  ON blip_entries (tracked_app_id, report_type, elapsed_ms);
CREATE INDEX IF NOT EXISTS blip_entries_app_type_captures
  ON blip_entries (tracked_app_id, report_type, capture_count);
CREATE INDEX IF NOT EXISTS blip_entries_payload_gin
  ON blip_entries USING gin (payload jsonb_path_ops);
