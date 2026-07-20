import { pgTable, uuid, varchar, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

/**
 * Spend-import batch header (spec 6.1, migration 0249). Unique (organization_id, file_sha256)
 * with an upsert-and-resume contract: a crashed import is retried by re-uploading the same
 * file, and "0 new" derives from rows_deduped, never from this row's existence.
 */
export const bursarSpendImports = pgTable(
  'bursar_spend_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    file_sha256: varchar('file_sha256', { length: 64 }).notNull(),
    filename: varchar('filename', { length: 512 }),
    row_count: integer('row_count').notNull().default(0),
    rows_inserted: integer('rows_inserted').notNull().default(0),
    rows_deduped: integer('rows_deduped').notNull().default(0),
    // running | succeeded | partial | failed
    status: varchar('status', { length: 16 }).notNull().default('running'),
    imported_by: uuid('imported_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bursar_spend_imports_file').on(table.organization_id, table.file_sha256),
    index('idx_bursar_spend_imports_org_status').on(table.organization_id, table.status),
  ],
);
