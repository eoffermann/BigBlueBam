-- 0355_rls_policies_nullif_org_guc.sql
-- Why: Every RLS policy compared org_id with current_setting('app.current_org_id', true)::uuid.
--   Once a pooled connection has run a transaction-local set_config (runInOrgScope, the rls
--   plugin), the setting exists on that connection and reads as '' afterwards, so ''::uuid
--   raised 22P02 on any later query with no org bound instead of matching no rows (#363). This
--   rewrites every such policy to NULLIF(current_setting(...), '')::uuid. The policies are read
--   from pg_policies, not listed by hand, so none is missed, including ones added by apps this
--   file does not know about.
-- Client impact: none. An unbound query now sees zero org rows instead of an error; a bound
--   query is unchanged.

DO $$
DECLARE
  p record;
  bare constant text := '(current_setting(''app.current_org_id''::text, true))::uuid';
  safe constant text := '(NULLIF(current_setting(''app.current_org_id''::text, true), ''''::text))::uuid';
  new_qual text;
  new_check text;
  stmt text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (strpos(coalesce(qual, ''), bare) > 0 OR strpos(coalesce(with_check, ''), bare) > 0)
  LOOP
    new_qual := replace(p.qual, bare, safe);
    new_check := replace(p.with_check, bare, safe);
    stmt := format('ALTER POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    IF new_qual IS NOT NULL THEN
      stmt := stmt || format(' USING (%s)', new_qual);
    END IF;
    IF new_check IS NOT NULL THEN
      stmt := stmt || format(' WITH CHECK (%s)', new_check);
    END IF;
    EXECUTE stmt;
  END LOOP;
END $$;
