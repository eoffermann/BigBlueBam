-- 0148_permissions_backfill_memberships.sql
-- Why: Wave B foundation. Backfills account_group_memberships from the
--   existing organization_memberships table so day-1 of the new resolver
--   matches today's behavior bit-for-bit. Each org membership row maps to
--   exactly one row in account_group_memberships with the matching
--   built-in group at scope_type='org'. SuperUsers are NOT given a
--   global-scope group — per the user's design decision, is_superuser
--   stays a boolean short-circuit at resolver step 1, not a group.
-- Client impact: additive only. Wave B's contextLoader will read these
--   rows; in mode='off' (today) and mode='warn' (after Wave B deploy) the
--   legacy gate is still authoritative, so a misalignment between
--   builtin-group defaults and legacy role enforcement only surfaces in
--   the divergence telemetry until Wave C flips to mode='on'.

-- ──────────────────────────────────────────────────────────────────────
-- Backfill org-scope memberships
-- ──────────────────────────────────────────────────────────────────────
--
-- We resolve the built-in group_id by joining on permission_groups.legacy_role
-- so the backfill works regardless of the UUID seeded for each builtin
-- in 0146 (defensive — the migration body in 0146 used fixed UUIDs but
-- a re-seed could theoretically pick different ones in a different
-- environment).

INSERT INTO account_group_memberships (
    user_id, group_id, scope_type, scope_id, granted_by, granted_at, detached_at
)
SELECT
    om.user_id,
    pg.id AS group_id,
    'org' AS scope_type,
    om.org_id AS scope_id,
    om.invited_by AS granted_by,
    om.joined_at AS granted_at,
    NULL AS detached_at
FROM organization_memberships om
JOIN permission_groups pg
  ON pg.is_builtin = true
 AND pg.legacy_role = om.role
ON CONFLICT (user_id, scope_type, scope_id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────
-- Audit assertion. The migration runner halts the deploy on a non-zero
-- count here, which is the right behavior — a backfill mismatch must
-- not silently leak into Wave B's dual-read window.
--
-- The query asks: for every org_membership row, is there a corresponding
-- account_group_membership at org scope linked to a builtin group whose
-- legacy_role matches? Result must be 0.
-- ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
    missing_count integer;
BEGIN
    SELECT COUNT(*) INTO missing_count
    FROM organization_memberships om
    WHERE NOT EXISTS (
        SELECT 1
        FROM account_group_memberships agm
        JOIN permission_groups pg ON pg.id = agm.group_id
        WHERE agm.user_id = om.user_id
          AND agm.scope_type = 'org'
          AND agm.scope_id = om.org_id
          AND pg.is_builtin = true
          AND pg.legacy_role = om.role
    );
    IF missing_count > 0 THEN
        RAISE EXCEPTION 'permissions backfill incomplete: % org_memberships rows have no matching account_group_memberships', missing_count;
    END IF;
END $$;
