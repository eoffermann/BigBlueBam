-- 0174_project_calendar_tokens.sql
--
-- Why: enable a per-project public iCal feed token so a project owner
-- can share a sticky URL with someone outside the org (clients,
-- contractors, an external scheduling tool) and have that party
-- subscribe to the project's task schedule. Existing iCal feed is
-- session-or-API-key-gated, which is unsafe to hand out because an API
-- key authorizes the whole user account.
--
-- Client impact: additive only. No existing rows or behavior changes;
-- the new public endpoint is opt-in per project.

CREATE TABLE IF NOT EXISTS project_calendar_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Public, opaque, URL-safe token id. The actual secret is stored as a
  -- hash and verified against on incoming requests; this column is a
  -- short prefix used to locate the row quickly so we don't argon-verify
  -- against every token in the table on every call.
  token_prefix    text NOT NULL,
  token_hash      text NOT NULL,
  name            text NOT NULL DEFAULT 'Project schedule',
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_project_calendar_tokens_project_id
  ON project_calendar_tokens(project_id);
CREATE INDEX IF NOT EXISTS idx_project_calendar_tokens_prefix_live
  ON project_calendar_tokens(token_prefix) WHERE revoked_at IS NULL;
