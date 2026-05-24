-- 0167_banter_messages_slack_source_unique.sql
-- Why: Slack import (docs/plans/slack-import-design.md §4c, §7). Adds the
--   per-import idempotency lookup indexes for messages, attachments, and
--   reactions on the metadata->slack_source JSONB block. The Slack `ts`
--   field (for messages), slack file id (for attachments), and slack
--   reaction id (for reactions) — paired with the importer's import_id —
--   are the natural idempotency keys that let a partial re-run be a no-op.
--
--   For banter_messages the index MUST be non-unique: the table is
--   partitioned by RANGE (created_at) per migration 0124, and Postgres
--   requires a unique index on a partitioned table to include every
--   partition key column. The worker enforces uniqueness application-side
--   via the standard "SELECT WHERE metadata->>... = $1 AND ... = $2; INSERT
--   IF EMPTY" pattern; the index is here for the lookup speed, not for
--   constraint enforcement. For attachments and reactions (plain tables)
--   the indexes ARE unique. Both attachments and reactions get a metadata
--   jsonb column added in this migration since they previously had none —
--   the importer needs somewhere to put the slack_source block.
-- Client impact: additive only. The new metadata columns default to '{}',
--   so existing writers don't need to set them. Index creation runs
--   non-concurrently; on partitioned banter_messages this scans every
--   partition (one-time cost, no row locks beyond the brief catalog lock).

-- ── banter_messages (partitioned: non-unique partial index for fast lookup)
CREATE INDEX IF NOT EXISTS banter_messages_slack_source_idx
  ON banter_messages (
    (metadata #>> '{slack_source,import_id}'),
    (metadata #>> '{slack_source,ts}')
  )
  WHERE metadata ? 'slack_source';

-- ── banter_message_attachments: needs a metadata column to hold slack_source.
ALTER TABLE banter_message_attachments
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS banter_message_attachments_slack_source_unique
  ON banter_message_attachments (
    (metadata #>> '{slack_source,import_id}'),
    (metadata #>> '{slack_source,slack_file_id}')
  )
  WHERE metadata ? 'slack_source';

-- ── banter_message_reactions: needs a metadata column to hold slack_source.
ALTER TABLE banter_message_reactions
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS banter_message_reactions_slack_source_unique
  ON banter_message_reactions (
    (metadata #>> '{slack_source,import_id}'),
    (metadata #>> '{slack_source,slack_reaction_id}')
  )
  WHERE metadata ? 'slack_source';
