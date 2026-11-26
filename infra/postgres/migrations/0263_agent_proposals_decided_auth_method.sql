-- 0263_agent_proposals_decided_auth_method.sql
-- Why: Issue #136. require_human_decider was satisfied by any bbam_ API key owned
-- by a human, so an agent holding a person's key could decide a human-only
-- proposal and the row recorded decided_by_kind = 'human'. The decide route now
-- requires a cookie-session login for those proposals, and this column records
-- how the decider authenticated ('session' or 'api_key') so the audit row is
-- truthful.
-- Client impact: additive only. One new nullable column with a CHECK constraint;
-- existing rows keep NULL (auth method unknown for historical decisions).

ALTER TABLE agent_proposals
  ADD COLUMN IF NOT EXISTS decided_auth_method text;

DO $$
BEGIN
  ALTER TABLE agent_proposals
    ADD CONSTRAINT agent_proposals_decided_auth_method_check
    CHECK (decided_auth_method IS NULL OR decided_auth_method IN ('session', 'api_key'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
