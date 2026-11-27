-- 0335_banter_message_referential_integrity.sql
-- Why: 0124 turned banter_messages into a partitioned table (primary key (id, created_at)) and
--   dropped the old table with CASCADE, which silently removed every foreign key into and out of
--   banter_messages (#160). Deleting a message has since left orphan attachments, reactions, pins
--   and bookmarks, and nothing stops a row pointing at a message that does not exist. A foreign
--   key cannot reference a partitioned table on id alone, so the references INTO banter_messages
--   are enforced here by triggers with the old ON DELETE behavior; the references OUT of
--   banter_messages (channel, author) are ordinary foreign keys again.
-- Client impact: deletes orphan child rows (rows already pointing at no message) and messages of
--   channels that no longer exist. Inserting a child row for a missing message now fails with
--   SQLSTATE 23503, the same error the original foreign keys raised.

-- 1. Orphans left since 0124. Messages of deleted channels first (the channel FK was ON DELETE
--    CASCADE), then every child row whose message is gone.
DELETE FROM banter_messages m
WHERE NOT EXISTS (SELECT 1 FROM banter_channels c WHERE c.id = m.channel_id);

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

-- 2. References OUT of banter_messages: ordinary foreign keys (allowed from a partitioned table).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'banter_messages_channel_id_fkey' AND conrelid = 'banter_messages'::regclass
  ) THEN
    ALTER TABLE banter_messages
      ADD CONSTRAINT banter_messages_channel_id_fkey
      FOREIGN KEY (channel_id) REFERENCES banter_channels(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'banter_messages_author_id_fkey' AND conrelid = 'banter_messages'::regclass
  ) THEN
    IF EXISTS (
      SELECT 1 FROM banter_messages m WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.author_id)
    ) THEN
      -- Never delete messages for a missing author; leave the FK off and let db:check report it.
      RAISE WARNING 'banter_messages has rows whose author_id is not a user; banter_messages_author_id_fkey not added';
    ELSE
      ALTER TABLE banter_messages
        ADD CONSTRAINT banter_messages_author_id_fkey
        FOREIGN KEY (author_id) REFERENCES users(id);
    END IF;
  END IF;
END $$;

-- 3. References INTO banter_messages: the ON DELETE side. Runs as the table owner, like a
--    foreign key's referential action, so row-level security never hides a dependent row.
CREATE OR REPLACE FUNCTION banter_message_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- An UPDATE that changes created_at moves the row to another partition as a
  -- DELETE plus an INSERT; by the time this AFTER trigger runs the row exists
  -- again under the same id, so it is not a delete of the message.
  IF EXISTS (SELECT 1 FROM banter_messages WHERE id = OLD.id) THEN
    RETURN NULL;
  END IF;
  DELETE FROM banter_message_attachments WHERE message_id = OLD.id;
  DELETE FROM banter_message_reactions WHERE message_id = OLD.id;
  DELETE FROM banter_pins WHERE message_id = OLD.id;
  DELETE FROM banter_bookmarks WHERE message_id = OLD.id;
  UPDATE banter_channel_memberships SET last_read_message_id = NULL WHERE last_read_message_id = OLD.id;
  UPDATE banter_messages SET thread_parent_id = NULL WHERE thread_parent_id = OLD.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS banter_messages_referential_delete ON banter_messages;
CREATE TRIGGER banter_messages_referential_delete
  AFTER DELETE ON banter_messages
  FOR EACH ROW EXECUTE FUNCTION banter_message_after_delete();

-- 4. References INTO banter_messages: the insert/update side (SQLSTATE 23503, like a foreign key).
--    TG_ARGV[0] names the referencing column.
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
  IF ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM banter_messages WHERE id = ref) THEN
    RAISE EXCEPTION 'insert or update on table "%" violates the banter_messages reference on "%"', TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = 'foreign_key_violation',
            DETAIL = format('Key (%s)=(%s) is not present in table "banter_messages".', TG_ARGV[0], ref);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS banter_message_attachments_message_ref ON banter_message_attachments;
CREATE TRIGGER banter_message_attachments_message_ref
  BEFORE INSERT OR UPDATE OF message_id ON banter_message_attachments
  FOR EACH ROW EXECUTE FUNCTION banter_message_reference_check('message_id');

DROP TRIGGER IF EXISTS banter_message_reactions_message_ref ON banter_message_reactions;
CREATE TRIGGER banter_message_reactions_message_ref
  BEFORE INSERT OR UPDATE OF message_id ON banter_message_reactions
  FOR EACH ROW EXECUTE FUNCTION banter_message_reference_check('message_id');

DROP TRIGGER IF EXISTS banter_pins_message_ref ON banter_pins;
CREATE TRIGGER banter_pins_message_ref
  BEFORE INSERT OR UPDATE OF message_id ON banter_pins
  FOR EACH ROW EXECUTE FUNCTION banter_message_reference_check('message_id');

DROP TRIGGER IF EXISTS banter_bookmarks_message_ref ON banter_bookmarks;
CREATE TRIGGER banter_bookmarks_message_ref
  BEFORE INSERT OR UPDATE OF message_id ON banter_bookmarks
  FOR EACH ROW EXECUTE FUNCTION banter_message_reference_check('message_id');

DROP TRIGGER IF EXISTS banter_channel_memberships_last_read_ref ON banter_channel_memberships;
CREATE TRIGGER banter_channel_memberships_last_read_ref
  BEFORE INSERT OR UPDATE OF last_read_message_id ON banter_channel_memberships
  FOR EACH ROW EXECUTE FUNCTION banter_message_reference_check('last_read_message_id');
