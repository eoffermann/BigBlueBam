import { pgTable, uuid, varchar, boolean, timestamp } from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';

export const banterUserPreferences = pgTable('banter_user_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  default_notification_level: varchar('default_notification_level', { length: 20 })
    .notNull()
    .default('mentions'),
  sidebar_sort: varchar('sidebar_sort', { length: 20 }).notNull().default('recent'),
  sidebar_collapsed_groups: uuid('sidebar_collapsed_groups').array().notNull().default([]),
  theme_override: varchar('theme_override', { length: 20 }),
  enter_sends_message: boolean('enter_sends_message').notNull().default(true),
  show_message_timestamps: varchar('show_message_timestamps', { length: 20 })
    .notNull()
    .default('hover'),
  // Notification + messaging toggles surfaced on the Banter Preferences page
  // (migration 0193). Previously the page sent these but there were no
  // columns, so they silently failed to persist.
  notification_sound: boolean('notification_sound').notNull().default(true),
  desktop_notifications: boolean('desktop_notifications').notNull().default(true),
  show_typing_indicators: boolean('show_typing_indicators').notNull().default(true),
  compact_mode: boolean('compact_mode').notNull().default(false),
  auto_join_huddles: boolean('auto_join_huddles').notNull().default(false),
  noise_suppression: boolean('noise_suppression').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
