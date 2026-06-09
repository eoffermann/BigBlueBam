import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { blueprintDiagrams } from './blueprint-diagrams.js';
import { blueprintNodes } from './blueprint-nodes.js';

export const blueprintEdges = pgTable(
  'blueprint_edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    diagram_id: uuid('diagram_id')
      .notNull()
      .references(() => blueprintDiagrams.id, { onDelete: 'cascade' }),
    source_node_id: uuid('source_node_id')
      .notNull()
      .references(() => blueprintNodes.id, { onDelete: 'cascade' }),
    target_node_id: uuid('target_node_id')
      .notNull()
      .references(() => blueprintNodes.id, { onDelete: 'cascade' }),
    source_handle: varchar('source_handle', { length: 64 }),
    target_handle: varchar('target_handle', { length: 64 }),
    kind: varchar('kind', { length: 32 }).notNull().default('default'),
    label: text('label'),
    marker_start: varchar('marker_start', { length: 16 }).notNull().default('none'),
    marker_end: varchar('marker_end', { length: 16 }).notNull().default('arrowclosed'),
    style: jsonb('style').notNull().default(sql`'{}'::jsonb`),
    waypoints: jsonb('waypoints'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('blueprint_edges_diagram_idx').on(table.diagram_id),
    index('blueprint_edges_source_idx').on(table.source_node_id),
    index('blueprint_edges_target_idx').on(table.target_node_id),
  ],
);
