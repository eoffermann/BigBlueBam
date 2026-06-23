-- 0203_beacon_yjs_state.sql
-- Why: Beacon T4 real-time co-editing. Each beacon entry becomes a Yjs room
--      whose binary CRDT state is persisted here; yjs_last_saved_at drives the
--      30s debounce + skip-redundant-write logic (mirrors Brief's 0103).
-- Client impact: additive only. Two nullable columns + two indexes. No data
--      migration; existing entries keep their body_markdown and seed the Y.Doc
--      lazily on first room open.

ALTER TABLE beacon_entries
  ADD COLUMN IF NOT EXISTS yjs_state BYTEA;

ALTER TABLE beacon_entries
  ADD COLUMN IF NOT EXISTS yjs_last_saved_at TIMESTAMPTZ;

-- Fast "does this entry already have collaborative state?" lookup, scoped to
-- the (id, org) pair the persistence service loads by.
CREATE INDEX IF NOT EXISTS idx_beacon_entries_yjs_lookup
  ON beacon_entries(id, organization_id)
  WHERE yjs_state IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_beacon_entries_yjs_last_saved
  ON beacon_entries(yjs_last_saved_at);
