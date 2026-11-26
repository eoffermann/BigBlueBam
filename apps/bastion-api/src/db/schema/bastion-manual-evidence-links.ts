// Mirrors bastion_manual_evidence_links as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { boolean, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionAssertions } from './bastion-assertions.js';
import { bastionManualEvidence } from './bastion-manual-evidence.js';
import { organizations, users } from './bbb-refs.js';

export const bastionManualEvidenceLinks = pgTable(
  'bastion_manual_evidence_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    manual_evidence_id: uuid('manual_evidence_id').notNull().references(() => bastionManualEvidence.id, { onDelete: 'restrict' }),
    assertion_id: uuid('assertion_id').notNull().references(() => bastionAssertions.id, { onDelete: 'cascade' }),
    review_verdict: varchar('review_verdict', { length: 16 }).default('pending').notNull(),
    reviewed_by: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
    review_note: text('review_note'),
    small_team_self_review: boolean('small_team_self_review').default(false).notNull(),
    linked_by: uuid('linked_by').references(() => users.id, { onDelete: 'set null' }),
    linked_at: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
    unlinked_at: timestamp('unlinked_at', { withTimezone: true }),
  },
);
