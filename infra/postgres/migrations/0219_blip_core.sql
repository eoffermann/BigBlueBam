-- 0219_blip_core.sql
-- Why: Create the Blip telemetry app's non-partitioned core tables (tracked
--   apps, ingest keys, field catalog, saved views, watches + watch events,
--   transforms, retention policies, timelapse jobs). The append-only
--   blip_entries store is partitioned and lives in 0220.
-- Client impact: additive only (new app, no existing tables touched).

CREATE TABLE IF NOT EXISTS blip_tracked_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  collection_enabled BOOLEAN NOT NULL DEFAULT true,
  rate_limit JSONB,
  transform_version INTEGER NOT NULL DEFAULT 1,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS blip_tracked_apps_org_idx ON blip_tracked_apps (org_id);

CREATE TABLE IF NOT EXISTS blip_ingest_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tracked_app_id UUID NOT NULL REFERENCES blip_tracked_apps(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  secret_hmac TEXT NOT NULL,
  last4 TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  rate_limit_override JSONB,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS blip_ingest_keys_key_id ON blip_ingest_keys (key_id);
CREATE INDEX IF NOT EXISTS blip_ingest_keys_app_idx ON blip_ingest_keys (tracked_app_id);

CREATE TABLE IF NOT EXISTS blip_field_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tracked_app_id UUID NOT NULL REFERENCES blip_tracked_apps(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL,
  field_path TEXT NOT NULL,
  inferred_type TEXT NOT NULL,
  is_metric BOOLEAN NOT NULL DEFAULT false,
  is_indexed BOOLEAN NOT NULL DEFAULT false,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observation_count BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS blip_field_catalog_uniq
  ON blip_field_catalog (tracked_app_id, report_type, field_path);

CREATE TABLE IF NOT EXISTS blip_saved_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tracked_app_id UUID NOT NULL REFERENCES blip_tracked_apps(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'private',
  is_default BOOLEAN NOT NULL DEFAULT false,
  spec JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS blip_saved_views_app_type_idx
  ON blip_saved_views (tracked_app_id, report_type);

CREATE TABLE IF NOT EXISTS blip_watches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tracked_app_id UUID NOT NULL REFERENCES blip_tracked_apps(id) ON DELETE CASCADE,
  report_type TEXT,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  predicate JSONB NOT NULL,
  cooldown_sec INTEGER NOT NULL DEFAULT 60,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_fired_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS blip_watches_app_idx ON blip_watches (tracked_app_id);

CREATE TABLE IF NOT EXISTS blip_watch_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  watch_id UUID NOT NULL REFERENCES blip_watches(id) ON DELETE CASCADE,
  tracked_app_id UUID NOT NULL REFERENCES blip_tracked_apps(id) ON DELETE CASCADE,
  report_type TEXT,
  event_name TEXT NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  context JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS blip_watch_events_watch_idx ON blip_watch_events (watch_id, fired_at);

CREATE TABLE IF NOT EXISTS blip_transforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tracked_app_id UUID NOT NULL REFERENCES blip_tracked_apps(id) ON DELETE CASCADE,
  report_type TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  rules JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS blip_transforms_app_idx ON blip_transforms (tracked_app_id);

CREATE TABLE IF NOT EXISTS blip_retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tracked_app_id UUID NOT NULL REFERENCES blip_tracked_apps(id) ON DELETE CASCADE,
  report_type TEXT,
  max_age_days INTEGER,
  max_rows BIGINT,
  max_bytes BIGINT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS blip_retention_policies_app_idx ON blip_retention_policies (tracked_app_id);

CREATE TABLE IF NOT EXISTS blip_timelapse_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tracked_app_id UUID NOT NULL REFERENCES blip_tracked_apps(id) ON DELETE CASCADE,
  report_type TEXT,
  params JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  frame_count INTEGER,
  video_asset_ref JSONB,
  error TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS blip_timelapse_jobs_app_idx ON blip_timelapse_jobs (tracked_app_id, created_at);
