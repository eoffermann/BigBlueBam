-- 0224_permissions_seed_actions_delta_019.sql
-- Why: Catalog delta. Adds the bin.asset.delete permission (hard-delete a Bin
--   asset: catalog row + bytes) that landed with the Bin delete feature. Backs
--   the DELETE /assets/:id + POST /assets/bulk-delete routes and the
--   bin_asset_delete MCP tool. Destructive + confirm-required, mirroring
--   bin.asset.archive.
-- Client impact: additive (one new row). Builtin groups re-derive grants from
--   the catalog on read, so owner/admin/member pick it up automatically (same
--   as bin.asset.archive). Re-running is safe (INSERT ... ON CONFLICT).

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser) VALUES
    ('bin.asset.delete', 'bin', 'asset', 'delete', 'bin asset delete', true, true, false, false)
ON CONFLICT (id) DO UPDATE SET
    app = EXCLUDED.app,
    resource = EXCLUDED.resource,
    verb = EXCLUDED.verb,
    description = EXCLUDED.description,
    is_destructive = EXCLUDED.is_destructive,
    requires_confirmation = EXCLUDED.requires_confirmation,
    is_read = EXCLUDED.is_read,
    requires_superuser = EXCLUDED.requires_superuser;
