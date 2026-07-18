import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  numeric,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { actorTypeEnum } from './agent-proposals.js';

// Immutable audit for every merge, split, auto-merge, and reject (never updated or
// deleted). `affected_identity_ids` records exactly which identities a decision moved,
// so a split/unmerge replays deterministically (spec 4.5). `decided_by_kind` reuses the
// platform actor_type enum (declared as varchar here; the migration binds the enum type).
export const braidMergeDecisions = pgTable(
  'braid_merge_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    decision_kind: varchar('decision_kind', { length: 8 }).notNull(),
    surviving_profile_id: uuid('surviving_profile_id'),
    absorbed_profile_id: uuid('absorbed_profile_id'),
    affected_identity_ids: jsonb('affected_identity_ids').notNull().default('[]'),
    reverses_decision_id: uuid('reverses_decision_id'),
    candidate_id: uuid('candidate_id'),
    score_at_decision: numeric('score_at_decision', { precision: 5, scale: 2 }),
    decided_by: uuid('decided_by')
      .notNull()
      .references(() => users.id),
    decided_by_kind: actorTypeEnum('decided_by_kind').notNull(),
    reason: text('reason'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_braid_decisions_org_created').on(table.organization_id, table.created_at),
    index('idx_braid_decisions_surviving').on(table.surviving_profile_id, table.created_at),
    index('idx_braid_decisions_candidate').on(table.candidate_id),
    index('idx_braid_decisions_reverses').on(table.reverses_decision_id),
  ],
);
