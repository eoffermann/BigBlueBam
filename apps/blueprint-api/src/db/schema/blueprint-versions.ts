import { pgTable, uuid, varchar, jsonb, timestamp, integer, unique, index } from 'drizzle-orm/pg-core';
import { blueprintDiagrams } from './blueprint-diagrams.js';
import { users } from './bbb-refs.js';

export const blueprintDiagramVersions = pgTable(
  'blueprint_diagram_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    diagram_id: uuid('diagram_id')
      .notNull()
      .references(() => blueprintDiagrams.id, { onDelete: 'cascade' }),
    version_number: integer('version_number').notNull(),
    label: varchar('label', { length: 200 }),
    snapshot: jsonb('snapshot').notNull(),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('blueprint_diagram_versions_diagram_id_version_number_unique').on(
      table.diagram_id,
      table.version_number,
    ),
    index('blueprint_diagram_versions_diagram_idx').on(table.diagram_id),
  ],
);
