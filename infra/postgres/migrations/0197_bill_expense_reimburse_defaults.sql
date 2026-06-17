-- 0195_bill_expense_reimburse_defaults.sql
-- Why: The new bill.expense.reimburse permission (delta 0194) gates the
--   POST /expenses/:id/reimburse route that the Expenses "Mark reimbursed"
--   button calls. Built-in group defaults are seeded by point-in-time
--   migrations (0146 etc.) and do not auto-grant permissions added later
--   via catalog deltas, so without this grant the reimburse action is
--   unreachable under BBB_PERMISSIONS_ENFORCE=on. Mirror the existing
--   bill.expense.reject grant for every group that has one, since reimburse
--   is the same lifecycle-transition action class (approved -> reimbursed).
-- Client impact: additive only. Grants reimburse to exactly the groups that
--   already grant reject; no group gains broader authority than it had for
--   the analogous reject verb. Idempotent via ON CONFLICT DO NOTHING.

INSERT INTO permission_group_defaults (group_id, permission_id, granted)
SELECT pgd.group_id, 'bill.expense.reimburse', pgd.granted
FROM permission_group_defaults pgd
WHERE pgd.permission_id = 'bill.expense.reject'
ON CONFLICT (group_id, permission_id) DO NOTHING;
