-- 0166_banter_attachment_stub_fields.sql
-- Why: Slack import (docs/plans/slack-import-design.md §8). Standard Slack
--   exports reference files by URL but don't include the bytes; when the
--   importer can't download a file (no bearer token, expired URL, file
--   deleted) it inserts a stub attachment row with is_stub=true + the
--   original_url for forensic display. The Banter UI renders these as
--   non-clickable "File: X (not migrated)".
-- Client impact: additive only. is_stub defaults to false, original_url is
--   nullable — current writers are unaffected.

ALTER TABLE banter_message_attachments
  ADD COLUMN IF NOT EXISTS is_stub boolean NOT NULL DEFAULT false;

ALTER TABLE banter_message_attachments
  ADD COLUMN IF NOT EXISTS original_url text;
