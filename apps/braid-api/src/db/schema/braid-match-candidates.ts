import {
  pgTable,
  uuid,
  numeric,
  jsonb,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

// The human review queue. `profile_a_id < profile_b_id` canonical CHECK is declared in
// the migration. `proposal_id` links to agent_proposals (FK in migration; the subscription
// reverse-lookup key, spec 5.4). bridge_identity_* are the suppression atoms and the source
// of a bridged candidate's score (spec 2.3 / 4.4).
export const braidMatchCandidates = pgTable(
  'braid_match_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    profile_a_id: uuid('profile_a_id').notNull(),
    profile_b_id: uuid('profile_b_id').notNull(),
    bridge_identity_a_id: uuid('bridge_identity_a_id').notNull(),
    bridge_identity_b_id: uuid('bridge_identity_b_id').notNull(),
    score: numeric('score', { precision: 5, scale: 2 }).notNull(),
    evidence: jsonb('evidence').notNull(),
    rationale: text('rationale'),
    status: varchar('status', { length: 12 }).notNull().default('pending'),
    proposal_id: uuid('proposal_id'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    decided_at: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('idx_braid_candidates_org_pair').on(
      table.organization_id,
      table.profile_a_id,
      table.profile_b_id,
    ),
    index('idx_braid_candidates_org_status_score').on(
      table.organization_id,
      table.status,
      table.score,
    ),
    index('idx_braid_candidates_a').on(table.profile_a_id),
    index('idx_braid_candidates_b').on(table.profile_b_id),
    index('idx_braid_candidates_proposal').on(table.proposal_id),
    index('idx_braid_candidates_org_status_created').on(
      table.organization_id,
      table.status,
      table.created_at,
    ),
  ],
);
