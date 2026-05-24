import { pgTable, uuid, varchar, text, bigint, integer, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';
import { banterMessages } from './messages.js';

export const banterMessageAttachments = pgTable(
  'banter_message_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    message_id: uuid('message_id')
      .notNull()
      .references(() => banterMessages.id, { onDelete: 'cascade' }),
    uploader_id: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    filename: varchar('filename', { length: 255 }).notNull(),
    content_type: varchar('content_type', { length: 100 }).notNull(),
    size_bytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storage_key: text('storage_key').notNull(),
    thumbnail_key: text('thumbnail_key'),
    width: integer('width'),
    height: integer('height'),
    duration_seconds: integer('duration_seconds'),
    // Slack import (migration 0166). True when the importer could not
    // download the referenced file (no bearer token, expired URL, file
    // deleted). The original_url is preserved for forensic display.
    is_stub: boolean('is_stub').notNull().default(false),
    original_url: text('original_url'),
    // Slack import (migration 0167). Holds the `slack_source` block
    // ({ import_id, slack_file_id, ... }) used by the
    // banter_message_attachments_slack_source_unique partial index for
    // per-import idempotency. Default '{}' keeps existing writers
    // unaffected.
    metadata: jsonb('metadata').notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('banter_message_attachments_message_idx').on(table.message_id)],
);
