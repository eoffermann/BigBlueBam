-- 0154_permissions_singularize_repair.sql
-- Why: Wave D Phase 0 cleanup. Fixes two distinct catalog drifts surfaced
--   by the wave-d-audit:
--   (1) The manifest generator's singularize() function over-stripped
--       words like "expenses" -> "expens" and "phases" -> "phas", leaking
--       11 misspelled REST permission IDs into the catalog at Wave A.
--       scripts/generate-permission-manifest.mjs is now repaired
--       (sibilant-only 'es' strip); this migration renames the affected
--       catalog rows to match the corrected manifest. One pair
--       (bill.expens.create + bill.expense.create) merges into a single
--       row that already existed from the MCP source.
--   (2) bam.superuser_permission_divergence.list landed in the catalog
--       via 0153 with requires_superuser=false because
--       build-permission-delta.mjs did not include that column in its
--       ON CONFLICT DO UPDATE. The script is now repaired; this
--       migration corrects the surviving row.
-- Client impact: rename only. Operator-defined group defaults and
--   per-account overrides are migrated to the new IDs so a user with an
--   explicit grant on `bam.phas.delete` keeps that grant under
--   `bam.phase.delete`. The 5 built-in groups also keep their default
--   grant/deny for each renamed action via the same migration.

-- ────────────────────────────────────────────────────────────────────────
-- Helper view of the renames in this migration:
--
--   bam.phas.delete                  -> bam.phase.delete
--   bam.phas.update                  -> bam.phase.update
--   bam.project_phas.create          -> bam.project_phase.create
--   bam.project_phas.get             -> bam.project_phase.get
--   bam.project_phas_reorder.create  -> bam.project_phase_reorder.create
--   bill.expens.approve              -> bill.expense.approve
--   bill.expens.create               -> bill.expense.create  [MERGE — target already exists from MCP source]
--   bill.expens.delete               -> bill.expense.delete
--   bill.expens.list                 -> bill.expense.list
--   bill.expens.reject               -> bill.expense.reject
--   bill.expens.update               -> bill.expense.update
--   bill.expens_receipt.create       -> bill.expense_receipt.create
-- ────────────────────────────────────────────────────────────────────────

-- (1) Ensure each new ID exists. INSERT...SELECT carries the original
-- row's flags/description forward; ON CONFLICT DO NOTHING means the
-- merge case (bill.expense.create) leaves the existing MCP-sourced row
-- alone, and re-running this migration is a no-op.

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bam.phase.delete', app, 'phase', verb,
       'bam phase delete', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bam.phas.delete'
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bam.phase.update', app, 'phase', verb,
       'bam phase update', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bam.phas.update'
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bam.project_phase.create', app, 'project_phase', verb,
       'bam project_phase create', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bam.project_phas.create'
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bam.project_phase.get', app, 'project_phase', verb,
       'bam project_phase get', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bam.project_phas.get'
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bam.project_phase_reorder.create', app, 'project_phase_reorder', verb,
       'bam project_phase_reorder create', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bam.project_phas_reorder.create'
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bill.expense.approve', app, 'expense', verb,
       'bill expense approve', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bill.expens.approve'
ON CONFLICT (id) DO NOTHING;

-- bill.expens.create — the MERGE case. Target row already exists from
-- the MCP source. INSERT below is a guard so re-running the migration
-- on a partially-applied DB still succeeds; the ON CONFLICT path is the
-- one that fires on first run.
INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bill.expense.create', app, 'expense', verb,
       'bill expense create', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bill.expens.create'
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bill.expense.delete', app, 'expense', verb,
       'bill expense delete', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bill.expens.delete'
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bill.expense.list', app, 'expense', verb,
       'bill expense list', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bill.expens.list'
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bill.expense.reject', app, 'expense', verb,
       'bill expense reject', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bill.expens.reject'
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bill.expense.update', app, 'expense', verb,
       'bill expense update', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bill.expens.update'
ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser)
SELECT 'bill.expense_receipt.create', app, 'expense_receipt', verb,
       'bill expense_receipt create', is_destructive, requires_confirmation, is_read, requires_superuser
  FROM permissions WHERE id = 'bill.expens_receipt.create'
