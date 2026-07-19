import { pgTable, pgEnum, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

// Local Drizzle view of the shared agent_proposals table (migration 0128). Bulwark inserts
// notice/chase drafts directly with approver_id=NULL (spec 2.2). Note org_id, not
// organization_id (D8 boundary). The enum types already exist in the DB; declaring them
// here just informs Drizzle's column types.
export const proposalStatusEnum = pgEnum('proposal_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
  'revoked',
  'revising',
]);

export const actorTypeEnum = pgEnum('actor_type', ['human', 'agent', 'service']);

export const agentProposals = pgTable(
  'agent_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actor_id: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    proposer_kind: actorTypeEnum('proposer_kind').notNull(),
    proposed_action: text('proposed_action').notNull(),
    proposed_payload: jsonb('proposed_payload').default({}).notNull(),
    subject_type: text('subject_type'),
    subject_id: uuid('subject_id'),
    approver_id: uuid('approver_id').references(() => users.id, { onDelete: 'set null' }),
    status: proposalStatusEnum('status').default('pending').notNull(),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    decision_reason: text('decision_reason'),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_agent_proposals_approver_status').on(table.approver_id, table.status),
    index('idx_agent_proposals_org_status_created').on(table.org_id, table.status, table.created_at),
    index('idx_agent_proposals_actor_created').on(table.actor_id, table.created_at),
    index('idx_agent_proposals_expires_pending').on(table.expires_at),
  ],
);
