-- 0270_permissions_seed_actions_delta_030.sql
-- Why: Catalog delta for issue #166. The Bureau WebSocket hub now gates every frame
--   type with the same bureau.* ids as the REST routes (apps/bureau-api/src/lib/
--   ws-permissions.ts). Sending room chat (the chat_send frame) had no catalog action,
--   so this adds bureau.chat.write (scripts/generate-permission-manifest.mjs
--   HAND_AUTHORED). Built-in group defaults follow in
--   0271_bureau_chat_write_builtin_group_defaults.sql, which must run AFTER this file.
-- Client impact: additive only (1 new permission row, no removals).
--   Re-running is safe; INSERT...ON CONFLICT is idempotent.

-- 1 new permission(s)
INSERT INTO permissions (id, app, resource, verb, description, is_destructive, requires_confirmation, is_read, requires_superuser) VALUES
    ('bureau.chat.write', 'bureau', 'chat', 'write', 'bureau chat write', false, false, false, false)
ON CONFLICT (id) DO UPDATE SET
    app = EXCLUDED.app,
    resource = EXCLUDED.resource,
    verb = EXCLUDED.verb,
    description = EXCLUDED.description,
    is_destructive = EXCLUDED.is_destructive,
    requires_confirmation = EXCLUDED.requires_confirmation,
    is_read = EXCLUDED.is_read,
    requires_superuser = EXCLUDED.requires_superuser;