ON CONFLICT (id) DO NOTHING;

-- (2) Move every FK reference (group defaults + account overrides)
-- from the old id to the new id. ON CONFLICT DO NOTHING handles the
-- merge case (bill.expense.create already had its own group defaults
-- from the MCP source — we keep those and drop the duplicates).

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bam.phase.delete', granted FROM permission_group_defaults
WHERE permission_id = 'bam.phas.delete'
ON CONFLICT (group_id, permission_id) DO NOTHING;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bam.phase.update', granted FROM permission_group_defaults
WHERE permission_id = 'bam.phas.update'
ON CONFLICT (group_id, permission_id) DO NOTHING;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bam.project_phase.create', granted FROM permission_group_defaults
WHERE permission_id = 'bam.project_phas.create'
ON CONFLICT (group_id, permission_id) DO NOTHING;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bam.project_phase.get', granted FROM permission_group_defaults
WHERE permission_id = 'bam.project_phas.get'
ON CONFLICT (group_id, permission_id) DO NOTHING;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bam.project_phase_reorder.create', granted FROM permission_group_defaults
WHERE permission_id = 'bam.project_phas_reorder.create'
ON CONFLICT (group_id, permission_id) DO NOTHING;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bill.expense.approve', granted FROM permission_group_defaults
WHERE permission_id = 'bill.expens.approve'
ON CONFLICT (group_id, permission_id) DO NOTHING;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bill.expense.create', granted FROM permission_group_defaults
WHERE permission_id = 'bill.expens.create'
ON CONFLICT (group_id, permission_id) DO NOTHING;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bill.expense.delete', granted FROM permission_group_defaults
WHERE permission_id = 'bill.expens.delete'
ON CONFLICT (group_id, permission_id) DO NOTHING;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bill.expense.list', granted FROM permission_group_defaults
WHERE permission_id = 'bill.expens.list'
ON CONFLICT (group_id, permission_id) DO NOTHING;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bill.expense.reject', granted FROM permission_group_defaults
WHERE permission_id = 'bill.expens.reject'
ON CONFLICT (group_id, permission_id) DO NOTHING;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bill.expense.update', granted FROM permission_group_defaults
WHERE permission_id = 'bill.expens.update'
ON CONFLICT (group_id, permission_id) DO NOTHING;

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT group_id, 'bill.expense_receipt.create', granted FROM permission_group_defaults
WHERE permission_id = 'bill.expens_receipt.create'
ON CONFLICT (group_id, permission_id) DO NOTHING;

-- account_permissions overrides — copy with full row shape.

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bam.phase.delete', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bam.phas.delete'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bam.phase.update', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bam.phas.update'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bam.project_phase.create', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bam.project_phas.create'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bam.project_phase.get', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bam.project_phas.get'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bam.project_phase_reorder.create', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bam.project_phas_reorder.create'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bill.expense.approve', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bill.expens.approve'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bill.expense.create', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bill.expens.create'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bill.expense.delete', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bill.expens.delete'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bill.expense.list', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bill.expens.list'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bill.expense.reject', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bill.expens.reject'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bill.expense.update', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bill.expens.update'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, set_at, notes)
SELECT user_id, scope_type, scope_id, 'bill.expense_receipt.create', granted, is_snapshot, set_by, set_at, notes
FROM account_permissions WHERE permission_id = 'bill.expens_receipt.create'
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO NOTHING;

-- (3) Drop the old IDs. Cascade clears the now-duplicate FK rows that
-- were left behind by the ON CONFLICT DO NOTHING dance above; this is
-- the intended cleanup, not data loss.

DELETE FROM permissions WHERE id IN (
    'bam.phas.delete',
    'bam.phas.update',
    'bam.project_phas.create',
    'bam.project_phas.get',
    'bam.project_phas_reorder.create',
    'bill.expens.approve',
    'bill.expens.create',
    'bill.expens.delete',
    'bill.expens.list',
    'bill.expens.reject',
    'bill.expens.update',
    'bill.expens_receipt.create'
);

-- (4) requires_superuser flag drift fix — see header comment (2).

UPDATE permissions
   SET requires_superuser = true
 WHERE id = 'bam.superuser_permission_divergence.list';
