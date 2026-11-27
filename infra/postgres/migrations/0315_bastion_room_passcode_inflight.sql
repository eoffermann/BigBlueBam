-- 0315_bastion_room_passcode_inflight.sql
-- Why: issue #327 (Bastion auditor room). A passcode try was reserved by adding 1 to
--   passcode_failures before argon2 ran and given back only on the success path, so a try whose
--   request crashed or whose release write failed stayed spent for ever: it read as a miss (one
--   typo after four leaks locked the room) and five leaks made every request 429. In-flight tries
--   now live in passcode_inflight, a map of reservation id to expiry (epoch milliseconds); an
--   expired entry is ignored and pruned by the next reservation, and passcode_failures counts only
--   real misses again.
-- Client impact: additive only. New column with a default; passcode_failures keeps its meaning
--   for API readers (misses toward the lock of 5).

ALTER TABLE bastion_auditor_rooms
    ADD COLUMN IF NOT EXISTS passcode_inflight jsonb NOT NULL DEFAULT '{}'::jsonb;
