import { pgTable, uuid, varchar, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';

export const banterMessageReactions = pgTable(
  'banter_message_reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // -> banter_messages.id ON DELETE CASCADE, enforced by triggers (migration 0335, #160):
    // banter_messages is partitioned, so no foreign key can reference its id.
    message_id: uuid('message_id').notNull(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: varchar('emoji', { length: 50 }).notNull(),
    // Slack import (migration 0167). Holds the `slack_source` block
    // ({ import_id, slack_reaction_id, ... }) used by the
    // banter_message_reactions_slack_source_unique partial index for
    // per-import idempotency. Default '{}' keeps existing writers
    // unaffected.
    metadata: jsonb('metadata').notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('banter_message_reactions_unique_idx').on(
      table.message_id,
      table.user_id,
      table.emoji,
    ),
    index('banter_message_reactions_message_idx').on(table.message_id),
  ],
);
