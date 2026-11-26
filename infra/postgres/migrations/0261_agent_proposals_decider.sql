-- 0261_agent_proposals_decider.sql
-- Why: Issue #128. agent_proposals recorded the designated approver but not who
-- actually decided, whether that decider was a human, an agent or a service
-- account, or whether the decision was made under SuperUser impersonation. This
-- adds the decider record, a per-proposal require_human_decider flag the decide
-- route enforces, and owning_app for proposals that must be decided inside the
-- app that raised them (the generic decide route answers 409 DECIDE_IN_APP).
-- Also adds the Bastion off-site evidence mirror status and cursor to
-- platform_backups (spec 9.7), written by the M9 mirror job.
-- Client impact: additive only. New nullable columns plus one NOT NULL column
-- with a default; existing rows and readers are unaffected.

ALTER TABLE agent_proposals
  ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE agent_proposals
  ADD COLUMN IF NOT EXISTS decided_by_kind actor_type;
ALTER TABLE agent_proposals
  ADD COLUMN IF NOT EXISTS decided_impersonator_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE agent_proposals
  ADD COLUMN IF NOT EXISTS owning_app text;
ALTER TABLE agent_proposals
  ADD COLUMN IF NOT EXISTS require_human_decider boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_agent_proposals_owning_app_status
  ON agent_proposals (owning_app, status)
  WHERE owning_app IS NOT NULL;

ALTER TABLE platform_backups
  ADD COLUMN IF NOT EXISTS bastion_mirror_status text;
ALTER TABLE platform_backups
  ADD COLUMN IF NOT EXISTS bastion_mirror_cursor timestamptz;
