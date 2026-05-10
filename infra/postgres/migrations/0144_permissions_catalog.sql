-- 0144_permissions_catalog.sql
-- Why: Wave A foundation for the per-action permissions migration. Creates
--   the five new tables that hold the action catalog, permission groups
--   (built-in + operator-defined), per-group defaults, per-account overrides,
--   and group memberships. See docs/permissions-overhaul-plan.md for the
--   full design including the 7-step resolver and the snapshot-and-detach
--   group-propagation rule.
-- Client impact: additive only. No data is seeded by this migration; the
--   catalog (~1056 actions) lands in 0145, the five built-in groups in 0146,
--   and the existing-user backfill in 0147 (Wave B). Until 0145 runs the
--   permissions table is empty so no FK targets exist; subsequent migrations
--   are gated on this one having applied first via the runner's strict
--   filename ordering.

-- ──────────────────────────────────────────────────────────────────────
-- permissions  (the static catalog)
-- ──────────────────────────────────────────────────────────────────────
--
-- One row per <app>.<resource>.<verb> permission identifier. Generated
-- from MCP tool registrations and Fastify route declarations by
-- scripts/generate-permission-manifest.mjs and seeded by 0145. The CI
-- guard scripts/check-permission-catalog.mjs ensures every new action
-- adds a row here before the PR can merge.

