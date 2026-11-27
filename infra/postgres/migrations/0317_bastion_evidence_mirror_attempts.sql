-- 0317_bastion_evidence_mirror_attempts.sql
-- Why: issue #332 (Bastion off-site mirror). One evidence object that could not be copied in time
--   ended the whole pass, and every pass started again from the oldest unmirrored object, so one
--   large file on a slow link stopped all newer mirroring for good. A copy that fails for that one
--   object is now recorded on the object (mirror_attempts, mirror_last_error,
--   mirror_last_attempt_at) and the pass moves on; objects are taken fewest attempts first, and an
--   object already tried in the current pass is not tried again in it. These columns change in
--   normal operation like mirrored_at, so the frozen-column trigger from 0275 is unchanged.
-- Client impact: additive only. New nullable or defaulted columns; no API response changes shape.

ALTER TABLE bastion_evidence_objects
    ADD COLUMN IF NOT EXISTS mirror_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE bastion_evidence_objects
    ADD COLUMN IF NOT EXISTS mirror_last_error varchar(500);

ALTER TABLE bastion_evidence_objects
    ADD COLUMN IF NOT EXISTS mirror_last_attempt_at timestamptz;
