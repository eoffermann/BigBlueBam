-- 0227_permissions_seed_actions_delta_020.sql
-- Why: Catalog delta. Seeds the six bam.superuser_backup.* / superuser_restore.list
--   permissions the manifest generator path-derives from the new Backup app
--   SuperUser routes (/superuser/backups[...]). All are requires_superuser=true;
--   the routes themselves gate on the is_superuser preHandler (like the
--   superuser-logs routes), so these are catalog formalities, not additional
--   runtime gates. Keeps manifest = codegen = DB in sync.
-- Client impact: additive (six new SuperUser-only rows). Re-running is safe
--   (INSERT ... ON CONFLICT). No builtin-group grants: SuperUser-only permissions
--   are gated by is_superuser, not group membership.

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser) VALUES
    ('bam.superuser_backup.list',          'bam', 'superuser_backup',          'list',    'bam superuser_backup list',            false, false, true,  true),
    ('bam.superuser_backup.create',        'bam', 'superuser_backup',          'create',  'bam superuser_backup create',          false, false, false, true),
    ('bam.superuser_backup.delete',        'bam', 'superuser_backup',          'delete',  'bam superuser_backup delete',          true,  true,  false, true),
    ('bam.superuser_backup.restore',       'bam', 'superuser_backup',          'restore', 'bam superuser_backup restore',         false, false, false, true),
    ('bam.superuser_backup_download.get',  'bam', 'superuser_backup_download', 'get',     'bam superuser_backup_download get',     false, false, true,  true),
    ('bam.superuser_restore.list',         'bam', 'superuser_restore',         'list',    'bam superuser_restore list',           false, false, true,  true)
ON CONFLICT (id) DO UPDATE SET
    app = EXCLUDED.app,
    resource = EXCLUDED.resource,
    verb = EXCLUDED.verb,
    description = EXCLUDED.description,
    is_destructive = EXCLUDED.is_destructive,
    requires_confirmation = EXCLUDED.requires_confirmation,
    is_read = EXCLUDED.is_read,
    requires_superuser = EXCLUDED.requires_superuser;
