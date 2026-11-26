-- 0226_platform_backups.sql
-- Why: Backup app (Platform scope). Records whole-database pg_dump backups and
--      restore runs so a SuperUser can list, download, trigger, and restore them
--      from the console. Platform-level operational metadata, not org data.
-- Client impact: additive only (two new SuperUser-only tables; no existing table touched).

-- Backups: one row per whole-database pg_dump archive (custom format, -Fc).
-- Platform-scoped and SuperUser-only, so deliberately NO organization_id and NO
-- RLS policy (these rows are never visible to org-scoped callers). The `scope`
-- column is a forward hook for the deferred organization/project logical exports.
CREATE TABLE IF NOT EXISTS platform_backups (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                 text NOT NULL DEFAULT 'platform'
                          CHECK (scope IN ('platform')),
  kind                  text NOT NULL
                          CHECK (kind IN ('manual', 'scheduled')),
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  storage_key           text,           -- object key in the backup bucket; null until upload completes
  size_bytes            bigint,
  pg_version            text,           -- server version_num captured at dump time (restore compatibility)
  integrity             text,           -- etag/checksum returned by the storage driver
  triggered_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at            timestamptz,
  completed_at          timestamptz,
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_backups_created_at
  ON platform_backups (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_backups_status
  ON platform_backups (status);

-- Restores: one row per restore run, for audit + progress. A restore is
-- destructive (pg_restore --clean over the live database), so the typed
-- confirmation phrase the SuperUser entered is stored for the audit trail.
CREATE TABLE IF NOT EXISTS platform_restores (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id              uuid REFERENCES platform_backups(id) ON DELETE SET NULL,
  status                 text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  requested_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmation_phrase    text,           -- what the operator typed to authorize the destructive restore
  started_at             timestamptz,
  completed_at           timestamptz,
  error                  text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_restores_created_at
  ON platform_restores (created_at DESC);
