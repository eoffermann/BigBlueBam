import { pgTable, uuid, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';

export const banterBookmarks = pgTable(
  'banter_bookmarks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // -> banter_messages.id ON DELETE CASCADE, enforced by triggers (migration 0335, #160):
    // banter_messages is partitioned, so no foreign key can reference its id.
    message_id: uuid('message_id').notNull(),
    note: varchar('note', { length: 500 }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('banter_bookmarks_unique_idx').on(table.user_id, table.message_id),
    index('banter_bookmarks_user_idx').on(table.user_id),
  ],
);
