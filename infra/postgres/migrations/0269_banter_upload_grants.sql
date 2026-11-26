-- 0269_banter_upload_grants.sql
-- Why: Issue #156. POST /v1/channels/:id/messages accepted any banter/uploads/ key a
--   client sent, and nothing recorded who a key was issued to, so anyone who had once
--   seen an attachment key (e.g. before being removed from a private channel, or from
--   another org) could re-attach it to a message in a channel they can still post to
--   and download it through the channel-authorized attachment route. Upload and
--   presigned-upload now record a grant (key, org, uploader) here; posting a message
--   consumes the grant, and a key without a matching grant is refused unless it is
--   already attached in the same channel (legacy keys). The storage_key index backs
--   that legacy lookup and the download route's original-channel check.
-- Client impact: additive only (new table + new index). Clients that attach keys
--   returned by POST /v1/files/upload or /v1/files/presigned-upload are unaffected.

CREATE TABLE IF NOT EXISTS banter_upload_grants (
    storage_key  text PRIMARY KEY,
    org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    uploader_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS banter_upload_grants_expires_idx
    ON banter_upload_grants (expires_at);

CREATE INDEX IF NOT EXISTS banter_message_attachments_storage_key_idx
    ON banter_message_attachments (storage_key);
