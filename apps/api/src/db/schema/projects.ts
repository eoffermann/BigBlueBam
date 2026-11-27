import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, integer, jsonb, timestamp, boolean, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { users } from './users.js';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    description: text('description'),
    icon: varchar('icon', { length: 10 }),
    color: varchar('color', { length: 7 }),
    // Nullable in the database (0000_init); the create route always sets it, but
    // imports and raw-SQL inserts may not, so reads must handle null (#359).
    task_id_prefix: varchar('task_id_prefix', { length: 6 }),
    task_id_sequence: integer('task_id_sequence').default(0).notNull(),
    default_sprint_duration_days: integer('default_sprint_duration_days').default(14).notNull(),
    settings: jsonb('settings').default({}).notNull(),
    is_archived: boolean('is_archived').default(false).notNull(),
    created_by: uuid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    // Idempotency key of the server-to-server operation that created the project (for example
    // `slack-import:<import id>`), so POST /internal/projects/ensure answers a replay with its own
    // project and never with an unrelated project that happens to hold the slug (#373).
    ensure_key: varchar('ensure_key', { length: 200 }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('projects_org_id_idx').on(table.org_id),
    uniqueIndex('projects_org_slug_idx').on(table.org_id, table.slug),
    uniqueIndex('projects_org_ensure_key_idx')
      .on(table.org_id, table.ensure_key)
      .where(sql`ensure_key IS NOT NULL`),
  ],
);
