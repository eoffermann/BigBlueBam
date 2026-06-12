-- 0187_bureau_chat.sql
-- Why: Bureau gains a room-scoped ephemeral text chat (widget side panel).
--   Messages default to a 24h lifetime; org admins / SuperUsers can extend
--   a thread up to one week or retain it permanently, and participants can
--   recover recent threads from the Bureau app. Three tables: per-room
--   retention policy, the messages themselves (each carrying its computed
--   expires_at), and a participation record that gates recovery access.
-- Client impact: additive only — new tables, no changes to existing rows.

CREATE TABLE IF NOT EXISTS bureau_chat_rooms (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The room identity: the same surface id Bureau presence/calls use
  -- (entity id or u<hex> URL-derived id) or a spatial bureau room id.
  room_key varchar(160) NOT NULL,
  label text,
  app varchar(40),
  retention_hours integer NOT NULL DEFAULT 24,
  retain_forever boolean NOT NULL DEFAULT false,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, room_key)
);

CREATE TABLE IF NOT EXISTS bureau_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  room_key varchar(160) NOT NULL,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Denormalized so transcripts stay readable after a user is removed.
  author_name text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- NULL = retained permanently. Reads always filter on this, so expiry
  -- is enforced even between worker sweeps.
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS bureau_chat_messages_room_idx
  ON bureau_chat_messages (org_id, room_key, created_at DESC);
CREATE INDEX IF NOT EXISTS bureau_chat_messages_expiry_idx
  ON bureau_chat_messages (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS bureau_chat_participants (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  room_key varchar(160) NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, room_key, user_id)
);

CREATE INDEX IF NOT EXISTS bureau_chat_participants_user_idx
  ON bureau_chat_participants (user_id, last_seen_at DESC);
