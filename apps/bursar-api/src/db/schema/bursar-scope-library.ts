import {
  pgTable,
  uuid,
  varchar,
  text,
  numeric,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

/**
 * Scope library (spec 6.1, migration 0247). Built-ins are GLOBAL (organization_id NULL,
 * is_global = true); org rows are is_global = false. Globals are immutable to org callers
 * via a BEFORE INSERT OR UPDATE OR DELETE trigger and get the variant RLS policy (0251).
 * unit_price_minor is bigint minor units with an explicit currency.
 */
export const bursarScopeLibrary = pgTable(
  'bursar_scope_library',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Nullable: NULL for a global built-in row.
    organization_id: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    is_global: boolean('is_global').notNull().default(false),
    category: varchar('category', { length: 64 }).notNull().default('general'),
    title: varchar('title', { length: 512 }).notNull(),
    description: text('description'),
    node_kind: varchar('node_kind', { length: 32 }).notNull().default('requirement'),
    // mandatory | should_have | nice_to_have | informational
    normative_strength: varchar('normative_strength', { length: 16 }).notNull().default('mandatory'),
    unit: varchar('unit', { length: 32 }),
    default_quantity: numeric('default_quantity', { precision: 18, scale: 4 }),
    unit_price_minor: bigint('unit_price_minor', { mode: 'number' }),
    currency: varchar('currency', { length: 3 }),
    tags: jsonb('tags').notNull().default([]),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bursar_scope_library_org').on(table.organization_id, table.category),
    index('idx_bursar_scope_library_global').on(table.category),
  ],
);
