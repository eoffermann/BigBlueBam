-- 0231_braid_candidates_decisions.sql
-- Why: Braid review queue (braid_match_candidates) and the immutable audit trail
--   (braid_merge_decisions). The candidate carries the canonical profile_a<profile_b
--   pair, the two bridge identities, and a proposal_id back-link so the proposal.decided
--   subscription can reverse-look-up the candidate (spec 5.4). Decisions are append-only.
--   See docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md sections 3.1, 2.2, 4.4.
-- Client impact: additive only. New tables; no changes to existing objects.

-- ──────────────────────────────────────────────────────────────────────
-- braid_match_candidates (the human review queue)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS braid_match_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    profile_a_id uuid NOT NULL,
    profile_b_id uuid NOT NULL,
    bridge_identity_a_id uuid NOT NULL,
    bridge_identity_b_id uuid NOT NULL,
    score numeric(5,2) NOT NULL,
    evidence jsonb NOT NULL,
    rationale text,
    status varchar(12) NOT NULL DEFAULT 'pending',
    proposal_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    CONSTRAINT chk_braid_candidates_canonical_pair CHECK (profile_a_id < profile_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_braid_candidates_org_pair
    ON braid_match_candidates(organization_id, profile_a_id, profile_b_id);
CREATE INDEX IF NOT EXISTS idx_braid_candidates_org_status_score
    ON braid_match_candidates(organization_id, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_braid_candidates_a
    ON braid_match_candidates(profile_a_id);
CREATE INDEX IF NOT EXISTS idx_braid_candidates_b
    ON braid_match_candidates(profile_b_id);
CREATE INDEX IF NOT EXISTS idx_braid_candidates_proposal
    ON braid_match_candidates(proposal_id);
CREATE INDEX IF NOT EXISTS idx_braid_candidates_org_status_created
    ON braid_match_candidates(organization_id, status, created_at);

-- proposal_id -> agent_proposals FK (both tables exist; guarded / idempotent).
DO $$ BEGIN
    ALTER TABLE braid_match_candidates
        ADD CONSTRAINT fk_braid_candidates_proposal
        FOREIGN KEY (proposal_id) REFERENCES agent_proposals(id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- braid_merge_decisions (immutable audit; never updated or deleted)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS braid_merge_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    decision_kind varchar(8) NOT NULL,
    surviving_profile_id uuid,
    absorbed_profile_id uuid,
    affected_identity_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    reverses_decision_id uuid,
    candidate_id uuid REFERENCES braid_match_candidates(id) ON DELETE SET NULL,
    score_at_decision numeric(5,2),
    decided_by uuid NOT NULL REFERENCES users(id),
    decided_by_kind actor_type NOT NULL,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_braid_decisions_org_created
    ON braid_merge_decisions(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_braid_decisions_surviving
    ON braid_merge_decisions(surviving_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_braid_decisions_candidate
    ON braid_merge_decisions(candidate_id);
CREATE INDEX IF NOT EXISTS idx_braid_decisions_reverses
    ON braid_merge_decisions(reverses_decision_id);

-- reverses_decision_id self-FK (guarded / idempotent).
DO $$ BEGIN
    ALTER TABLE braid_merge_decisions
        ADD CONSTRAINT fk_braid_decisions_reverses
        FOREIGN KEY (reverses_decision_id) REFERENCES braid_merge_decisions(id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- RLS: org isolation via app.current_org_id GUC. Advisory until BBB_RLS_ENFORCE=1.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE braid_match_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS braid_candidates_org_isolation ON braid_match_candidates;
CREATE POLICY braid_candidates_org_isolation ON braid_match_candidates
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE braid_merge_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS braid_decisions_org_isolation ON braid_merge_decisions;
CREATE POLICY braid_decisions_org_isolation ON braid_merge_decisions
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);
