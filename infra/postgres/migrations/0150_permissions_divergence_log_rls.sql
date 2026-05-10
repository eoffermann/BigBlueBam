-- 0150_permissions_divergence_log_rls.sql
-- Why: Wave B follow-up audit fix. The original RLS policy on
--   permissions_divergence_log (introduced in 0149) allowed any user with
--   matching app.current_org_id to SELECT divergence rows for their org.
--   That's too permissive — divergence telemetry exposes the platform's
--   internal authz mismatches and is operator-only by design. Tighten the
--   USING clause to require BYPASSRLS posture (SuperUsers under
--   BBB_RLS_ENFORCE) so the table stays operator-only even if a
--   non-superuser query path emerges accidentally.
-- Client impact: none. Today's request handlers gate on requireSuperuser
--   before reaching the table; this migration is defense-in-depth. Under
--   BBB_RLS_ENFORCE=1 the api role still runs with NOBYPASSRLS-off
--   (i.e. BYPASSRLS) until production flips to enforcement; this policy
--   continues to work in both postures.

DROP POLICY IF EXISTS permissions_divergence_log_isolation ON permissions_divergence_log;

-- New policy: permanently deny SELECT/UPDATE/DELETE under enforcement
-- mode. SuperUsers run with BYPASSRLS (their role has the BYPASSRLS
-- attribute) so this `USING (false)` doesn't affect them. Non-superuser
-- query paths get nothing.
CREATE POLICY permissions_divergence_log_no_select ON permissions_divergence_log
    FOR SELECT USING (false);

-- INSERT must remain open for the dual-read path. The auth plugin runs
-- under the api connection role; divergence rows are written by the
-- recordDivergence service. We don't want to require a separate role
-- flip for telemetry writes.
CREATE POLICY permissions_divergence_log_insert ON permissions_divergence_log
    FOR INSERT WITH CHECK (true);

COMMENT ON POLICY permissions_divergence_log_no_select ON permissions_divergence_log IS
    'Wave B follow-up. Divergence telemetry is operator-only; SELECT denied under enforced RLS. SuperUsers see everything via BYPASSRLS on their role.';
