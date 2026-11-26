-- 0273_github_pr_events.sql
-- Why: Bastion's change-management probes (change.merge_reviewed, change.merge_traceable) need
--   the PR history of every integrated repository, not only the PRs that mention a Bam task.
--   This adds the Bam-owned append-only github_pr_events log (one row per pull_request or
--   pull_request_review delivery, recorded by the /webhooks/github route whatever the task
--   mention) and github_integrations.subscribed_events, which stores hook.events from the
--   ping delivery. NULL subscribed_events means "unknown" (webhook created before this
--   migration and never re-pinged), never "not subscribed". Spec: Bastion design sections
--   3.1 and 8.4 (the spec text numbers this file 0262; the tip had moved on).
-- Client impact: additive only. One new table and one nullable column; the webhook route keeps
--   its existing task-linking behavior unchanged.
--
--   No RLS policy on github_pr_events: the webhook writes it before any org scope exists (the
--   caller is GitHub, authenticated by the per-integration HMAC), exactly like
--   github_integrations and task_github_refs. Bastion reads it only through its hardened
--   SECURITY DEFINER probe functions, which carry an explicit org_id predicate.

ALTER TABLE github_integrations
    ADD COLUMN IF NOT EXISTS subscribed_events text[];

CREATE TABLE IF NOT EXISTS github_pr_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- SET NULL, not CASCADE: removing an integration must not erase change-management history.
    integration_id uuid REFERENCES github_integrations(id) ON DELETE SET NULL,
    project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
    repo_owner varchar(100) NOT NULL,
    repo_name varchar(200) NOT NULL,
    -- X-GitHub-Delivery GUID; a redelivery of the same delivery is a no-op.
    delivery_id varchar(100),
    event_type varchar(32) NOT NULL,
    action varchar(32) NOT NULL,
    pr_number integer NOT NULL,
    pr_title text,
    pr_html_url text,
    pr_author_login varchar(200),
    base_ref varchar(255),
    default_branch varchar(255),
    head_sha varchar(64),
    merged boolean NOT NULL DEFAULT false,
    merged_at timestamptz,
    merged_by_login varchar(200),
    merge_commit_sha varchar(64),
    review_id bigint,
    review_state varchar(32),
    reviewer_login varchar(200),
    review_submitted_at timestamptz,
    review_commit_sha varchar(64),
    -- Task human ids (e.g. MAGE-38) parsed from the PR title and body at delivery time.
    task_refs text[] NOT NULL DEFAULT '{}'::text[],
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE github_pr_events
        ADD CONSTRAINT github_pr_events_event_type_check
        CHECK (event_type IN ('pull_request', 'pull_request_review'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_pr_events_delivery
    ON github_pr_events (repo_owner, repo_name, delivery_id)
    WHERE delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_github_pr_events_org_repo_pr
    ON github_pr_events (org_id, repo_owner, repo_name, pr_number);
CREATE INDEX IF NOT EXISTS idx_github_pr_events_org_merged
    ON github_pr_events (org_id, merged_at)
    WHERE merged;
CREATE INDEX IF NOT EXISTS idx_github_pr_events_org_occurred
    ON github_pr_events (org_id, occurred_at DESC);
