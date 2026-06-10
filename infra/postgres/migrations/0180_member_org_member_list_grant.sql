-- 0180_member_org_member_list_grant.sql
-- Why: The auto-generated permission baseline denies bam.org_member.list
--      (GET /org/members) to the built-in Member role while granting it to
--      Viewer — an inverted misclassification, never a deliberate policy.
--      Members need the org roster for Banter DM start-a-conversation lists
--      and the People page. Inert today (gate is shadowOnly), but must be
--      correct before permission enforcement is switched on.
-- Client impact: none (telemetry-only gate today; prevents a future
--      regression when enforcement mode goes live).

-- Built-in Member group uses the fixed UUID from the Wave E.F role seeding
-- (see apps/api/src/services/role-resolver.ts builtinGroupIdForRole).
UPDATE permission_group_defaults
   SET granted = true
 WHERE group_id = '33333333-3333-4333-8333-333333333333'
   AND permission_id = 'bam.org_member.list'
   AND granted = false;

-- Keep the factory-default snapshot in agreement so a "reset to baseline"
-- cannot reintroduce the denial.
UPDATE permission_group_defaults_baseline
   SET granted = true
 WHERE group_id = '33333333-3333-4333-8333-333333333333'
   AND permission_id = 'bam.org_member.list'
   AND granted = false;
