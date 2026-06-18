import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  numeric,
  integer,
  boolean,
  date,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';
import { billClients } from './bill-clients.js';

/**
 * bill_recurring_invoices is a subscription/recurring-billing schedule.
 *
 * Each row is a template that the daily worker tick
 * (apps/worker/src/jobs/bill-recurring-generate.job.ts) materialises into a
 * real bill_invoices row whenever next_run_at <= now() and status = 'active'.
 * The line-item template lives in bill_recurring_line_items.
 *
 * Created by migration 0198_bill_recurring_invoices.sql.
 */
export const billRecurringInvoices = pgTable(
  'bill_recurring_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    client_id: uuid('client_id')
      .notNull()
      .references(() => billClients.id, { onDelete: 'restrict' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 255 }).notNull(),
    // active | paused | cancelled
    status: varchar('status', { length: 20 }).notNull().default('active'),
    // weekly | monthly | quarterly | annually
    cadence: varchar('cadence', { length: 20 }).notNull(),
    // Whether generated invoices are auto-finalized or left as drafts.
    auto_finalize: boolean('auto_finalize').notNull().default(false),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    tax_rate: numeric('tax_rate', { precision: 5, scale: 2 }).default('0'),
    discount_amount: bigint('discount_amount', { mode: 'number' }).notNull().default(0),
    payment_terms_days: integer('payment_terms_days').notNull().default(30),
    payment_instructions: text('payment_instructions'),
    notes: text('notes'),
    footer_text: text('footer_text'),
    terms_text: text('terms_text'),
    start_date: date('start_date').notNull().defaultNow(),
    end_date: date('end_date'),
    next_run_at: timestamp('next_run_at', { withTimezone: true }).notNull(),
    last_run_at: timestamp('last_run_at', { withTimezone: true }),
    invoices_generated: integer('invoices_generated').notNull().default(0),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bill_recurring_org').on(table.organization_id),
    index('idx_bill_recurring_client').on(table.client_id),
    index('idx_bill_recurring_due').on(table.status, table.next_run_at),
  ],
);

export const billRecurringLineItems = pgTable(
  'bill_recurring_line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recurring_invoice_id: uuid('recurring_invoice_id')
      .notNull()
      .references(() => billRecurringInvoices.id, { onDelete: 'cascade' }),
    sort_order: integer('sort_order').notNull().default(0),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 10, scale: 2 }).notNull().default('1'),
    unit: varchar('unit', { length: 20 }).default('units'),
    unit_price: bigint('unit_price', { mode: 'number' }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bill_recurring_items_parent').on(
      table.recurring_invoice_id,
      table.sort_order,
    ),
  ],
);

export type BillRecurringCadence = 'weekly' | 'monthly' | 'quarterly' | 'annually';
export type BillRecurringStatus = 'active' | 'paused' | 'cancelled';
