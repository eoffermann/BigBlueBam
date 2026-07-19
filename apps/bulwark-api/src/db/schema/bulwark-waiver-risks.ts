import { pgTable, uuid, varchar, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { bulwarkContracts } from './bulwark-contracts.js';
import { bulwarkObligations } from './bulwark-obligations.js';
import { bulwarkNoticeDeadlines } from './bulwark-notice-deadlines.js';

// A flagged waiver risk (spec 3.1). obligation FK is ON DELETE RESTRICT and deadline FK is
// ON DELETE SET NULL: a risk is never cascade-deleted (D3, the dispute record). Retained
// indefinitely.
export const bulwarkWaiverRisks = pgTable(
  'bulwark_waiver_risks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    obligation_id: uuid('obligation_id')
      .notNull()
      .references(() => bulwarkObligations.id, { onDelete: 'restrict' }),
    deadline_id: uuid('deadline_id').references(() => bulwarkNoticeDeadlines.id, {
      onDelete: 'set null',
    }),
    contract_id: uuid('contract_id')
      .notNull()
      .references(() => bulwarkContracts.id, { onDelete: 'cascade' }),
    severity: varchar('severity', { length: 8 }).notNull(),
    reason: varchar('reason', { length: 32 }).notNull(),
    detail: jsonb('detail').notNull().default('{}'),
    status: varchar('status', { length: 12 }).notNull().default('open'),
    detected_at: timestamp('detected_at', { withTimezone: true }),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_bulwark_waiver_risks_dedup').on(
      table.organization_id,
      table.obligation_id,
      table.deadline_id,
      table.reason,
    ),
    index('idx_bulwark_waiver_risks_org_status_sev').on(
      table.organization_id,
      table.status,
      table.severity,
    ),
    index('idx_bulwark_waiver_risks_org_contract').on(table.organization_id, table.contract_id),
  ],
);
