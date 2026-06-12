import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { comments } from './comments.js';
import { users } from './users.js';

/**
 * Comment edit history. Each row preserves the body text that an edit
 * REPLACED — the current text always lives on comments.body, so a comment
 * edited N times has N rows here, newest-first by revised_at. Deleting the
 * comment cascades its history away with it.
 */
export const commentRevisions = pgTable(
  'comment_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    comment_id: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    revised_by: uuid('revised_by').references(() => users.id, { onDelete: 'set null' }),
    revised_at: timestamp('revised_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('comment_revisions_comment_idx').on(table.comment_id, table.revised_at)],
);
