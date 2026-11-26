// Mirrors bastion_questionnaire_items as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { boolean, integer, jsonb, numeric, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionQuestionnaires } from './bastion-questionnaires.js';
import { organizations, users } from './bbb-refs.js';

export const bastionQuestionnaireItems = pgTable(
  'bastion_questionnaire_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    questionnaire_id: uuid('questionnaire_id').notNull().references(() => bastionQuestionnaires.id, { onDelete: 'cascade' }),
    sheet_name: varchar('sheet_name', { length: 128 }).default('').notNull(),
    row_index: integer('row_index').notNull(),
    section: varchar('section', { length: 256 }),
    question_text: varchar('question_text', { length: 4000 }).notNull(),
    answer_kind: varchar('answer_kind', { length: 16 }).default('yes_no_text').notNull(),
    draft_answer: text('draft_answer'),
    draft_yes_no: boolean('draft_yes_no'),
    final_answer: text('final_answer'),
    final_yes_no: boolean('final_yes_no'),
    cited_refs: jsonb('cited_refs').default([]).notNull(),
    dropped_citation_count: integer('dropped_citation_count').default(0).notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    confidence_band: varchar('confidence_band', { length: 8 }),
    band_reasons: jsonb('band_reasons').default([]).notNull(),
    review_status: varchar('review_status', { length: 16 }).default('pending').notNull(),
    assigned_to: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    reviewed_by: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
  },
);
