import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  customType,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, projects, users } from './bbb-refs.js';

// bytea custom type for the (currently unused) Yjs state column. Reserved
// for the future Hocuspocus live-multiplayer layer; until that ships,
// mutations all go through REST and broadcast on Redis PubSub.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const blueprintDiagrams = pgTable(
  'blueprint_diagrams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 200 }),
    description: text('description'),
    diagram_type: varchar('diagram_type', { length: 32 }).notNull().default('flowchart'),
    layout_algorithm: varchar('layout_algorithm', { length: 32 }).notNull().default('layered'),
    layout_options: jsonb('layout_options').notNull().default(sql`'{}'::jsonb`),
    canvas_settings: jsonb('canvas_settings').notNull().default(sql`'{}'::jsonb`),
    visibility: varchar('visibility', { length: 16 }).notNull().default('project'),
    yjs_state: bytea('yjs_state'),
    thumbnail_key: text('thumbnail_key'),
    is_archived: boolean('is_archived').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('blueprint_diagrams_org_idx').on(table.org_id),
    index('blueprint_diagrams_project_idx').on(table.project_id),
  ],
);
