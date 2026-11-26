-- 0287_bastion_notice_markers.sql
-- Why: issue #243. Several recurring Bastion sweeps used the bastion_outbox idempotency key as
--   their only "this notice already went out" record, and bastion-retention deletes delivered
--   outbox rows after 30 days. Any dedupe window longer than that silently reopened:
--   attestation.overdue (cadence 365 days by default) re-nudged every due person about monthly,
--   evaluation.missed re-fired every ~30 days through one continuous outage, and a persistent
--   ledger chain break re-raised evidence.integrity_failed monthly. bastion_notice_markers is the
--   durable record: one row per (org, marker_key), written in the same transaction as the event,
--   never pruned by retention. The nudge re-arms only when its last_sent_at is a full cadence old
--   (anchored to when the person was last nudged, not to an epoch-aligned bucket); the one-shot
--   notices insert once. RLS: the 0280 org-isolation policy, created here because the 0280 loop
--   only covered the tables that existed when it ran.
-- Client impact: additive only. One new org-scoped table; nothing existing changes.

CREATE TABLE IF NOT EXISTS bastion_notice_markers (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    marker_key      varchar(512) NOT NULL,
    first_sent_at   timestamptz NOT NULL DEFAULT now(),
    last_sent_at    timestamptz NOT NULL DEFAULT now(),
    sent_count      integer NOT NULL DEFAULT 1,
    PRIMARY KEY (organization_id, marker_key)
);

ALTER TABLE bastion_notice_markers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bastion_notice_markers_org_isolation ON bastion_notice_markers;
CREATE POLICY bastion_notice_markers_org_isolation ON bastion_notice_markers FOR ALL
    USING (organization_id = current_setting('app.current_org_id', true)::uuid);
