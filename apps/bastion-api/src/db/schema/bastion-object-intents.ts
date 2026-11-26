// Mirrors bastion_object_intents as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

export const bastionObjectIntents = pgTable(
  'bastion_object_intents',
  {
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    object_key: varchar('object_key', { length: 512 }).primaryKey(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
