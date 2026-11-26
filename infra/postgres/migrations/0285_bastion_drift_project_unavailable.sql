-- 0285_bastion_drift_project_unavailable.sql
-- Why: issue #229. When the Compliance project is deleted (or left with no open phase), the api
--   refuses every task upsert with PROJECT_NOT_FOUND / CONFIGURATION_ERROR, the outbox row goes
--   dead, and the drift row stayed task_status 'pending' forever because the CHECK had no value
--   for "Bastion can't file tasks". 'project_unavailable' is that terminal value: the deliverer
--   writes it on those refusals, Readiness shows a plain banner, and fixing the project (or
--   picking another one in Setup) re-drives the dead rows and puts the drift rows back to
--   'pending'. Spec 2.5 of docs/brainstorming/2026_11_25_20_03_APP_DESIGN_bastion.md.
-- Client impact: additive only. One more allowed value on bastion_drift_events.task_status.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'bastion_drift_events_task_status_check'
           AND conrelid = 'bastion_drift_events'::regclass
           AND pg_get_constraintdef(oid) LIKE '%project_unavailable%'
    ) THEN
        ALTER TABLE bastion_drift_events DROP CONSTRAINT IF EXISTS bastion_drift_events_task_status_check;
        ALTER TABLE bastion_drift_events
            ADD CONSTRAINT bastion_drift_events_task_status_check
            CHECK (task_status IN ('pending', 'created', 'reopened', 'updated', 'no_project', 'proposed', 'project_unavailable'));
    END IF;
END $$;
