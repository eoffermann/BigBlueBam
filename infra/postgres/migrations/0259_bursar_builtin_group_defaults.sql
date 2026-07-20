-- 0259_bursar_builtin_group_defaults.sql
-- Why: The 36 bursar.* catalog rows (migration 0258) were added AFTER migration 0156 authored
--   the built-in role default matrix, so no built-in group grants any bursar.* permission.
--   Under the per-action resolver (bursar-api runs mode 'on' with onUnknown 'deny', spec 13.3)
--   every non-SuperUser (including org Owners) would hit implicit_deny on every /bursar route,
--   so the Bursar SPA would 403 for everyone. This backfills bursar.* into the built-in group
--   defaults using the tiering from spec section 13.2.
-- Client impact: additive only. INSERT ... ON CONFLICT DO NOTHING; never mutates an existing
--   default row, and non-builtin (operator) groups are untouched.
--
--   ORDERING NOTE, and the reason this file is numbered 0259 and not something chosen up front
--   (the trap this repo has hit twice, spec 17.2). scripts/build-permission-delta.mjs computes
--   its own number as max(all four-digit prefixes) + 1 over the whole directory. If this file had
--   been authored first at, say, 0258, the generator would have emitted 0259 and THIS FILE WOULD
--   RUN FIRST: its CROSS JOIN permissions p ... WHERE p.app = 'bursar' would match zero rows,
--   ON CONFLICT DO NOTHING would swallow it, migrate would report success, and the file would be
--   checksummed as applied so it could never re-run, leaving every non-SuperUser at implicit_deny
--   on every /bursar route. So: the four bursar core files plus the catalog delta (0258) were
--   applied first, the delta generator was OBSERVED to assign 0258, and only then was this file
--   authored at 0258 + 1.
--
--   The tiering (spec 13.1 action table + 13.2 group grants):
--     owner + admin = every row (36; none require_superuser);
--     member = every row NOT floored (36 - 14 floored = 22). The 14 floored rows are
--       vendor.delete, scope.confirm, scope.promote_rival, offer.unseal, coverage.override,
--       award.create, award.amend, award.terminate, spend.read_all, spend.import, draft.approve,
--       detector.mark_wrong, library.write, settings.write.
--     viewer = the rows marked `viewer` in the table = the (is_read AND NOT requires_superuser)
--       set EXCEPT spend.read_all (floored) and draft.read (drafts are confidential, spec 5.7),
--       so viewer gets vendor.read, request.read, offer.read, coverage.read, award.read,
--       baseline.read, spend.read, mismatch.read, renewal.read, settings.read (10 rows);
--     guest = none. There is no gate.override, because the gate is advisory (spec 9).
--
--   Verification probe (expected: owner 36, admin 36, member 22, viewer 10, guest 0):
--     SELECT pg.legacy_role, count(*) FILTER (WHERE d.granted)
--     FROM permission_group_defaults d
--     JOIN permissions p ON p.id = d.permission_id
--     JOIN permission_groups pg ON pg.id = d.group_id
--     WHERE p.app = 'bursar' GROUP BY 1;
--   A zero row for any group means the ordering inverted, and the fix is a NEW numbered file,
--   never an edit to this one once applied.

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
                'bursar.vendor.delete',
                'bursar.scope.confirm',
                'bursar.scope.promote_rival',
                'bursar.offer.unseal',
                'bursar.coverage.override',
                'bursar.award.create',
                'bursar.award.amend',
                'bursar.award.terminate',
                'bursar.spend.read_all',
                'bursar.spend.import',
                'bursar.draft.approve',
                'bursar.detector.mark_wrong',
                'bursar.library.write',
                'bursar.settings.write'
            )
        )
        WHEN 'viewer' THEN (
            p.is_read
            AND NOT p.requires_superuser
            AND p.id NOT IN (
                'bursar.spend.read_all',
                'bursar.draft.read'
            )
        )
        WHEN 'guest'  THEN false
        ELSE false
    END AS granted
FROM permission_groups pg
CROSS JOIN permissions p
WHERE pg.is_builtin
  AND pg.legacy_role IS NOT NULL
  AND p.app = 'bursar'
ON CONFLICT (group_id, permission_id) DO NOTHING;
