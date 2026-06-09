import { pgTable, uuid, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { blueprintDiagrams } from './blueprint-diagrams.js';
import { users } from './bbb-refs.js';

export const blueprintStars = pgTable(
  'blueprint_stars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    diagram_id: uuid('diagram_id')
      .notNull()
      .references(() => blueprintDiagrams.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('blueprint_stars_diagram_id_user_id_unique').on(table.diagram_id, table.user_id),
    index('blueprint_stars_user_idx').on(table.user_id),
  ],
);
