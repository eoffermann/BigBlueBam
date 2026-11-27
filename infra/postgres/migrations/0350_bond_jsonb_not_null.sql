-- 0350_bond_jsonb_not_null.sql
-- Why: db:check now compares nullability (#359). bond_contacts/companies/deals.custom_fields and
--   bond_activities.metadata were created JSONB DEFAULT '{}' but nullable (0033), while the Drizzle
--   schemas and every reader treat them as NOT NULL objects. Backfill any NULL to '{}' and make
--   the database enforce what the code already assumes.
-- Client impact: none for API clients. An insert that passes an explicit NULL for these columns
--   now fails; omitting them still gets '{}'.

UPDATE bond_contacts SET custom_fields = '{}'::jsonb WHERE custom_fields IS NULL;
UPDATE bond_companies SET custom_fields = '{}'::jsonb WHERE custom_fields IS NULL;
UPDATE bond_deals SET custom_fields = '{}'::jsonb WHERE custom_fields IS NULL;
UPDATE bond_activities SET metadata = '{}'::jsonb WHERE metadata IS NULL;

-- SET NOT NULL is itself re-runnable; the DO block is the migration-lint convention for it.
DO $$
BEGIN
  ALTER TABLE bond_contacts ALTER COLUMN custom_fields SET NOT NULL;
  ALTER TABLE bond_companies ALTER COLUMN custom_fields SET NOT NULL;
  ALTER TABLE bond_deals ALTER COLUMN custom_fields SET NOT NULL;
  ALTER TABLE bond_activities ALTER COLUMN metadata SET NOT NULL;
END $$;
