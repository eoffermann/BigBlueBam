import { eq, and, desc, gte, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { billExpenses } from '../db/schema/index.js';
import { notFound, badRequest } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpenseFilters {
  organization_id: string;
  project_id?: string;
  category?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
}

export interface CreateExpenseInput {
  project_id?: string;
  description: string;
  amount: number;
  currency?: string;
  category?: string;
  vendor?: string;
  expense_date?: string;
  receipt_url?: string;
  receipt_filename?: string;
  billable?: boolean;
}

export interface UpdateExpenseInput {
  project_id?: string;
  description?: string;
  amount?: number;
  category?: string;
  vendor?: string;
  expense_date?: string;
  receipt_url?: string;
  receipt_filename?: string;
  billable?: boolean;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listExpenses(filters: ExpenseFilters) {
  const conditions: any[] = [eq(billExpenses.organization_id, filters.organization_id)];

  if (filters.project_id) conditions.push(eq(billExpenses.project_id, filters.project_id));
  if (filters.category) conditions.push(eq(billExpenses.category, filters.category));
  if (filters.status) conditions.push(eq(billExpenses.status, filters.status));
  if (filters.date_from) conditions.push(gte(billExpenses.expense_date, filters.date_from));
  if (filters.date_to) conditions.push(lte(billExpenses.expense_date, filters.date_to));

  const rows = await db
    .select()
    .from(billExpenses)
    .where(and(...conditions))
    .orderBy(desc(billExpenses.created_at));

  return { data: rows };
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

export async function getExpense(id: string, orgId: string) {
  const [expense] = await db
    .select()
    .from(billExpenses)
    .where(and(eq(billExpenses.id, id), eq(billExpenses.organization_id, orgId)))
    .limit(1);

  if (!expense) throw notFound('Expense not found');
  return expense;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createExpense(input: CreateExpenseInput, orgId: string, userId: string) {
  const [expense] = await db
    .insert(billExpenses)
    .values({
      organization_id: orgId,
      project_id: input.project_id,
      description: input.description,
      amount: input.amount,
      currency: input.currency ?? 'USD',
      category: input.category,
      vendor: input.vendor,
      expense_date: input.expense_date ?? new Date().toISOString().split('T')[0]!,
      receipt_url: input.receipt_url,
      receipt_filename: input.receipt_filename,
      billable: input.billable ?? false,
      submitted_by: userId,
    })
    .returning();

  return expense!;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateExpense(id: string, orgId: string, input: UpdateExpenseInput) {
  const existing = await getExpense(id, orgId);
  if (existing.status === 'approved' || existing.status === 'reimbursed') {
    throw badRequest('Cannot edit an approved or reimbursed expense');
  }

  const [updated] = await db
    .update(billExpenses)
    .set({
      ...input,
      updated_at: new Date(),
    })
    .where(and(eq(billExpenses.id, id), eq(billExpenses.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Expense not found');
  return updated;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteExpense(id: string, orgId: string) {
  await getExpense(id, orgId);

  const [deleted] = await db
    .delete(billExpenses)
    .where(and(eq(billExpenses.id, id), eq(billExpenses.organization_id, orgId)))
    .returning({ id: billExpenses.id });

  if (!deleted) throw notFound('Expense not found');
  return deleted;
}

// ---------------------------------------------------------------------------
// Approve / Reject
// ---------------------------------------------------------------------------

export async function approveExpense(id: string, orgId: string, userId: string) {
  const existing = await getExpense(id, orgId);
  if (existing.status !== 'pending') {
    throw badRequest('Only pending expenses can be approved');
  }

  const [approved] = await db
    .update(billExpenses)
    .set({ status: 'approved', approved_by: userId, updated_at: new Date() })
    .where(and(eq(billExpenses.id, id), eq(billExpenses.organization_id, orgId)))
    .returning();

  return approved!;
}

export async function rejectExpense(id: string, orgId: string, userId: string) {
  const existing = await getExpense(id, orgId);
  if (existing.status !== 'pending') {
    throw badRequest('Only pending expenses can be rejected');
  }

  const [rejected] = await db
    .update(billExpenses)
    .set({ status: 'rejected', approved_by: userId, updated_at: new Date() })
    .where(and(eq(billExpenses.id, id), eq(billExpenses.organization_id, orgId)))
    .returning();

  return rejected!;
}

// ---------------------------------------------------------------------------
// Reimburse — mark an approved expense as reimbursed (paid back to the
// submitter). The terminal step of the expense lifecycle:
// pending -> approved -> reimbursed.
// ---------------------------------------------------------------------------

export async function reimburseExpense(id: string, orgId: string) {
  const existing = await getExpense(id, orgId);
  if (existing.status !== 'approved') {
    throw badRequest('Only approved expenses can be marked reimbursed');
  }

  const [reimbursed] = await db
    .update(billExpenses)
    .set({ status: 'reimbursed', updated_at: new Date() })
    .where(and(eq(billExpenses.id, id), eq(billExpenses.organization_id, orgId)))
    .returning();

  return reimbursed!;
}
