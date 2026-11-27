import { pgTable, uuid, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';
import { banterChannels } from './channels.js';

export const banterPins = pgTable(
  'banter_pins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel_id: uuid('channel_id')
      .notNull()
      .references(() => banterChannels.id, { onDelete: 'cascade' }),
    // -> banter_messages.id ON DELETE CASCADE, enforced by triggers (migration 0335, #160):
    // banter_messages is partitioned, so no foreign key can reference its id.
    message_id: uuid('message_id').notNull(),
    pinned_by: uuid('pinned_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('banter_pins_unique_idx').on(table.channel_id, table.message_id),
    index('banter_pins_channel_idx').on(table.channel_id),
  ],
);
