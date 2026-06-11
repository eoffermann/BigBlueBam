-- 0181_system_errors.sql
-- Why: Operators need a single place to see errors from every service
--      (api, worker, every satellite api, mcp-server, …) so the SuperUser
--      Console's Log Analysis tab can show what went wrong without
--      jumping between Railway log panes. Each service writes a row here
--      via the shared @bigbluebam/logging error handler whenever it
--      responds with a 5xx (or, for the worker, when a job fails).
-- Client impact: additive only. New table. No application code reads or
--      writes it until the matching package upgrade ships.

CREATE TABLE IF NOT EXISTS system_errors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service       varchar(40) NOT NULL,         -- 'api', 'worker', 'bureau-api', …
  request_id    varchar(80),                  -- pino requestId, nullable for worker jobs
  -- caller context (best-effort; nullable when the request was unauthenticated)
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  org_id        uuid REFERENCES organizations(id) ON DELETE SET NULL,
  method        varchar(10),                  -- HTTP method for api errors; null for worker
  route         varchar(255),                 -- route template ("/org/members/:userId") or worker job name
  status_code   integer,                      -- 5xx for HTTP; null for worker
  error_code    varchar(80),                  -- application-level code if known (e.g. 'INTERNAL_ERROR')
  message       text NOT NULL,                -- short human-readable summary
  stack         text,                         -- full stack trace, gated by size at write time
  payload       jsonb NOT NULL DEFAULT '{}',  -- arbitrary structured context (job id, queue name, etc.)
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Hot path for the SuperUser console list: newest first.
CREATE INDEX IF NOT EXISTS idx_system_errors_created_at_desc
  ON system_errors (created_at DESC);
-- Per-service filter ("show me bureau-api only") for the Logs tab.
CREATE INDEX IF NOT EXISTS idx_system_errors_service_created
  ON system_errors (service, created_at DESC);
-- Per-org filter — useful for the rare per-tenant triage flow.
CREATE INDEX IF NOT EXISTS idx_system_errors_org
  ON system_errors (org_id, created_at DESC)
  WHERE org_id IS NOT NULL;
