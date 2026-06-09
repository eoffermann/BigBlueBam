import { pgTable, uuid, varchar, text, jsonb, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

export const blueprintTemplates = pgTable(
  'blueprint_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    diagram_type: varchar('diagram_type', { length: 32 }).notNull().default('flowchart'),
    definition: jsonb('definition').notNull(),
    is_system: boolean('is_system').notNull().default(false),
    thumbnail_key: text('thumbnail_key'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('blueprint_templates_org_idx').on(table.org_id)],
);
