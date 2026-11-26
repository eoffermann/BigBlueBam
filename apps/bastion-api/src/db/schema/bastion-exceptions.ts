// Mirrors bastion_exceptions as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, boolean, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionAssertions } from './bastion-assertions.js';
import { bastionControls } from './bastion-controls.js';
import { organizations } from './bbb-refs.js';

export const bastionExceptions = pgTable(
  'bastion_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    control_id: uuid('control_id').notNull().references(() => bastionControls.id, { onDelete: 'restrict' }),
    assertion_id: uuid('assertion_id').references(() => bastionAssertions.id, { onDelete: 'restrict' }),
    scope: varchar('scope', { length: 16 }).notNull(),
    cited_entity_type: varchar('cited_entity_type', { length: 48 }),
    cited_entity_id: uuid('cited_entity_id'),
    frozen_refs: jsonb('frozen_refs'),
    reason: text('reason').notNull(),
    compensating_note: text('compensating_note'),
    proposal_id: uuid('proposal_id'),
    status: varchar('status', { length: 16 }).default('proposed').notNull(),
    proposed_by: uuid('proposed_by').notNull(),
    decided_by: uuid('decided_by'),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    small_team_self_approval: boolean('small_team_self_approval').default(false).notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    personal_data_hmac: varchar('personal_data_hmac', { length: 64 }),
    pd_hmac_key_id: varchar('pd_hmac_key_id', { length: 64 }),
    ledger_seq: bigint('ledger_seq', { mode: 'number' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
