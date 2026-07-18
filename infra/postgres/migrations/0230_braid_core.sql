-- 0230_braid_core.sql
-- Why: Braid (identity-resolution / golden-record CDP) core tables - the golden
--   profile, its member source identities, per-org survivorship rules, and per-org
--   tunables. Also seeds the "Braid System" service-account user that auto-merge
--   decisions (braid_merge_decisions.decided_by NOT NULL) and direct agent_proposals
--   inserts (actor_id NOT NULL) are attributed to. See
--   docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md sections 3.1, 3.4, 2.2.
-- Client impact: additive only. New tables + one sentinel service user; no changes
--   to existing objects.

-- ──────────────────────────────────────────────────────────────────────
-- braid_profiles (the golden record). PII columns are an internal worker
-- cache, re-assembled per viewer on read (spec 2.1).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS braid_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind varchar(8) NOT NULL,
    display_name varchar(320),
    primary_email varchar(320),
    primary_phone varchar(64),
    email_suppressed boolean NOT NULL DEFAULT false,
    company_profile_id uuid,
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    identity_count integer NOT NULL DEFAULT 0,
    confidence numeric(5,2),
    status varchar(12) NOT NULL DEFAULT 'active',
    merged_into_id uuid,
    search_vector tsvector,
    qdrant_point_id uuid,
    qdrant_synced_at timestamptz,
    last_event_published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_braid_profiles_org_kind_status
    ON braid_profiles(organization_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_braid_profiles_org_email
    ON braid_profiles(organization_id, primary_email);
CREATE INDEX IF NOT EXISTS idx_braid_profiles_org_phone
    ON braid_profiles(organization_id, primary_phone);
CREATE INDEX IF NOT EXISTS idx_braid_profiles_merged_into
    ON braid_profiles(merged_into_id);
CREATE INDEX IF NOT EXISTS idx_braid_profiles_qdrant_synced
    ON braid_profiles(qdrant_synced_at);
CREATE INDEX IF NOT EXISTS idx_braid_profiles_event_published
    ON braid_profiles(last_event_published_at);
CREATE INDEX IF NOT EXISTS idx_braid_profiles_search
    ON braid_profiles USING gin(search_vector);
CREATE INDEX IF NOT EXISTS idx_braid_profiles_attributes
    ON braid_profiles USING gin(attributes);

-- Self-FKs declared after the table exists (guarded / idempotent).
DO $$ BEGIN
    ALTER TABLE braid_profiles
        ADD CONSTRAINT fk_braid_profiles_company
        FOREIGN KEY (company_profile_id) REFERENCES braid_profiles(id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE braid_profiles
        ADD CONSTRAINT fk_braid_profiles_merged_into
        FOREIGN KEY (merged_into_id) REFERENCES braid_profiles(id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- braid_identities (one row per source-app record mapped into a profile).
-- id is the immutable stable atom used as the dedupe_decisions suppression key.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS braid_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES braid_profiles(id) ON DELETE CASCADE,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    match_keys jsonb NOT NULL DEFAULT '{}'::jsonb,
    raw_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_synced_at timestamptz,
    needs_rescan boolean NOT NULL DEFAULT false,
    link_confidence numeric(5,2),
    link_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    link_kind varchar(8) NOT NULL DEFAULT 'auto',
    linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
    linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_braid_identities_org_source
    ON braid_identities(organization_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_braid_identities_profile
    ON braid_identities(profile_id);
CREATE INDEX IF NOT EXISTS idx_braid_identities_org_type
    ON braid_identities(organization_id, source_type);
CREATE INDEX IF NOT EXISTS idx_braid_identities_synced
    ON braid_identities(source_synced_at);
CREATE INDEX IF NOT EXISTS idx_braid_identities_needs_rescan
    ON braid_identities(organization_id, needs_rescan) WHERE needs_rescan;
CREATE INDEX IF NOT EXISTS idx_braid_identities_match_keys
    ON braid_identities USING gin(match_keys);

-- ──────────────────────────────────────────────────────────────────────
-- braid_survivorship_rules (per-org, per-field winner selection)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS braid_survivorship_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind varchar(8) NOT NULL,
    field varchar(64) NOT NULL,
    strategy varchar(20) NOT NULL,
    source_priority jsonb NOT NULL DEFAULT '[]'::jsonb,
    pinned_value jsonb,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_braid_survivorship_org_kind_field
    ON braid_survivorship_rules(organization_id, kind, field);

-- ──────────────────────────────────────────────────────────────────────
-- braid_org_settings (per-org tunables; one row per org)
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS braid_org_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    auto_merge_threshold numeric(5,2) NOT NULL DEFAULT 0.92,
    review_threshold numeric(5,2) NOT NULL DEFAULT 0.60,
    require_strong_signal_for_auto boolean NOT NULL DEFAULT true,
    enabled_source_types jsonb NOT NULL DEFAULT '[]'::jsonb,
    rescan_max_age_days integer,
    last_rescan_at timestamptz,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_braid_org_settings_org
    ON braid_org_settings(organization_id);

-- ──────────────────────────────────────────────────────────────────────
-- RLS: org isolation via app.current_org_id GUC (pattern from 0226_basis_core.sql
-- / 0132_entity_links.sql). Advisory until BBB_RLS_ENFORCE=1.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE braid_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS braid_profiles_org_isolation ON braid_profiles;
CREATE POLICY braid_profiles_org_isolation ON braid_profiles
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE braid_identities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS braid_identities_org_isolation ON braid_identities;
CREATE POLICY braid_identities_org_isolation ON braid_identities
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE braid_survivorship_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS braid_survivorship_org_isolation ON braid_survivorship_rules;
CREATE POLICY braid_survivorship_org_isolation ON braid_survivorship_rules
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE braid_org_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS braid_org_settings_org_isolation ON braid_org_settings;
CREATE POLICY braid_org_settings_org_isolation ON braid_org_settings
    FOR ALL USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- ──────────────────────────────────────────────────────────────────────
-- Braid System service-account user. Hosted in the shared sentinel org
-- (0014_helpdesk_system_user.sql). Never logs in (password_hash='!'); exists so
-- auto-merge decisions and direct agent_proposals inserts have a valid actor.
-- ──────────────────────────────────────────────────────────────────────
INSERT INTO users (
    id, org_id, email, display_name, password_hash,
    is_active, is_superuser, email_verified, kind
)
VALUES (
    '00000000-0000-0000-0000-0000000000b1',
    '00000000-0000-0000-0000-000000000002',
    'system-braid@bigbluebam.internal',
    'Braid System',
    '!',
    true, false, true, 'service'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (
    id, org_id, email, display_name, password_hash,
    is_active, is_superuser, email_verified, kind
)
VALUES (
    '00000000-0000-0000-0000-0000000000b1',
    '00000000-0000-0000-0000-000000000002',
    'system-braid@bigbluebam.internal',
    'Braid System',
    '!',
    true, false, true, 'service'
)
ON CONFLICT (email) DO NOTHING;
