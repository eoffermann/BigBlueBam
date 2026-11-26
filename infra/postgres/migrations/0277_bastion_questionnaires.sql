-- 0277_bastion_questionnaires.sql
-- Why: Bastion security-questionnaire autofill (spec 2.7), section 4.1 tables 29-31: the
--   questionnaire header (pinned Bin source, column map, banding counts, claim lease), one row
--   per question with the draft, the reviewer's final answer and the confidence band, and the
--   approved-answer library with a generated full-text vector for lexical retrieval. The spec
--   numbers this file 0266; the tip had moved on.
-- Client impact: additive only. New tables; no changes to existing objects.

-- ──────────────────────────────────────────────────────────────────────
-- 29. bastion_questionnaires.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_questionnaires (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title varchar(512) NOT NULL,
    requester_label varchar(256),
    bond_deal_id uuid,
    bond_company_id uuid,
    source_bin_asset_id uuid,
    source_bin_asset_version_id uuid,
    source_sha256 varchar(64),
    format varchar(8) NOT NULL,
    column_map jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(16) NOT NULL DEFAULT 'uploaded',
    injection_suspected boolean NOT NULL DEFAULT false,
    row_count integer NOT NULL DEFAULT 0,
    rows_done integer NOT NULL DEFAULT 0,
    low_count integer NOT NULL DEFAULT 0,
    medium_count integer NOT NULL DEFAULT 0,
    high_count integer NOT NULL DEFAULT 0,
    resume_count integer NOT NULL DEFAULT 0,
    due_date date,
    owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    claimed_by varchar(128),
    heartbeat_at timestamptz,
    approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at timestamptz,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    ALTER TABLE bastion_questionnaires
        ADD CONSTRAINT bastion_questionnaires_shape_check
        CHECK (
            format IN ('xlsx', 'csv')
            AND status IN ('uploaded', 'mapping', 'answering', 'in_review', 'approved', 'exported', 'failed')
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_bastion_questionnaires_org_status
    ON bastion_questionnaires (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bastion_questionnaires_org_deal
    ON bastion_questionnaires (organization_id, bond_deal_id);

DROP TRIGGER IF EXISTS trg_bastion_questionnaires_updated_at ON bastion_questionnaires;
CREATE TRIGGER trg_bastion_questionnaires_updated_at
    BEFORE UPDATE ON bastion_questionnaires
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 30. bastion_questionnaire_items. One row per question; unique per sheet and row.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_questionnaire_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    questionnaire_id uuid NOT NULL REFERENCES bastion_questionnaires(id) ON DELETE CASCADE,
    sheet_name varchar(128) NOT NULL DEFAULT '',
    row_index integer NOT NULL,
    section varchar(256),
    question_text varchar(4000) NOT NULL,
    answer_kind varchar(16) NOT NULL DEFAULT 'yes_no_text',
    draft_answer text,
    draft_yes_no boolean,
    final_answer text,
    final_yes_no boolean,
    cited_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
    dropped_citation_count integer NOT NULL DEFAULT 0,
    confidence numeric(5,4),
    confidence_band varchar(8),
    band_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
    review_status varchar(16) NOT NULL DEFAULT 'pending',
    assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at timestamptz
);

DO $$
BEGIN
    ALTER TABLE bastion_questionnaire_items
        ADD CONSTRAINT bastion_questionnaire_items_shape_check
        CHECK (
            answer_kind IN ('yes_no', 'text', 'yes_no_text')
            AND (confidence_band IS NULL OR confidence_band IN ('high', 'medium', 'low'))
            AND review_status IN ('pending', 'accepted', 'edited', 'needs_owner')
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bastion_questionnaire_items_unique
    ON bastion_questionnaire_items (organization_id, questionnaire_id, sheet_name, row_index);
CREATE INDEX IF NOT EXISTS idx_bastion_questionnaire_items_review
    ON bastion_questionnaire_items (organization_id, questionnaire_id, review_status, confidence_band);

-- ──────────────────────────────────────────────────────────────────────
-- 31. bastion_answer_library. Approved answers; marked stale when a cited control's STORED
-- status changes. tsv is generated and GIN-indexed for lexical retrieval.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bastion_answer_library (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    question_text varchar(4000) NOT NULL,
    answer_text text NOT NULL,
    yes_no boolean,
    cited_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
    source_item_id uuid REFERENCES bastion_questionnaire_items(id) ON DELETE SET NULL,
    approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at timestamptz,
    stale boolean NOT NULL DEFAULT false,
    stale_reason varchar(128),
    retired_at timestamptz,
    tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(question_text, '') || ' ' || coalesce(answer_text, ''))
    ) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bastion_answer_library_tsv
    ON bastion_answer_library USING gin (tsv);
CREATE INDEX IF NOT EXISTS idx_bastion_answer_library_org_live
    ON bastion_answer_library (organization_id, stale)
    WHERE retired_at IS NULL;

DROP TRIGGER IF EXISTS trg_bastion_answer_library_updated_at ON bastion_answer_library;
CREATE TRIGGER trg_bastion_answer_library_updated_at
    BEFORE UPDATE ON bastion_answer_library
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
