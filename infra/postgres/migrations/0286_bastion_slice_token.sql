-- 0286_bastion_slice_token.sql
-- Why: issue #242. The only thing that kept two bastion-api replicas from running two slices of
--   one AI compile run (or one questionnaire autofill) at once was a Redis lock that failed OPEN
--   on a Redis error and was released with a plain DEL. The run claim did not fence that case:
--   the worker polls both replicas with the SAME claimant, so both slices passed every
--   `claimed_by = <claimant>` write, duplicated proposed assertions and overwrote each other's
--   progress. slice_token is a per-slice fence in Postgres: the claim sets a fresh token only
--   when no live slice holds the row (token NULL, or its heartbeat older than the run lease),
--   every heartbeat, per-control write, release and finish adds `AND slice_token = <mine>`, and
--   the slice clears it when it ends. A second slice therefore loses the fence at once, Redis or
--   no Redis.
-- Client impact: additive only. One nullable uuid column on each of two tables; NULL means no
--   slice is running, which is what every existing row means today.

ALTER TABLE bastion_compile_runs
    ADD COLUMN IF NOT EXISTS slice_token uuid;

ALTER TABLE bastion_questionnaires
    ADD COLUMN IF NOT EXISTS slice_token uuid;
