import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';
import { bayAssetVersions } from './bay-asset-versions.js';

// Bay review decisions (Bay master). One decision per reviewer per version
// (unique (version_id, reviewer_id)) — upsert semantics: a reviewer changing
// their mind updates the existing row rather than appending. decision is one of
// approved | rejected | changes_requested | pending (CHECK in migration).
export const bayReviewDecisions = pgTable(
  'bay_review_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    version_id: uuid('version_id')
      .notNull()
      .references(() => bayAssetVersions.id, { onDelete: 'cascade' }),
    reviewer_id: uuid('reviewer_id')
      .notNull()
      .references(() => users.id),
    // approved | rejected | changes_requested | pending  (CHECK in migration).
    decision: text('decision').notNull(),
    comment: text('comment'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_bay_review_decisions_version_reviewer').on(table.version_id, table.reviewer_id),
    index('idx_bay_review_decisions_version').on(table.version_id),
  ],
);
