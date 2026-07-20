-- 0246_tasks_overdue_alerted.sql
-- Why: The task.overdue Bolt event (bam source) is registered in the Bolt catalog and consumed
--   by the tpl_notify_task_overdue automation template and Bulwark/Burn state bindings, but
--   nothing published it. The new bam-task-overdue-sweep worker job emits it on a low-latency
--   30-min cadence, and needs a per-task idempotency marker so a task is alerted once per
--   due-date arming (mirrors bond_deals.rotting_alerted_at). The partial index keeps the sweep
--   cheap: it only ever scans not-yet-alerted, not-yet-completed rows.
-- Client impact: additive only. One nullable column plus a partial index; no rewrite, no lock
--   beyond the brief ACCESS EXCLUSIVE for the catalog/index create. Existing rows read NULL,
--   which the sweep treats as "eligible to alert if overdue".

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS overdue_alerted_at timestamptz;

-- Partial index over exactly the sweep's candidate set: rows that have not been alerted and are
-- not completed. The sweep further filters due_date < CURRENT_DATE and a non-done state category,
-- but this index alone collapses the scan to open, un-alerted tasks.
CREATE INDEX IF NOT EXISTS idx_tasks_overdue_sweep
    ON tasks (due_date)
    WHERE overdue_alerted_at IS NULL AND completed_at IS NULL;
