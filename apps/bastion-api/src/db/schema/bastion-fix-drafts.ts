// Mirrors bastion_fix_drafts as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionGaps } from './bastion-gaps.js';
import { organizations, users } from './bbb-refs.js';

export const bastionFixDrafts = pgTable(
  'bastion_fix_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    gap_id: uuid('gap_id').references(() => bastionGaps.id, { onDelete: 'set null' }),
    template: varchar('template', { length: 24 }).notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    body_markdown: text('body_markdown'),
    payload: jsonb('payload').default({}).notNull(),
    cited_refs: jsonb('cited_refs').default([]).notNull(),
    dropped_citation_count: integer('dropped_citation_count').default(0).notNull(),
    proposal_id: uuid('proposal_id'),
    status: varchar('status', { length: 24 }).default('proposed').notNull(),
    decided_by: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    applied_entity_type: varchar('applied_entity_type', { length: 48 }),
    applied_entity_id: uuid('applied_entity_id'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_by_kind: varchar('created_by_kind', { length: 16 }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
