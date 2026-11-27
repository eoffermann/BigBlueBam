import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';
import { briefDocuments } from './brief-documents.js';

export const briefComments = pgTable(
  'brief_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    document_id: uuid('document_id')
      .notNull()
      .references(() => briefDocuments.id, { onDelete: 'cascade' }),
    parent_id: uuid('parent_id').references((): AnyPgColumn => briefComments.id, { onDelete: 'cascade' }),
    author_id: uuid('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    anchor_start: jsonb('anchor_start'),
    anchor_end: jsonb('anchor_end'),
    anchor_text: text('anchor_text'),
    resolved: boolean('resolved').default(false).notNull(),
    resolved_by: uuid('resolved_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_brief_comments_document_id').on(table.document_id),
    index('idx_brief_comments_parent_id').on(table.parent_id),
  ],
);

export const briefCommentReactions = pgTable(
  'brief_comment_reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    comment_id: uuid('comment_id')
      .notNull()
      .references(() => briefComments.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('brief_comment_reactions_comment_user_emoji_key').on(
      table.comment_id,
      table.user_id,
      table.emoji,
    ),
    index('idx_brief_comment_reactions_comment_id').on(table.comment_id),
  ],
);
