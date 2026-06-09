import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  integer,
  doublePrecision,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { blueprintDiagrams } from './blueprint-diagrams.js';

export const blueprintNodes = pgTable(
  'blueprint_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    diagram_id: uuid('diagram_id')
      .notNull()
      .references(() => blueprintDiagrams.id, { onDelete: 'cascade' }),
    parent_node_id: uuid('parent_node_id').references((): AnyPgColumn => blueprintNodes.id, {
      onDelete: 'cascade',
    }),
    shape: varchar('shape', { length: 32 }).notNull().default('rounded'),
    label: text('label').notNull().default(''),
    description: text('description'),
    position_x: doublePrecision('position_x').notNull().default(0),
    position_y: doublePrecision('position_y').notNull().default(0),
    width: doublePrecision('width').notNull().default(160),
    height: doublePrecision('height').notNull().default(56),
    z_index: integer('z_index').notNull().default(0),
    pinned: boolean('pinned').notNull().default(false),
    style: jsonb('style').notNull().default(sql`'{}'::jsonb`),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    ref_entity_type: varchar('ref_entity_type', { length: 32 }),
    ref_entity_id: uuid('ref_entity_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('blueprint_nodes_diagram_idx').on(table.diagram_id),
    index('blueprint_nodes_parent_idx').on(table.parent_node_id),
  ],
);
