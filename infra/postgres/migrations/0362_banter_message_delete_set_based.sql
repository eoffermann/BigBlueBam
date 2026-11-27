-- 0362_banter_message_delete_set_based.sql
-- Why: 0335's ON DELETE emulation for references into banter_messages ran once per deleted row
--   and four of its six lookups had no usable index (pins and bookmarks lead with another column,
--   memberships.last_read_message_id and banter_messages.thread_parent_id had none, the latter
--   scanning every partition). A Slack import abort deletes its whole import in one statement, so
--   it became quadratic and ran for hours holding locks (#370). The cleanup is now one set-based
--   statement per child table, joined to the statement's transition table of deleted rows, and
--   each lookup column is indexed.
-- Client impact: none for callers. Deleting messages removes the same child rows as before.
--   Index builds scan each table once (banter_messages: every partition) under a brief lock.

-- 1. Indexes for every reference column the cleanup joins on (attachments and reactions already
--    have message_id indexes from 0000_init).
CREATE INDEX IF NOT EXISTS banter_pins_message_id_idx
  ON banter_pins (message_id);
CREATE INDEX IF NOT EXISTS banter_bookmarks_message_id_idx
  ON banter_bookmarks (message_id);
CREATE INDEX IF NOT EXISTS banter_channel_memberships_last_read_idx
  ON banter_channel_memberships (last_read_message_id)
  WHERE last_read_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS banter_messages_thread_parent_idx
  ON banter_messages (thread_parent_id)
  WHERE thread_parent_id IS NOT NULL;

-- 2. Statement-level cleanup over the transition table. Runs as the table owner, like a foreign
--    key's referential action, so row-level security never hides a dependent row. A DELETE
--    statement trigger does not fire for an UPDATE that moves a row to another partition (that
--    statement is an UPDATE), so the partition-move guard 0335 needed per row is not needed here.
CREATE OR REPLACE FUNCTION banter_messages_after_delete_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM banter_message_attachments x USING gone g WHERE x.message_id = g.id;
  DELETE FROM banter_message_reactions x USING gone g WHERE x.message_id = g.id;
  DELETE FROM banter_pins x USING gone g WHERE x.message_id = g.id;
  DELETE FROM banter_bookmarks x USING gone g WHERE x.message_id = g.id;
  UPDATE banter_channel_memberships x SET last_read_message_id = NULL
    FROM gone g WHERE x.last_read_message_id = g.id;
  UPDATE banter_messages x SET thread_parent_id = NULL
    FROM gone g WHERE x.thread_parent_id = g.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS banter_messages_referential_delete ON banter_messages;
DROP TRIGGER IF EXISTS banter_messages_referential_delete_stmt ON banter_messages;
CREATE TRIGGER banter_messages_referential_delete_stmt
  AFTER DELETE ON banter_messages
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION banter_messages_after_delete_stmt();

-- The per-row function from 0335 has no trigger left.
DROP FUNCTION IF EXISTS banter_message_after_delete();
