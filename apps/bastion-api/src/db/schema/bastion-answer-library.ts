// Mirrors bastion_answer_library as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { boolean, customType, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bastionQuestionnaireItems } from './bastion-questionnaire-items.js';
import { organizations, users } from './bbb-refs.js';

// Drizzle has no first-class tsvector column kind (mirrors braid-profiles.ts).
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const bastionAnswerLibrary = pgTable(
  'bastion_answer_library',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    question_text: varchar('question_text', { length: 4000 }).notNull(),
    answer_text: text('answer_text').notNull(),
    yes_no: boolean('yes_no'),
    cited_refs: jsonb('cited_refs').default([]).notNull(),
    source_item_id: uuid('source_item_id').references(() => bastionQuestionnaireItems.id, { onDelete: 'set null' }),
    approved_by: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    stale: boolean('stale').default(false).notNull(),
    stale_reason: varchar('stale_reason', { length: 128 }),
    retired_at: timestamp('retired_at', { withTimezone: true }),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', coalesce(question_text, '') || ' ' || coalesce(answer_text, ''))`),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
