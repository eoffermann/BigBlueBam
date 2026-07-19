import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  boolean,
  date,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';
import { billInvoices } from './bill-invoices.js';

export const billExpenses = pgTable(
  'bill_expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    category: varchar('category', { length: 60 }),
    vendor: varchar('vendor', { length: 255 }),
    expense_date: date('expense_date').notNull().defaultNow(),
    receipt_url: text('receipt_url'),
    receipt_filename: varchar('receipt_filename', { length: 255 }),
    // Added by migration 0087_bill_expense_receipt_metadata.sql.
    // Populated when a receipt image is uploaded through the multipart
    // endpoint so the SPA can preview files correctly and we can size-limit
    // at the service layer.
    receipt_mime_type: varchar('receipt_mime_type', { length: 100 }),
    receipt_size_bytes: bigint('receipt_size_bytes', { mode: 'number' }),
    receipt_uploaded_at: timestamp('receipt_uploaded_at', { withTimezone: true }),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    approved_by: uuid('approved_by').references(() => users.id),
    billable: boolean('billable').notNull().default(false),
    invoiced: boolean('invoiced').notNull().default(false),
    invoice_id: uuid('invoice_id').references(() => billInvoices.id, { onDelete: 'set null' }),
    submitted_by: uuid('submitted_by')
      .notNull()
      .references(() => users.id),
    // Added by migration 0245_bill_burn_gate_acting_user.sql (Burn spec 6.1, "Deferred
    // fail-open outcome"). On the fail-open path bill-api has no precheck_id to call back
    // with, so it stamps the row instead: 'unavailable' when burn-api could not be reached
    // (or the breaker was open, or the call timed out, or Redis was down) and
    // 'not_configured' when BURN_API_INTERNAL_URL is unset. burn-variance-sweep reads this
    // on recovery to raise ungated_charge against real rows. NULL means the gate ran.
    burn_gate: varchar('burn_gate', { length: 32 }),
    // The burn_prechecks row this expense was gated by, when the gate DID run. Lets
    // burn-api's POST /v1/internal/prechecks/:id/outcome callback and the gate log join
    // a verdict to the charge that actually posted.
    burn_precheck_id: uuid('burn_precheck_id'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bill_expenses_org').on(table.organization_id),
    index('idx_bill_expenses_project').on(table.project_id),
    index('idx_bill_expenses_status').on(table.status),
  ],
);
