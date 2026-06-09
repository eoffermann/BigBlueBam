import { pgTable, uuid, varchar, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { blueprintDiagrams } from './blueprint-diagrams.js';
import { users } from './bbb-refs.js';

export const blueprintCollaborators = pgTable(
  'blueprint_collaborators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    diagram_id: uuid('diagram_id')
      .notNull()
      .references(() => blueprintDiagrams.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull().default('editor'),
    added_at: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('blueprint_collaborators_diagram_id_user_id_unique').on(table.diagram_id, table.user_id),
    index('blueprint_collaborators_user_idx').on(table.user_id),
  ],
);