CREATE TABLE IF NOT EXISTS permissions (
    id                    text PRIMARY KEY,
    app                   text NOT NULL,
    resource              text NOT NULL,
    verb                  text NOT NULL,
    description           text,
    is_destructive        boolean NOT NULL DEFAULT false,
    requires_confirmation boolean NOT NULL DEFAULT false,
    is_read               boolean NOT NULL DEFAULT false,
    introduced_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permissions_app ON permissions (app);
CREATE INDEX IF NOT EXISTS idx_permissions_resource ON permissions (app, resource);

COMMENT ON TABLE permissions IS
    'Static catalog of every <app>.<resource>.<verb> action in the platform. Seeded from docs/permissions-action-manifest.json via 0145; CI guard prevents drift.';
COMMENT ON COLUMN permissions.is_read IS
    'True for read-only actions (verb in get/list/search/view/browse/query/find/count/etc). Used by the API-key scope ceiling.';
COMMENT ON COLUMN permissions.is_destructive IS
    'True for actions where the UI should prompt for confirmation (delete/archive/transfer/cancel/remove/destroy/purge/wipe).';

-- ──────────────────────────────────────────────────────────────────────
-- permission_groups  (built-in roles + operator-defined groups)
-- ──────────────────────────────────────────────────────────────────────
--
-- A group is a named bundle of permission defaults that can be applied
-- to an account at a given scope. Built-in groups (is_builtin=true)
-- mirror the 5 legacy roles and CANNOT be deleted or renamed. Operator-
-- defined groups exist at one of three scope levels:
--   global    — platform-wide custom group (SuperUser only)
--   org       — visible inside one org; created by org owner/admin
--   project   — visible inside one project; project admin scope
--
-- Soft delete (deleted_at NOT NULL) preserves the audit trail. Detached
-- accounts retain their snapshot/overrides regardless of group state.

CREATE TABLE IF NOT EXISTS permission_groups (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL,
    description  text,
    scope_type   text NOT NULL CHECK (scope_type IN ('global', 'org', 'project')),
    scope_id     uuid,
    is_builtin   boolean NOT NULL DEFAULT false,
    legacy_role  text CHECK (legacy_role IS NULL OR legacy_role IN ('owner', 'admin', 'member', 'viewer', 'guest')),
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz
);

-- Scope shape constraint: global => scope_id IS NULL; org/project => NOT NULL.
DO $$
BEGIN
    BEGIN
        ALTER TABLE permission_groups ADD CONSTRAINT permission_groups_scope_shape
            CHECK ((scope_type = 'global' AND scope_id IS NULL)
                OR (scope_type IN ('org', 'project') AND scope_id IS NOT NULL));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
END $$;

-- Builtins are global-scope by definition.
DO $$
BEGIN
    BEGIN
        ALTER TABLE permission_groups ADD CONSTRAINT permission_groups_builtin_scope
            CHECK (NOT is_builtin OR (scope_type = 'global' AND legacy_role IS NOT NULL));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_groups_unique_active_name
    ON permission_groups (scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_permission_groups_scope
    ON permission_groups (scope_type, scope_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_groups_builtin_legacy_role
    ON permission_groups (legacy_role) WHERE is_builtin = true AND deleted_at IS NULL;

COMMENT ON TABLE permission_groups IS
    'Named bundles of permission defaults. Five rows are seeded as is_builtin=true mirroring the legacy 5-role enum; operators can create additional groups at global/org/project scope.';

-- ──────────────────────────────────────────────────────────────────────
-- permission_group_defaults  (which permissions each group grants)
-- ──────────────────────────────────────────────────────────────────────
--
-- Each row is the default decision for one permission within one group.
-- Edits to this table propagate to live-attached accounts on next
-- resolution; detached accounts are unaffected (their snapshot in
-- account_permissions is canonical).

CREATE TABLE IF NOT EXISTS permission_group_defaults (
    group_id      uuid NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
    permission_id text NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    granted       boolean NOT NULL,
    PRIMARY KEY (group_id, permission_id)
);

COMMENT ON TABLE permission_group_defaults IS
    'Default grant/deny per permission per group. Resolver consults this for live-attached account_group_memberships rows; detached memberships read account_permissions instead.';

-- ──────────────────────────────────────────────────────────────────────
-- account_permissions  (per-account explicit grants/denies + snapshots)
-- ──────────────────────────────────────────────────────────────────────
--
-- Stores ONLY explicit operator overrides AND auto-snapshots written by
-- the detach trigger. A row with is_snapshot=true was frozen from a
-- group default at the moment of detachment; a row with is_snapshot=false
-- is an explicit operator decision. Both flavors are canonical for a
-- detached account. Live accounts have NO rows in this table; their
-- permissions resolve through permission_group_defaults.

CREATE TABLE IF NOT EXISTS account_permissions (
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type    text NOT NULL CHECK (scope_type IN ('global', 'org', 'project')),
    scope_id      uuid,
    permission_id text NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    granted       boolean NOT NULL,
    is_snapshot   boolean NOT NULL DEFAULT false,
    set_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    set_at        timestamptz NOT NULL DEFAULT now(),
    notes         text,
    PRIMARY KEY (user_id, scope_type, scope_id, permission_id)
);

DO $$
BEGIN
    BEGIN
        ALTER TABLE account_permissions ADD CONSTRAINT account_permissions_scope_shape
            CHECK ((scope_type = 'global' AND scope_id IS NULL)
                OR (scope_type IN ('org', 'project') AND scope_id IS NOT NULL));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
END $$;

-- The PRIMARY KEY (user_id, scope_type, scope_id, permission_id) above
-- doubles as the hot-path index for resolver lookups within a scope.
-- Add a separate index for "all overrides for this user" queries used
-- by the editor UI and the rebase/reattach operations.
CREATE INDEX IF NOT EXISTS idx_account_permissions_user_scope
    ON account_permissions (user_id, scope_type, scope_id);

COMMENT ON TABLE account_permissions IS
    'Per-account explicit grants/denies. is_snapshot=true rows are auto-frozen from a group default at the moment of detachment; is_snapshot=false rows are explicit operator overrides.';

-- ──────────────────────────────────────────────────────────────────────
-- account_group_memberships  (which group each account is in per scope)
-- ──────────────────────────────────────────────────────────────────────
--
-- Exactly one membership per (user, scope_type, scope_id). The
-- detached_at timestamp is NULL for live-attached accounts (resolver
-- reads group defaults live) and NOT NULL once any explicit override
-- has been set at this scope (resolver reads account_permissions
-- instead). Re-attach via UI sets detached_at back to NULL.

CREATE TABLE IF NOT EXISTS account_group_memberships (
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id     uuid NOT NULL REFERENCES permission_groups(id) ON DELETE RESTRICT,
    scope_type   text NOT NULL CHECK (scope_type IN ('global', 'org', 'project')),
    scope_id     uuid,
    detached_at  timestamptz,
    detached_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    granted_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    granted_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, scope_type, scope_id)
);

DO $$
BEGIN
    BEGIN
        ALTER TABLE account_group_memberships ADD CONSTRAINT account_group_memberships_scope_shape
            CHECK ((scope_type = 'global' AND scope_id IS NULL)
                OR (scope_type IN ('org', 'project') AND scope_id IS NOT NULL));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
END $$;

CREATE INDEX IF NOT EXISTS idx_account_group_memberships_user
    ON account_group_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_account_group_memberships_group
    ON account_group_memberships (group_id);
CREATE INDEX IF NOT EXISTS idx_account_group_memberships_scope
    ON account_group_memberships (scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_account_group_memberships_detached
    ON account_group_memberships (user_id, scope_type, scope_id) WHERE detached_at IS NOT NULL;

COMMENT ON TABLE account_group_memberships IS
    'Which permission group each account belongs to at each scope. detached_at IS NULL means live (resolver reads group defaults); NOT NULL means snapshotted (resolver reads account_permissions).';

-- ──────────────────────────────────────────────────────────────────────
-- updated_at triggers (mirrors the convention used elsewhere in the schema)
-- ──────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_permission_groups_updated_at ON permission_groups;
CREATE TRIGGER trg_permission_groups_updated_at
    BEFORE UPDATE ON permission_groups
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- Row-Level Security (matches the soft-rollout pattern from 0116/0139)
-- ──────────────────────────────────────────────────────────────────────
--
-- All five tables get RLS enabled but the api role still has BYPASSRLS
-- in development; production toggles via BBB_RLS_ENFORCE. The policies
-- bind to the existing app.current_org_id GUC set by the rls plugin.
-- Global-scope rows (scope_id IS NULL) are visible to everyone; org/
-- project rows are isolated to the matching org_id.

ALTER TABLE permissions                ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_groups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_group_defaults  ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_permissions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_group_memberships  ENABLE ROW LEVEL SECURITY;

-- The catalog itself is platform-wide read; only SuperUsers (out-of-band)
-- can write to it.
DROP POLICY IF EXISTS permissions_select ON permissions;
CREATE POLICY permissions_select ON permissions FOR SELECT USING (true);

DROP POLICY IF EXISTS permission_groups_isolation ON permission_groups;
CREATE POLICY permission_groups_isolation ON permission_groups
    USING (
        scope_type = 'global'
        OR scope_id::text = current_setting('app.current_org_id', true)
        OR scope_id IN (
            SELECT id FROM organizations
            WHERE id::text = current_setting('app.current_org_id', true)
        )
        OR scope_id IN (
            -- project scope: a row is visible if its scope_id is a
            -- project that belongs to the current org.
            SELECT id FROM projects
            WHERE org_id::text = current_setting('app.current_org_id', true)
        )
    );

DROP POLICY IF EXISTS permission_group_defaults_isolation ON permission_group_defaults;
CREATE POLICY permission_group_defaults_isolation ON permission_group_defaults
    USING (
        EXISTS (
            SELECT 1 FROM permission_groups pg
            WHERE pg.id = permission_group_defaults.group_id
              AND (pg.scope_type = 'global'
                   OR pg.scope_id::text = current_setting('app.current_org_id', true)
                   OR pg.scope_id IN (
                       SELECT id FROM projects
                       WHERE org_id::text = current_setting('app.current_org_id', true)
                   ))
        )
    );

DROP POLICY IF EXISTS account_permissions_isolation ON account_permissions;
CREATE POLICY account_permissions_isolation ON account_permissions
    USING (
        scope_type = 'global'
        OR scope_id::text = current_setting('app.current_org_id', true)
        OR scope_id IN (
            SELECT id FROM projects
            WHERE org_id::text = current_setting('app.current_org_id', true)
        )
    );

DROP POLICY IF EXISTS account_group_memberships_isolation ON account_group_memberships;
CREATE POLICY account_group_memberships_isolation ON account_group_memberships
    USING (
        scope_type = 'global'
        OR scope_id::text = current_setting('app.current_org_id', true)
        OR scope_id IN (
            SELECT id FROM projects
            WHERE org_id::text = current_setting('app.current_org_id', true)
        )
    );

-- ──────────────────────────────────────────────────────────────────────
-- account_permissions_detach_trigger
-- ──────────────────────────────────────────────────────────────────────
--
-- The load-bearing rule (see docs/permissions-overhaul-plan.md "Group
-- propagation"): the first time an account gets an explicit override at
-- scope X, snapshot the group's current defaults into account_permissions
-- and stamp detached_at on the membership. Edits after this no longer
-- propagate from the group.
--
-- Implementation:
--   1. BEFORE INSERT OR UPDATE on account_permissions when granted is
--      set by an operator (NOT a snapshot, NOT another trigger).
--   2. Look up the membership at the same (user, scope_type, scope_id).
--   3. If membership exists AND detached_at IS NULL:
--      a. Take an advisory lock keyed on (user, scope) to serialize
--         concurrent overrides.
--      b. INSERT INTO account_permissions (group_id's defaults that the
--         user doesn't already have a row for) ON CONFLICT DO NOTHING.
--      c. UPDATE account_group_memberships SET detached_at = now(),
--         detached_by = set_by.
--   4. The original INSERT/UPDATE proceeds normally on top.

CREATE OR REPLACE FUNCTION account_permissions_detach()
RETURNS TRIGGER AS $$
DECLARE
    membership_record account_group_memberships%ROWTYPE;
    lock_key bigint;
BEGIN
    -- Snapshot rows are written by this trigger itself; never re-detach.
    IF NEW.is_snapshot THEN
        RETURN NEW;
    END IF;

    SELECT * INTO membership_record
    FROM account_group_memberships
    WHERE user_id = NEW.user_id
      AND scope_type = NEW.scope_type
      AND scope_id IS NOT DISTINCT FROM NEW.scope_id;

    IF NOT FOUND OR membership_record.detached_at IS NOT NULL THEN
        -- No live attachment to detach from; let the override land.
        RETURN NEW;
    END IF;

    -- Advisory lock keyed on (user_id, scope_id) to serialize concurrent
    -- overrides. hashtext gives us a deterministic int4 we can pack.
    lock_key := hashtext('detach:' || NEW.user_id::text || ':' || NEW.scope_type || ':'
                         || COALESCE(NEW.scope_id::text, ''));
    PERFORM pg_advisory_xact_lock(lock_key);

    -- Re-check after acquiring the lock — another transaction may have
    -- already detached this membership.
    SELECT * INTO membership_record
    FROM account_group_memberships
    WHERE user_id = NEW.user_id
      AND scope_type = NEW.scope_type
      AND scope_id IS NOT DISTINCT FROM NEW.scope_id;

    IF membership_record.detached_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- Snapshot every group default the user doesn't already have a row
    -- for at this scope. is_snapshot=true so the second-level recursion
    -- through this trigger short-circuits.
    INSERT INTO account_permissions (
        user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes
    )
    SELECT
        NEW.user_id, NEW.scope_type, NEW.scope_id, pgd.permission_id, pgd.granted,
        true, NEW.set_by, now(), 'auto-snapshot on detach from group ' || pg.name
    FROM permission_group_defaults pgd
    JOIN permission_groups pg ON pg.id = pgd.group_id
    WHERE pgd.group_id = membership_record.group_id
      AND pgd.permission_id <> NEW.permission_id  -- the row being inserted handles itself
    ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

    UPDATE account_group_memberships
    SET detached_at = now(),
        detached_by = NEW.set_by
    WHERE user_id = NEW.user_id
      AND scope_type = NEW.scope_type
      AND scope_id IS NOT DISTINCT FROM NEW.scope_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS account_permissions_detach_trigger ON account_permissions;
CREATE TRIGGER account_permissions_detach_trigger
    BEFORE INSERT ON account_permissions
    FOR EACH ROW EXECUTE FUNCTION account_permissions_detach();

COMMENT ON FUNCTION account_permissions_detach() IS
    'Snapshot-and-detach trigger. On the first explicit override at a (user, scope), copies all group defaults into account_permissions and stamps detached_at on the membership. Live group-default edits no longer propagate after this point.';
