-- 0356_permissions_seed_actions_delta_033.sql
-- Why: Catalog delta (#378). The permission-manifest generator now composes
--   server.ts mount prefixes, so routes mounted under /internal are excluded
--   by rule. The two shared-secret system-error intake routes
--   (POST /internal/system-errors/record and /record-browser) had been
--   scanned as user permissions; no route or group gates on them. Retire them.
-- Client impact: minor cleanup (removals only). Re-running is safe; DELETE is
--   idempotent and the grant tables cascade.

-- 2 retired permission(s)
DELETE FROM permissions WHERE id IN (
    'bam.system_error_record.create',
    'bam.system_error_record_browser.create'
);
