-- 0361_banter_message_reference_locks.sql
-- Why: 0335's insert-side check for references into banter_messages only tested that the message
--   existed, without a row lock, so a reaction, attachment, pin, bookmark or last-read pointer
--   inserted while its message was being deleted committed as an orphan (#368). A real foreign
--   key takes FOR KEY SHARE on the parent; the check now does the same, so a concurrent DELETE
--   waits for the inserter (and its cleanup then sees the new child) or the inserter waits for the
--   DELETE and fails with 23503. banter_messages.thread_parent_id had the delete side in 0335 but
--   no insert-side check, so a reply could still be inserted under a missing parent; it gets one.
-- Client impact: inserting a reply whose thread_parent_id names no message now fails with
--   SQLSTATE 23503 (banter-api answers 404 THREAD_PARENT_NOT_FOUND before it gets there). Orphans
--   created by the race since 0335 are removed, exactly as 0335 step 1 did.

-- 1. Orphans the unlocked check let through since 0335.
DELETE FROM banter_message_attachments x
WHERE NOT EXISTS (SELECT 1 FROM banter_messages m WHERE m.id = x.message_id);
DELETE FROM banter_message_reactions x
WHERE NOT EXISTS (SELECT 1 FROM banter_messages m WHERE m.id = x.message_id);
DELETE FROM banter_pins x
WHERE NOT EXISTS (SELECT 1 FROM banter_messages m WHERE m.id = x.message_id);
DELETE FROM banter_bookmarks x
WHERE NOT EXISTS (SELECT 1 FROM banter_messages m WHERE m.id = x.message_id);
UPDATE banter_channel_memberships x SET last_read_message_id = NULL
WHERE x.last_read_message_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM banter_messages m WHERE m.id = x.last_read_message_id);
UPDATE banter_messages x SET thread_parent_id = NULL
WHERE x.thread_parent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM banter_messages m WHERE m.id = x.thread_parent_id);

-- 2. The check locks the referenced message FOR KEY SHARE, as a foreign key does. TG_ARGV[0]
--    names the referencing column. Runs as the table owner so row-level security never hides the
--    parent (and the owner holds the UPDATE privilege a locking read needs).
CREATE OR REPLACE FUNCTION banter_message_reference_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ref uuid;
BEGIN
  ref := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF ref IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM banter_messages WHERE id = ref FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insert or update on table "%" violates the banter_messages reference on "%"', TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = 'foreign_key_violation',
            DETAIL = format('Key (%s)=(%s) is not present in table "banter_messages".', TG_ARGV[0], ref);
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Replies: the insert side of thread_parent_id.
DROP TRIGGER IF EXISTS banter_messages_thread_parent_ref ON banter_messages;
CREATE TRIGGER banter_messages_thread_parent_ref
  BEFORE INSERT OR UPDATE OF thread_parent_id ON banter_messages
  FOR EACH ROW EXECUTE FUNCTION banter_message_reference_check('thread_parent_id');
