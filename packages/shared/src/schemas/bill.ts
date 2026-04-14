import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────
export const BillPaymentMethod = z.enum([
  'bank_transfer',
  'credit_card',
  'check',
  'cash',
  'stripe',
  'paypal',
  'other',
]);
export const BillRateType = z.enum(['hourly', 'daily', 'fixed']);

// ── Client schemas ─────────────────────────────────────────────────────
export const createBillClientSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(50).optional(),
  address_line1: z.string().max(255).optional(),
  address_line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state_region: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  country: z.string().length(2).optional(),
  tax_id: z.string().max(50).optional(),
  bond_company_id: z.string().uuid().optional(),
  default_payment_terms_days: z.number().int().min(0).max(365).optional(),
  default_payment_instructions: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
});

export const updateBillClientSchema = createBillClientSchema.partial();

export const listBillClientsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().optional(),
});

// ── Invoice schemas ────────────────────────────────────────────────────
export const createBillInvoiceSchema = z.object({
  client_id: z.string().uuid(),
  project_id: z.string().uuid().optional(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tax_rate: z.number().min(0).max(100).optional(),
  discount_amount: z.number().int().min(0).optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  payment_instructions: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
  footer_text: z.string().max(2000).optional(),
  terms_text: z.string().max(5000).optional(),
  bond_deal_id: z.string().uuid().optional(),
});

export const updateBillInvoiceSchema = createBillInvoiceSchema.partial();

export const listBillInvoicesQuerySchema = z.object({
  status: z.string().optional(),
  client_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().optional(),
});

export const createBillInvoiceLineItemSchema = z.object({
  description: z.string().min(1).max(1000),
  quantity: z.number().positive().optional(),
  unit: z.string().max(20).optional(),
  unit_price: z.number().int().min(0),
  sort_order: z.number().int().optional(),
  time_entry_ids: z.array(z.string().uuid()).optional(),
  task_id: z.string().uuid().optional(),
});

export const updateBillInvoiceLineItemSchema = z.object({
  description: z.string().min(1).max(1000).optional(),
  quantity: z.number().positive().optional(),
  unit: z.string().max(20).optional(),
  unit_price: z.number().int().min(0).optional(),
  sort_order: z.number().int().optional(),
});

// ── Expense schemas ────────────────────────────────────────────────────
export const createBillExpenseSchema = z.object({
  project_id: z.string().uuid().optional(),
  description: z.string().min(1).max(1000),
  amount: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  category: z.string().max(60).optional(),
  vendor: z.string().max(255).optional(),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  receipt_url: z.string().url().optional(),
  receipt_filename: z.string().max(255).optional(),
  billable: z.boolean().optional(),
});

export const updateBillExpenseSchema = createBillExpenseSchema.partial();

export const listBillExpensesQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().optional(),
});

// ── Payment schemas ────────────────────────────────────────────────────
export const recordBillPaymentSchema = z.object({
  amount: z.number().int().positive(),
  payment_method: BillPaymentMethod.optional(),
  reference: z.string().max(255).optional(),
  notes: z.string().max(2000).optional(),
  paid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ── Rate schemas ───────────────────────────────────────────────────────
export const createBillRateSchema = z.object({
  project_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  rate_amount: z.number().int().positive(),
  rate_type: BillRateType.optional(),
  currency: z.string().length(3).optional(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const updateBillRateSchema = z.object({
  rate_amount: z.number().int().positive().optional(),
  rate_type: BillRateType.optional(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const listBillRatesQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});

export const resolveBillRateQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ── Settings schemas ───────────────────────────────────────────────────
export const updateBillSettingsSchema = z.object({
  company_name: z.string().max(255).optional(),
  company_email: z.string().email().max(255).optional(),
  company_phone: z.string().max(50).optional(),
  company_address: z.string().max(2000).optional(),
  company_logo_url: z.string().url().optional(),
  company_tax_id: z.string().max(50).optional(),
  default_currency: z.string().length(3).optional(),
  default_tax_rate: z.number().min(0).max(100).optional(),
  default_payment_terms_days: z.number().int().min(0).max(365).optional(),
  default_payment_instructions: z.string().max(2000).optional(),
  default_footer_text: z.string().max(2000).optional(),
  default_terms_text: z.string().max(5000).optional(),
  invoice_prefix: z.string().min(1).max(20).optional(),
});
