import { pgTable, uuid, varchar, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bulwarkContracts } from './bulwark-contracts.js';
import { bulwarkObligations } from './bulwark-obligations.js';
import { bulwarkIngestEvents } from './bulwark-ingest-events.js';
import { agentProposals } from './agent-proposals.js';

// A live deadline instance (spec 3.1). triggering_event_id is the deterministic arm key
// (STK1/DK1), computed identically by the live drain and bulwark-state-reconcile so both
// converge on one at-most-once atom. The obligation FK is ON DELETE RESTRICT (THEME C) so a
// live clock blocks an accidental obligation delete. notice_draft carries ONLY subject +
// body_markdown; recipient/attachments are deterministic at send (THEME E).
export const bulwarkNoticeDeadlines = pgTable(
  'bulwark_notice_deadlines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    obligation_id: uuid('obligation_id')
      .notNull()
      .references(() => bulwarkObligations.id, { onDelete: 'restrict' }),
    contract_id: uuid('contract_id')
      .notNull()
      .references(() => bulwarkContracts.id, { onDelete: 'cascade' }),
    ingest_event_id: uuid('ingest_event_id').references(() => bulwarkIngestEvents.id, {
      onDelete: 'set null',
    }),
    triggering_event_id: uuid('triggering_event_id').notNull(),
    // The two components of the deterministic EVENT arm key (STJ4), persisted so amendment
    // supersession can recompute uuid5(successor_id || arm_scope_entity_id || arm_state_epoch)
    // in place rather than leaving the stale predecessor key. Null for calendar/manual arms.
    arm_scope_entity_id: uuid('arm_scope_entity_id'),
    arm_state_epoch: varchar('arm_state_epoch', { length: 64 }),
    anchor_source: varchar('anchor_source', { length: 12 }).notNull(),
    triggered_at: timestamp('triggered_at', { withTimezone: true }).notNull(),
    logged_at: timestamp('logged_at', { withTimezone: true }),
    resolved_timezone: varchar('resolved_timezone', { length: 64 }).notNull(),
    due_at: timestamp('due_at', { withTimezone: true }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('open'),
    notice_status: varchar('notice_status', { length: 16 }).notNull().default('none'),
    notice_proposal_id: uuid('notice_proposal_id').references(() => agentProposals.id, {
      onDelete: 'set null',
    }),
    notice_draft: jsonb('notice_draft').notNull().default('{}'),
    discharged_at: timestamp('discharged_at', { withTimezone: true }),
    radar_marker: timestamp('radar_marker', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bulwark_deadlines_arm').on(
      table.organization_id,
      table.obligation_id,
      table.triggering_event_id,
    ),
    index('idx_bulwark_deadlines_radar').on(table.organization_id, table.status, table.due_at),
    index('idx_bulwark_deadlines_org_contract').on(table.organization_id, table.contract_id),
    index('idx_bulwark_deadlines_proposal').on(table.notice_proposal_id),
    index('idx_bulwark_deadlines_org_notice').on(table.organization_id, table.notice_status),
  ],
);
