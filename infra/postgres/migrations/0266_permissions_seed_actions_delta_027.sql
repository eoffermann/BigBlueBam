-- 0266_permissions_seed_actions_delta_027.sql
-- Why: Catalog delta for issue #142. The new Banter attachment download route
--   GET /v1/channels/:id/attachments/:attachmentId (banter-api) path-derives the
--   catalog id banter.channel_attachment.get in docs/permissions-action-manifest.json.
--   The route itself applies the channel read rule (requireChannelMember), like the
--   message list; this row keeps the catalog table in step with the manifest.
-- Client impact: additive only (one new read permission row).
--   Re-running is safe; INSERT...ON CONFLICT is idempotent.

INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser) VALUES
    ('banter.channel_attachment.get', 'banter', 'channel_attachment', 'get', 'banter channel_attachment get', false, false, true, false)
ON CONFLICT (id) DO UPDATE SET
    app = EXCLUDED.app,
    resource = EXCLUDED.resource,
    verb = EXCLUDED.verb,
    description = EXCLUDED.description,
    is_destructive = EXCLUDED.is_destructive,
    requires_confirmation = EXCLUDED.requires_confirmation,
    is_read = EXCLUDED.is_read,
    requires_superuser = EXCLUDED.requires_superuser;
