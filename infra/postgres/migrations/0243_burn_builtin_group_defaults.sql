-- 0243_burn_builtin_group_defaults.sql
-- Why: The 22 burn.* catalog rows (migration 0242) were added AFTER migration 0156 authored
--   the built-in role default matrix, so no built-in group grants any burn.* permission.
--   Under the per-action resolver every non-SuperUser (including org Owners) would hit
--   implicit_deny on every /burn route, so the Burn SPA would 403 for everyone. This
--   backfills burn.* into the built-in group defaults using the custom tiering from spec
--   section 11.2.
-- Client impact: additive only. INSERT ... ON CONFLICT DO NOTHING; never mutates an existing
--   default row, and non-builtin (operator) groups are untouched.
--
--   ORDERING NOTE, and the reason this file is numbered 0243 and not something chosen up
--   front. scripts/build-permission-delta.mjs computes its own number as
--   max(all four-digit prefixes) + 1 over the whole directory. If this file had been
--   authored first at, say, 0242, the generator would have emitted 0243 and THIS FILE WOULD
--   RUN FIRST: its CROSS JOIN permissions p ... WHERE p.app = 'burn' would match zero rows,
--   ON CONFLICT DO NOTHING would swallow it, migrate would report success, and the file
--   would be checksummed as applied so it could never re-run. The result is exactly the
--   incident 0238's own header documents for Bulwark. So: the three core files were applied
--   first, the delta generator was then run and OBSERVED to assign 0242, and only then was
--   this file authored at 0242 + 1.
--
--   The tiering (spec 11.2):
--     owner + admin = all 22 (none require_superuser);
--     member = all 22 EXCEPT the 8 owner/admin-floored rows
--       (envelope.confirm, rule.write, precheck.mark_wrong, financials.read_all,
--        costrate.read, costrate.write, engagement.delete, settings.write)
--       -> 14 rows. Note precheck.override is deliberately IN the member set: the escape
--          hatch on a blocking gate must stay reachable by the person the gate blocked, or
--          the gate becomes an outage.
--     viewer = the (is_read AND NOT requires_superuser) set EXCEPT financials.read_all and
--       costrate.read, so viewer gets engagement.read, deliverable.read, attribution.read,
--       precheck.read, variance.read, financials.read, settings.read (7 rows);
--     guest = none.
--
--   Verification probe (expected: owner 22, admin 22, member 14, viewer 7, guest 0):
--     SELECT pg.legacy_role, count(*) FILTER (WHERE d.granted)
--     FROM permission_group_defaults d
--     JOIN permissions p ON p.id = d.permission_id
--     JOIN permission_groups pg ON pg.id = d.group_id
--     WHERE p.app = 'burn' GROUP BY 1;
--   A zero row for any group means the ordering inverted, and the fix is a NEW numbered
--   file, never an edit to this one once applied.

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT
    pg.id,
    p.id,
    CASE pg.legacy_role
        WHEN 'owner'  THEN (NOT p.requires_superuser)
        WHEN 'admin'  THEN (NOT p.requires_superuser)
        WHEN 'member' THEN (
            NOT p.requires_superuser
            AND p.id NOT IN (
                'burn.envelope.confirm',
                'burn.rule.write',
                'burn.precheck.mark_wrong',
                'burn.financials.read_all',
                'burn.costrate.read',
                'burn.costrate.write',
                'burn.engagement.delete',
                'burn.settings.write'
            )
        )
        WHEN 'viewer' THEN (
            p.is_read
            AND NOT p.requires_superuser
            AND p.id NOT IN (
                'burn.financials.read_all',
                'burn.costrate.read'
            )
        )
        WHEN 'guest'  THEN false
        ELSE false
    END AS granted
FROM permission_groups pg
CROSS JOIN permissions p
WHERE pg.is_builtin
  AND pg.legacy_role IS NOT NULL
  AND p.app = 'burn'
ON CONFLICT (group_id, permission_id) DO NOTHING;
