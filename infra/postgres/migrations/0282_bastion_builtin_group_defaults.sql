-- 0282_bastion_builtin_group_defaults.sql
-- Why: The 50 bastion.* catalog rows (delta migration 0281) were added AFTER migration 0156
--   authored the built-in role default matrix, so no built-in group grants any bastion.*
--   permission. Under the per-action resolver (bastion-api's fail-closed boot invariant) every
--   non-SuperUser, including org Owners, would hit implicit_deny on every /bastion route. This
--   backfills bastion.* into the built-in group defaults using the Bastion spec section 5.5
--   tiering. Registered at M2 (moved here from M10 by the plan review) so the GILLIGAN cast can
--   act through bastion-api from M5 on.
-- Client impact: additive only. INSERT ... ON CONFLICT DO NOTHING; never mutates an existing
--   default row, and non-builtin (operator) groups are untouched.
--
--   ORDERING NOTE (the trap of spec 4.5 and 0259). scripts/build-permission-delta.mjs numbers
--   its file max(all prefixes) + 1. Had this file been authored first it would have run first,
--   matched zero rows, succeeded, been checksummed, and never re-run. So the delta was
--   generated and applied first; the generator was OBSERVED to assign 0281 (delta_031, 50 rows
--   added, 0 removed), and only then was this file authored at 0281 + 1.
--
--   The tiering (spec 5.5; "floored" = owner and admin only):
--     owner + admin = every row (50; none require_superuser);
--     member = every row that is NOT floored (50 - 25 floored = 25);
--     viewer = exactly the rows marked `viewer` in the table (10): framework.read,
--       control.read, evidence.read, gap.read, exception.read, drift.read, policy.read,
--       attestation.read, attestation.sign (a viewer signs the policies they must read),
--       settings.read;
--     guest = none.
--   Service-layer rules (owner-only redact and restore acknowledgement, approver differs from
--   proposer, control-owner-or-control.write on fix.decide) sit on top in bastion-api.
--
--   Verification probe (spec 4.6; expected owner 50, admin 50, member 25, viewer 10, guest 0):
--     SELECT pg.legacy_role, count(*) FILTER (WHERE d.granted)
--     FROM permission_group_defaults d
--     JOIN permissions p ON p.id = d.permission_id
--     JOIN permission_groups pg ON pg.id = d.group_id
--     WHERE p.app = 'bastion' AND pg.is_builtin GROUP BY 1 ORDER BY 1;
--   A zero for any group means the ordering inverted; the fix is a NEW numbered file, never an
--   edit to this one once applied.

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
                'bastion.framework.write',
                'bastion.framework.compile',
                'bastion.control.write',
                'bastion.assertion.confirm',
                'bastion.evidence.read_detail',
                'bastion.evidence.read_restricted',
                'bastion.evidence.review',
                'bastion.evidence.withdraw',
                'bastion.evidence.redact',
                'bastion.ledger.acknowledge_restore',
                'bastion.feed.manage',
                'bastion.gap.dismiss',
                'bastion.exception.approve',
                'bastion.policy.write',
                'bastion.attestation.request',
                'bastion.questionnaire.approve',
                'bastion.answer_library.write',
                'bastion.auditor_room.read',
                'bastion.auditor_room.create',
                'bastion.auditor_room.revoke',
                'bastion.auditor_room.respond',
                'bastion.export.create',
                'bastion.export.read',
                'bastion.settings.write',
                'bastion.audit.read'
            )
        )
        WHEN 'viewer' THEN (
            NOT p.requires_superuser
            AND p.id IN (
                'bastion.framework.read',
                'bastion.control.read',
                'bastion.evidence.read',
                'bastion.gap.read',
                'bastion.exception.read',
                'bastion.drift.read',
                'bastion.policy.read',
                'bastion.attestation.read',
                'bastion.attestation.sign',
                'bastion.settings.read'
            )
        )
        WHEN 'guest'  THEN false
        ELSE false
    END AS granted
FROM permission_groups pg
CROSS JOIN permissions p
WHERE pg.is_builtin
  AND pg.legacy_role IS NOT NULL
  AND p.app = 'bastion'
ON CONFLICT (group_id, permission_id) DO NOTHING;
