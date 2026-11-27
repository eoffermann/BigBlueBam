-- 0330_bastion_restore_records_resign.sql
-- Why: issue #208 (Bastion). Restore record objects (restores/<org>/<id>.json in the Bastion
--   bucket) are now signed with the seal key, and bastion-api ignores any that do not verify.
--   Records written before that change are unsigned, so they would be ignored too. Clearing
--   object_key makes the next nightly seal run (which re-writes every restore row whose object_key
--   is NULL) write each one again, signed, at the same key.
-- Client impact: none. object_key is internal; until the next seal run an existing pre-#208 record
--   is missing from the bucket-only part of GET /ledger/restores (its database row still shows).

UPDATE bastion_ledger_restores
   SET object_key = NULL
 WHERE object_key IS NOT NULL;
