import { pgTable, uuid, varchar, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

/**
 * Canonical mirror of apps/api/src/db/schema/organizations.ts.
 *
 * The `settings` JSONB column carries org-level permission flags, branding,
 * and feature toggles. The shape is documented on the Bam canonical file; we
 * keep it untyped here so consumers that only need the column reference do
 * not have to pull in the full type surface.
 */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  logo_url: text('logo_url'),
  plan: varchar('plan', { length: 50 }).default('free').notNull(),
  settings: jsonb('settings').default({}).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
