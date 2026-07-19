import {
  pgTable,
  uuid,
  text,
  numeric,
  varchar,
  bigint,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { billInvoices } from './bill-invoices.js';

export const billLineItems = pgTable(
  'bill_line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoice_id: uuid('invoice_id')
      .notNull()
      .references(() => billInvoices.id, { onDelete: 'cascade' }),
    sort_order: integer('sort_order').notNull().default(0),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 10, scale: 2 }).notNull().default('1'),
    unit: varchar('unit', { length: 20 }).default('hours'),
    unit_price: bigint('unit_price', { mode: 'number' }).notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    time_entry_ids: uuid('time_entry_ids').array(),
    task_id: uuid('task_id'),
    // Added by migration 0245_bill_burn_gate_acting_user.sql (Burn spec 9.2, 2.4 point 11).
    // The human authority a service-to-service write acted under. Populated only by
    // POST /internal/invoices/:id/line-items, where the caller is a service holding the
    // internal secret and the deciding human must be recorded explicitly. NULL on the
    // session-authenticated SPA path, where request.user is already the recorded actor.
    // There is deliberately NO trusted X-Acting-User header: the acting user arrives in
    // the body and the caller is expected to have CHECKED that user's permission through
    // POST /internal/permissions/dual-read first.
    acting_user_id: uuid('acting_user_id'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bill_items_invoice').on(table.invoice_id, table.sort_order),
  ],
);
