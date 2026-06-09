import { pgTable, uuid, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { blueprintDiagrams } from './blueprint-diagrams.js';
import { blueprintNodes } from './blueprint-nodes.js';
import { users } from './bbb-refs.js';

export const blueprintComments = pgTable(
  'blueprint_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    diagram_id: uuid('diagram_id')
      .notNull()
      .references(() => blueprintDiagrams.id, { onDelete: 'cascade' }),
    node_id: uuid('node_id').references(() => blueprintNodes.id, { onDelete: 'cascade' }),
    author_id: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    body_plain: text('body_plain'),
    resolved: boolean('resolved').notNull().default(false),
    edited_at: timestamp('edited_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('blueprint_comments_diagram_idx').on(table.diagram_id),
    index('blueprint_comments_node_idx').on(table.node_id),
  ],
);
