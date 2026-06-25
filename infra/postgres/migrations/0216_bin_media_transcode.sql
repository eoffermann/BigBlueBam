-- 0216_bin_media_transcode.sql
-- Why: Bay media playback needs web-friendly proxies. Browsers cannot reliably
--      seek/scrub or even decode many source codecs (ProRes, HEVC, mkv, raw wav).
--      This adds transcode bookkeeping to bin_assets so the worker can generate a
--      H.264/AAC mp4 proxy + poster (video), an AAC proxy + waveform poster
--      (audio), and a downscaled poster (image) for any clean media version. The
--      proxy/poster object keys live alongside the canonical object_key and are
--      served via /assets/:id/raw?variant=proxy|poster.
-- Client impact: additive only. New nullable columns + one status column with a
--      'pending' default + one partial index. No data migration. Re-running is
--      safe (ADD COLUMN IF NOT EXISTS + IF NOT EXISTS index).

-- Derived-artifact bookkeeping. transcode_status drives the worker sweep:
--   pending  -> needs (re)transcode (default; reset on every new version)
--   done     -> proxy/poster ready (or image poster ready)
--   skipped  -> not transcodable (non-media, or codec we don't proxy)
--   error    -> ffmpeg/storage failure; original still served, no proxy
ALTER TABLE bin_assets ADD COLUMN IF NOT EXISTS transcode_status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE bin_assets ADD COLUMN IF NOT EXISTS proxy_object_key VARCHAR(1024);
ALTER TABLE bin_assets ADD COLUMN IF NOT EXISTS poster_object_key VARCHAR(1024);
ALTER TABLE bin_assets ADD COLUMN IF NOT EXISTS proxy_content_type VARCHAR(255);
ALTER TABLE bin_assets ADD COLUMN IF NOT EXISTS duration_sec DOUBLE PRECISION;

-- Sweep index: the worker claims clean, uploaded, not-yet-transcoded assets.
CREATE INDEX IF NOT EXISTS idx_bin_assets_transcode_pending
  ON bin_assets (created_at)
  WHERE transcode_status = 'pending';
