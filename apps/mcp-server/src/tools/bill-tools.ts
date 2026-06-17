import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { isUuid } from '../middleware/resolve-helpers.js';

interface BillClient {
  request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: unknown }>;
}

function createBillClient(billApiUrl: string, api: ApiClient): BillClient {
  const baseUrl = billApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};

    const token = (api as unknown as { token?: string }).token;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    // Tolerate empty (204 No Content) and non-JSON bodies so DELETE/204 tools
    // report success instead of throwing "Unexpected end of JSON input".
    const __text = await res.text();
    let data: unknown = null;
    if (__text) {
      try {
        data = JSON.parse(__text);
      } catch {
        data = __text;
      }
    }
    return { ok: res.ok, status: res.status, data };
  }

  return { request };
}

/**
 * Resolve a billing client identifier that may be a UUID, a client name, or an email.
 *
 * Strategy: if already a UUID, return unchanged. Otherwise hit
 * `GET /clients?search=...&limit=5` (added in Phase C) and prefer an exact
 * case-insensitive match on name or email. If there is exactly one fuzzy
 * hit we accept it; otherwise we bail with `null` so the caller can surface
 * a clean "client not found / ambiguous" error rather than forwarding a
 * garbage UUID to the Bill API.
 */
async function resolveBillClientId(
  bill: BillClient,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await bill.request(
    'GET',
    `/clients?search=${encodeURIComponent(nameOrId)}&limit=5`,
  );
  if (!result.ok) return null;
  const envelope = result.data as {
    data?: Array<{ id: string; name: string; email?: string | null }>;
  } | null;
  const clients = envelope?.data ?? [];
  const needle = nameOrId.toLowerCase();
  const exact = clients.find(
    (c) =>
      c.name.toLowerCase() === needle ||
      (c.email?.toLowerCase() ?? '') === needle,
  );
  if (exact) return exact.id;
  if (clients.length === 1) return clients[0]!.id;
  return null;
}

/**
 * Resolve a Bam project identifier (UUID or name) to a UUID by listing
 * projects the caller can see and matching case-insensitively. Mirrors the
 * pattern in task-tools.ts — there is no dedicated `/projects/by-name`
 * endpoint, so we list and filter client-side.
 */
async function resolveBamProjectId(
  api: ApiClient,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await api.get('/projects?limit=200');
  if (!result.ok) return null;
  const envelope = result.data as { data?: Array<{ id: string; name: string }> } | null;
  const projects = envelope?.data ?? [];
  const needle = nameOrId.toLowerCase();
  const match = projects.find((p) => p.name.toLowerCase() === needle);
  return match?.id ?? null;
}

function notFound(label: string, value: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${label} not found: ${value}`,
      },
    ],
    isError: true as const,
  };
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(label: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error ${label}: ${JSON.stringify(data)}` }],
    isError: true as const,
  };
}

function buildQs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

const invoiceShape = z.object({
  id: z.string().uuid(),
  status: z.string(),
  client_id: z.string().uuid().optional(),
  project_id: z.string().uuid().nullable().optional(),
  total_cents: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

export function registerBillTools(server: McpServer, api: ApiClient, billApiUrl: string): void {
  const client = createBillClient(billApiUrl, api);

  // ===== 1. bill_list_invoices =====
  registerTool(server, {
    name: 'bill_list_invoices',
    description: 'List invoices, optionally filtered by status, client, project, or date range.',
    input: {
      status: z.string().optional().describe('Filter by status: draft, sent, viewed, paid, overdue, void'),
      client_id: z.string().uuid().optional().describe('Filter by client UUID'),
      project_id: z.string().uuid().optional().describe('Filter by Bam project UUID'),
      date_from: z.string().optional().describe('Filter invoices from this date (YYYY-MM-DD)'),
      date_to: z.string().optional().describe('Filter invoices to this date (YYYY-MM-DD)'),
    },
    returns: z.object({ data: z.array(invoiceShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/invoices${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing invoices', result.data);
    },
  });

  // ===== 2. bill_get_invoice =====
  registerTool(server, {
    name: 'bill_get_invoice',
    description: 'Get full invoice detail including line items and payments.',
    input: {
      invoice_id: z.string().uuid().describe('Invoice UUID'),
    },
    returns: invoiceShape.extend({ line_items: z.array(z.object({ id: z.string().uuid(), description: z.string(), unit_price: z.number() }).passthrough()).optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/invoices/${params.invoice_id}`);
      return result.ok ? ok(result.data) : err('getting invoice', result.data);
    },
  });

  // ===== 3. bill_create_invoice =====
  registerTool(server, {
    name: 'bill_create_invoice',
    description: 'Create a new blank draft invoice for a billing client.',
    input: {
      client_id: z
        .string()
        .describe(
          'Billing client — UUID, exact client name, or client email (resolved via bill_list_clients search)',
        ),
      project_id: z
        .string()
        .optional()
        .describe('Link to a Bam project — UUID or exact project name'),
      tax_rate: z.number().min(0).max(100).optional().describe('Tax rate percentage'),
      notes: z.string().optional().describe('Internal notes'),
    },
    returns: invoiceShape,
    handler: async (params) => {
      const clientId = await resolveBillClientId(client, params.client_id);
      if (!clientId) return notFound('Billing client', params.client_id);

      let projectId: string | undefined;
      if (params.project_id !== undefined) {
        const resolved = await resolveBamProjectId(api, params.project_id);
        if (!resolved) return notFound('Project', params.project_id);
        projectId = resolved;
      }

      const body = {
        ...params,
        client_id: clientId,
        ...(projectId !== undefined ? { project_id: projectId } : {}),
      };
      const result = await client.request('POST', '/invoices', body);
      return result.ok ? ok(result.data) : err('creating invoice', result.data);
    },
  });

  // ===== 4. bill_create_invoice_from_time =====
  registerTool(server, {
    name: 'bill_create_invoice_from_time',
    description:
      'Generate a draft invoice from Bam time entries for a project over a date range. ' +
      'The Bill API resolves every time entry on the project between date_from and date_to ' +
      '(inclusive), groups them by user + task, prices each group via the resolved billing ' +
      'rate, and writes one line item per group. Requires a billing rate configured for each ' +
      'contributing user on the project.',
    input: {
      project_id: z
        .string()
        .describe('Bam project — UUID or exact project name'),
      client_id: z
        .string()
        .describe('Billing client — UUID, exact client name, or client email'),
      date_from: z.string().describe('Start date (YYYY-MM-DD)'),
      date_to: z.string().describe('End date (YYYY-MM-DD)'),
    },
    returns: invoiceShape,
    handler: async (params) => {
      const projectId = await resolveBamProjectId(api, params.project_id);
      if (!projectId) return notFound('Project', params.project_id);
      const clientId = await resolveBillClientId(client, params.client_id);
      if (!clientId) return notFound('Billing client', params.client_id);

      const body = { ...params, project_id: projectId, client_id: clientId };
      const result = await client.request('POST', '/invoices/from-time-entries', body);
      return result.ok ? ok(result.data) : err('creating invoice from time', result.data);
    },
  });

  // ===== 4b. bill_create_invoice_from_deal =====
  registerTool(server, {
    name: 'bill_create_invoice_from_deal',
    description: 'Generate a draft invoice from a Bond CRM deal, pulling deal value and contact info. ' +
      'NOTE: deal_id must be a UUID — Bond deal title search is not reachable from this tool. ' +
      'In a Bolt rule, pass `{{ event.deal.id }}` from the triggering deal.* event.',
    input: {
      deal_id: z
        .string()
        .uuid()
        .describe(
          'Bond deal UUID (required). In a Bolt rule, pass `{{ event.deal.id }}` from a deal.* event — deal title lookup is not supported here.',
        ),
      client_id: z
        .string()
        .describe('Billing client — UUID, exact client name, or client email'),
    },
    returns: invoiceShape,
    handler: async (params) => {
      const clientId = await resolveBillClientId(client, params.client_id);
      if (!clientId) return notFound('Billing client', params.client_id);

      const body = { ...params, client_id: clientId };
      const result = await client.request('POST', '/invoices/from-deal', body);
      return result.ok ? ok(result.data) : err('creating invoice from deal', result.data);
    },
  });

  // ===== 5. bill_add_line_item =====
  registerTool(server, {
    name: 'bill_add_line_item',
    description: 'Add a line item to a draft invoice.',
    input: {
      invoice_id: z.string().uuid().describe('Invoice UUID'),
      description: z.string().describe('Line item description'),
      quantity: z.number().positive().optional().describe('Quantity (default 1)'),
      unit_price: z.number().int().describe('Unit price in cents'),
      unit: z.string().optional().describe('Unit type: hours, days, units, fixed'),
    },
    returns: z.object({ id: z.string().uuid(), invoice_id: z.string().uuid(), description: z.string(), unit_price: z.number() }).passthrough(),
    handler: async (params) => {
      const { invoice_id, ...body } = params;
      const result = await client.request('POST', `/invoices/${invoice_id}/line-items`, body);
      return result.ok ? ok(result.data) : err('adding line item', result.data);
    },
  });

  // ===== 6. bill_finalize_invoice =====
  registerTool(server, {
    name: 'bill_finalize_invoice',
    description: 'Finalize a draft invoice — assigns an invoice number and locks edits.',
    input: {
      invoice_id: z.string().uuid().describe('Invoice UUID'),
    },
    returns: invoiceShape,
    handler: async (params) => {
      const result = await client.request('POST', `/invoices/${params.invoice_id}/finalize`);
      return result.ok ? ok(result.data) : err('finalizing invoice', result.data);
    },
  });

  // ===== 7. bill_send_invoice =====
  registerTool(server, {
    name: 'bill_send_invoice',
    description: 'Mark invoice as sent (triggers email delivery if configured).',
    input: {
      invoice_id: z.string().uuid().describe('Invoice UUID'),
    },
    returns: invoiceShape,
    handler: async (params) => {
      const result = await client.request('POST', `/invoices/${params.invoice_id}/send`);
      return result.ok ? ok(result.data) : err('sending invoice', result.data);
    },
  });

  // ===== 8. bill_record_payment =====
  registerTool(server, {
    name: 'bill_record_payment',
    description: 'Record a payment against an invoice.',
    input: {
      invoice_id: z.string().uuid().describe('Invoice UUID'),
      amount: z.number().int().positive().describe('Payment amount in cents'),
      payment_method: z.enum(['bank_transfer', 'credit_card', 'check', 'cash', 'stripe', 'paypal', 'other']).optional().describe('Payment method'),
      reference: z.string().optional().describe('Transaction reference or check number'),
    },
    returns: z.object({ id: z.string().uuid(), invoice_id: z.string().uuid(), amount: z.number(), paid_at: z.string() }).passthrough(),
    handler: async (params) => {
      const { invoice_id, ...body } = params;
      const result = await client.request('POST', `/invoices/${invoice_id}/payments`, body);
      return result.ok ? ok(result.data) : err('recording payment', result.data);
    },
  });

  // ===== 9. bill_get_overdue =====
  registerTool(server, {
    name: 'bill_get_overdue',
    description: 'List all overdue invoices with days overdue and amount due.',
    input: {},
    returns: z.object({ data: z.array(invoiceShape.extend({ days_overdue: z.number() })) }),
    handler: async () => {
      const result = await client.request('GET', '/reports/overdue');
      return result.ok ? ok(result.data) : err('getting overdue', result.data);
    },
  });

  // ===== 10. bill_get_revenue_summary =====
  registerTool(server, {
    name: 'bill_get_revenue_summary',
    description: 'Get revenue summary by month, showing total invoiced and collected.',
    input: {
      date_from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      date_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
    },
    returns: z.object({ data: z.array(z.object({ month: z.string(), invoiced_cents: z.number(), collected_cents: z.number() }).passthrough()) }),
    handler: async (params) => {
      const result = await client.request('GET', `/reports/revenue${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting revenue', result.data);
    },
  });

  // ===== 11. bill_get_profitability =====
  registerTool(server, {
    name: 'bill_get_profitability',
    description: 'Get project profitability: invoiced revenue vs. logged expenses per project.',
    input: {},
    returns: z.object({ data: z.array(z.object({ project_id: z.string().uuid(), revenue_cents: z.number(), expense_cents: z.number() }).passthrough()) }),
    handler: async () => {
      const result = await client.request('GET', '/reports/profitability');
      return result.ok ? ok(result.data) : err('getting profitability', result.data);
    },
  });

  // ===== 12. bill_list_expenses =====
  registerTool(server, {
    name: 'bill_list_expenses',
    description: 'List expenses, optionally filtered by project, category, or status.',
    input: {
      project_id: z.string().uuid().optional().describe('Filter by project UUID'),
      category: z.string().optional().describe('Filter by category'),
      status: z.string().optional().describe('Filter by status: pending, approved, rejected, reimbursed'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), description: z.string(), amount: z.number(), status: z.string() }).passthrough()) }),
    handler: async (params) => {
      const result = await client.request('GET', `/expenses${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing expenses', result.data);
    },
  });

  // ===== 13. bill_create_expense =====
  registerTool(server, {
    name: 'bill_create_expense',
    description: 'Log a new expense, optionally linked to a project.',
    input: {
      description: z.string().describe('Expense description'),
      amount: z.number().int().positive().describe('Amount in cents'),
      category: z.string().optional().describe('Category: software, travel, hardware, contractor, etc.'),
      vendor: z.string().optional().describe('Vendor name'),
      project_id: z.string().uuid().optional().describe('Link to a Bam project'),
      billable: z.boolean().optional().describe('Whether this can be invoiced to a client'),
    },
    returns: z.object({ id: z.string().uuid(), description: z.string(), amount: z.number(), status: z.string() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('POST', '/expenses', params);
      return result.ok ? ok(result.data) : err('creating expense', result.data);
    },
  });

  // ===== 14. bill_resolve_rate =====
  registerTool(server, {
    name: 'bill_resolve_rate',
    description: 'Resolve the effective billing rate for a given project + user + date.',
    input: {
      project_id: z.string().uuid().optional().describe('Project UUID'),
      user_id: z.string().uuid().optional().describe('User UUID'),
      date: z.string().optional().describe('Date to resolve for (YYYY-MM-DD, default today)'),
    },
    returns: z.object({ rate_cents_per_hour: z.number(), currency: z.string(), source: z.string().optional() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('GET', `/rates/resolve${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('resolving rate', result.data);
    },
  });

  // ===== 15. bill_list_clients =====
  registerTool(server, {
    name: 'bill_list_clients',
    description: 'List billing clients for the organization, with optional fuzzy search across name, email, and linked Bond company name. Returns id, name, email, company_id, company_name, currency (org default), and default_payment_terms_days — the resolver surface every "bill client X" rule needs.',
    input: {
      search: z.string().optional().describe('Optional fuzzy search across client name, email, and Bond company name'),
    },
    returns: z.object({
      data: z.array(z.object({
        id: z.string().uuid(),
        name: z.string(),
        email: z.string().nullable().optional(),
        company_id: z.string().uuid().nullable().optional(),
        company_name: z.string().nullable().optional(),
        currency: z.string().nullable().optional(),
        default_payment_terms_days: z.number().optional(),
      }).passthrough()),
    }),
    handler: async (params) => {
      const result = await client.request('GET', `/clients${buildQs(params)}`);
      if (!result.ok) return err('listing clients', result.data);

      const rows = (result.data as any)?.data ?? [];
      const clients = rows.map((c: any) => ({
        id: c.id,
        name: c.name,
        email: c.email ?? null,
        company_id: c.bond_company_id ?? null,
        company_name: c.company_name ?? null,
        currency: c.currency ?? null,
        default_payment_terms_days: c.default_payment_terms_days,
      }));
      return ok({ data: clients });
    },
  });

  const clientShape = z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().nullable().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  }).passthrough();

  // ===== 16. bill_get_client =====
  registerTool(server, {
    name: 'bill_get_client',
    description: 'Get a single billing client by UUID, including address and billing defaults.',
    input: {
      client_id: z.string().uuid().describe('Client UUID'),
    },
    returns: z.object({ data: clientShape }),
    handler: async (params) => {
      const result = await client.request('GET', `/clients/${params.client_id}`);
      return result.ok ? ok(result.data) : err('getting client', result.data);
    },
  });

  // ===== 17. bill_create_client =====
  registerTool(server, {
    name: 'bill_create_client',
    description: 'Create a new billing client for the organization.',
    input: {
      name: z.string().min(1).max(255).describe('Client name'),
      email: z.string().email().max(255).optional().describe('Billing email'),
      phone: z.string().max(50).optional().describe('Phone number'),
      address_line1: z.string().max(255).optional().describe('Address line 1'),
      address_line2: z.string().max(255).optional().describe('Address line 2'),
      city: z.string().max(100).optional().describe('City'),
      state_region: z.string().max(100).optional().describe('State or region'),
      postal_code: z.string().max(20).optional().describe('Postal/ZIP code'),
      country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code'),
      tax_id: z.string().max(50).optional().describe('Tax identification number'),
      bond_company_id: z.string().uuid().optional().describe('Linked Bond CRM company UUID'),
      default_payment_terms_days: z.number().int().min(0).max(365).optional().describe('Default payment terms in days'),
      default_payment_instructions: z.string().max(2000).optional().describe('Default payment instructions'),
      notes: z.string().max(5000).optional().describe('Internal notes'),
    },
    returns: z.object({ data: clientShape }),
    handler: async (params) => {
      const result = await client.request('POST', '/clients', params);
      return result.ok ? ok(result.data) : err('creating client', result.data);
    },
  });

  // ===== 18. bill_update_client =====
  registerTool(server, {
    name: 'bill_update_client',
    description: 'Update a billing client. Provide only the fields to change.',
    input: {
      client_id: z.string().uuid().describe('Client UUID'),
      name: z.string().min(1).max(255).optional().describe('Client name'),
      email: z.string().email().max(255).optional().describe('Billing email'),
      phone: z.string().max(50).optional().describe('Phone number'),
      address_line1: z.string().max(255).optional().describe('Address line 1'),
      address_line2: z.string().max(255).optional().describe('Address line 2'),
      city: z.string().max(100).optional().describe('City'),
      state_region: z.string().max(100).optional().describe('State or region'),
      postal_code: z.string().max(20).optional().describe('Postal/ZIP code'),
      country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code'),
      tax_id: z.string().max(50).optional().describe('Tax identification number'),
      bond_company_id: z.string().uuid().optional().describe('Linked Bond CRM company UUID'),
      default_payment_terms_days: z.number().int().min(0).max(365).optional().describe('Default payment terms in days'),
      default_payment_instructions: z.string().max(2000).optional().describe('Default payment instructions'),
      notes: z.string().max(5000).optional().describe('Internal notes'),
    },
    returns: z.object({ data: clientShape }),
    handler: async ({ client_id, ...body }) => {
      const result = await client.request('PATCH', `/clients/${client_id}`, body);
      return result.ok ? ok(result.data) : err('updating client', result.data);
    },
  });

  // ===== 19. bill_delete_client =====
  registerTool(server, {
    name: 'bill_delete_client',
    description: 'Delete a billing client by UUID.',
    input: {
      client_id: z.string().uuid().describe('Client UUID'),
    },
    returns: z.object({ data: z.object({ deleted: z.boolean() }) }),
    handler: async (params) => {
      const result = await client.request('DELETE', `/clients/${params.client_id}`);
      return result.ok ? ok(result.data) : err('deleting client', result.data);
    },
  });

  // ===== 20. bill_update_invoice =====
  registerTool(server, {
    name: 'bill_update_invoice',
    description: 'Update a draft invoice. Provide only the fields to change.',
    input: {
      invoice_id: z.string().uuid().describe('Invoice UUID'),
      client_id: z.string().uuid().optional().describe('Billing client UUID'),
      project_id: z.string().uuid().optional().describe('Linked Bam project UUID'),
      invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Invoice date (YYYY-MM-DD)'),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Due date (YYYY-MM-DD)'),
      tax_rate: z.number().min(0).max(100).optional().describe('Tax rate percentage'),
      discount_amount: z.number().int().min(0).optional().describe('Discount amount in cents'),
      payment_terms_days: z.number().int().min(0).max(365).optional().describe('Payment terms in days'),
      payment_instructions: z.string().max(2000).optional().describe('Payment instructions'),
      notes: z.string().max(5000).optional().describe('Internal notes'),
      footer_text: z.string().max(2000).optional().describe('Invoice footer text'),
      terms_text: z.string().max(5000).optional().describe('Invoice terms text'),
      bond_deal_id: z.string().uuid().optional().describe('Linked Bond CRM deal UUID'),
    },
    returns: z.object({ data: invoiceShape }),
    handler: async ({ invoice_id, ...body }) => {
      const result = await client.request('PATCH', `/invoices/${invoice_id}`, body);
      return result.ok ? ok(result.data) : err('updating invoice', result.data);
    },
  });

  // ===== 21. bill_delete_invoice =====
  registerTool(server, {
    name: 'bill_delete_invoice',
    description: 'Delete an invoice by UUID (draft invoices only).',
    input: {
      invoice_id: z.string().uuid().describe('Invoice UUID'),
    },
    returns: z.object({ data: z.object({ deleted: z.boolean() }) }),
    handler: async (params) => {
      const result = await client.request('DELETE', `/invoices/${params.invoice_id}`);
      return result.ok ? ok(result.data) : err('deleting invoice', result.data);
    },
  });

  // ===== 22. bill_duplicate_invoice =====
  registerTool(server, {
    name: 'bill_duplicate_invoice',
    description: 'Duplicate an existing invoice into a new draft, copying line items.',
    input: {
      invoice_id: z.string().uuid().describe('Source invoice UUID'),
    },
    returns: z.object({ data: invoiceShape }),
    handler: async (params) => {
      const result = await client.request('POST', `/invoices/${params.invoice_id}/duplicate`);
      return result.ok ? ok(result.data) : err('duplicating invoice', result.data);
    },
  });

  // ===== 23. bill_void_invoice =====
  registerTool(server, {
    name: 'bill_void_invoice',
    description: 'Void a finalized invoice — marks it void without deleting the record.',
    input: {
      invoice_id: z.string().uuid().describe('Invoice UUID'),
    },
    returns: z.object({ data: invoiceShape }),
    handler: async (params) => {
      const result = await client.request('POST', `/invoices/${params.invoice_id}/void`);
      return result.ok ? ok(result.data) : err('voiding invoice', result.data);
    },
  });

  // ===== 24. bill_get_invoice_jobs =====
  registerTool(server, {
    name: 'bill_get_invoice_jobs',
    description: 'Get the latest async PDF-generation and email-send job state for an invoice.',
    input: {
      invoice_id: z.string().uuid().describe('Invoice UUID'),
    },
    returns: z.object({
      data: z.object({
        pdf_generate: z.object({}).passthrough().nullable(),
        email_send: z.object({}).passthrough().nullable(),
      }),
    }),
    handler: async (params) => {
      const result = await client.request('GET', `/invoices/${params.invoice_id}/jobs`);
      return result.ok ? ok(result.data) : err('getting invoice jobs', result.data);
    },
  });

  // ===== 25. bill_update_line_item =====
  registerTool(server, {
    name: 'bill_update_line_item',
    description: 'Update a line item on a draft invoice. Provide only the fields to change.',
    input: {
      invoice_id: z.string().uuid().describe('Invoice UUID'),
      item_id: z.string().uuid().describe('Line item UUID'),
      description: z.string().min(1).max(1000).optional().describe('Line item description'),
      quantity: z.number().positive().optional().describe('Quantity'),
      unit: z.string().max(20).optional().describe('Unit type: hours, days, units, fixed'),
      unit_price: z.number().int().min(0).optional().describe('Unit price in cents'),
      sort_order: z.number().int().optional().describe('Display sort order'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), description: z.string() }).passthrough() }),
    handler: async ({ invoice_id, item_id, ...body }) => {
      const result = await client.request('PATCH', `/invoices/${invoice_id}/line-items/${item_id}`, body);
      return result.ok ? ok(result.data) : err('updating line item', result.data);
    },
  });

  // ===== 26. bill_delete_line_item =====
  registerTool(server, {
    name: 'bill_delete_line_item',
    description: 'Delete a line item from a draft invoice.',
    input: {
      invoice_id: z.string().uuid().describe('Invoice UUID'),
      item_id: z.string().uuid().describe('Line item UUID'),
    },
    returns: z.object({ data: z.object({ deleted: z.boolean() }) }),
    handler: async (params) => {
      const result = await client.request('DELETE', `/invoices/${params.invoice_id}/line-items/${params.item_id}`);
      return result.ok ? ok(result.data) : err('deleting line item', result.data);
    },
  });

  // ===== 27. bill_delete_payment =====
  registerTool(server, {
    name: 'bill_delete_payment',
    description: 'Delete a recorded payment by UUID, reverting the invoice balance.',
    input: {
      payment_id: z.string().uuid().describe('Payment UUID'),
    },
    returns: z.object({ data: z.object({ deleted: z.boolean() }) }),
    handler: async (params) => {
      const result = await client.request('DELETE', `/payments/${params.payment_id}`);
      return result.ok ? ok(result.data) : err('deleting payment', result.data);
    },
  });

  // ===== 28. bill_update_expense =====
  registerTool(server, {
    name: 'bill_update_expense',
    description: 'Update an expense. Provide only the fields to change.',
    input: {
      expense_id: z.string().uuid().describe('Expense UUID'),
      project_id: z.string().uuid().optional().describe('Linked Bam project UUID'),
      description: z.string().min(1).max(1000).optional().describe('Expense description'),
      amount: z.number().int().positive().optional().describe('Amount in cents'),
      currency: z.string().length(3).optional().describe('ISO 4217 currency code'),
      category: z.string().max(60).optional().describe('Category'),
      vendor: z.string().max(255).optional().describe('Vendor name'),
      expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Expense date (YYYY-MM-DD)'),
      billable: z.boolean().optional().describe('Whether this can be invoiced to a client'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), description: z.string(), status: z.string() }).passthrough() }),
    handler: async ({ expense_id, ...body }) => {
      const result = await client.request('PATCH', `/expenses/${expense_id}`, body);
      return result.ok ? ok(result.data) : err('updating expense', result.data);
    },
  });

  // ===== 29. bill_delete_expense =====
  registerTool(server, {
    name: 'bill_delete_expense',
    description: 'Delete an expense by UUID.',
    input: {
      expense_id: z.string().uuid().describe('Expense UUID'),
    },
    returns: z.object({ data: z.object({ deleted: z.boolean() }) }),
    handler: async (params) => {
      const result = await client.request('DELETE', `/expenses/${params.expense_id}`);
      return result.ok ? ok(result.data) : err('deleting expense', result.data);
    },
  });

  // ===== 30. bill_approve_expense =====
  registerTool(server, {
    name: 'bill_approve_expense',
    description: 'Approve a pending expense.',
    input: {
      expense_id: z.string().uuid().describe('Expense UUID'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), status: z.string() }).passthrough() }),
    handler: async (params) => {
      const result = await client.request('POST', `/expenses/${params.expense_id}/approve`);
      return result.ok ? ok(result.data) : err('approving expense', result.data);
    },
  });

  // ===== 31. bill_reject_expense =====
  registerTool(server, {
    name: 'bill_reject_expense',
    description: 'Reject a pending expense.',
    input: {
      expense_id: z.string().uuid().describe('Expense UUID'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), status: z.string() }).passthrough() }),
    handler: async (params) => {
      const result = await client.request('POST', `/expenses/${params.expense_id}/reject`);
      return result.ok ? ok(result.data) : err('rejecting expense', result.data);
    },
  });

  // ===== 32. bill_list_rates =====
  const rateShape = z.object({
    id: z.string().uuid(),
    rate_amount: z.number(),
    rate_type: z.string().optional(),
    currency: z.string().optional(),
    project_id: z.string().uuid().nullable().optional(),
    user_id: z.string().uuid().nullable().optional(),
  }).passthrough();

  registerTool(server, {
    name: 'bill_list_rates',
    description: 'List billing rates, optionally filtered by project or user.',
    input: {
      project_id: z.string().uuid().optional().describe('Filter by project UUID'),
      user_id: z.string().uuid().optional().describe('Filter by user UUID'),
    },
    returns: z.object({ data: z.array(rateShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/rates${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing rates', result.data);
    },
  });

  // ===== 33. bill_create_rate =====
  registerTool(server, {
    name: 'bill_create_rate',
    description: 'Create a billing rate, optionally scoped to a project and/or user with an effective date range.',
    input: {
      project_id: z.string().uuid().optional().describe('Scope to a project UUID (omit for org-wide)'),
      user_id: z.string().uuid().optional().describe('Scope to a user UUID (omit for all users)'),
      rate_amount: z.number().int().positive().describe('Rate amount in cents'),
      rate_type: z.enum(['hourly', 'daily', 'fixed']).optional().describe('Rate type (default hourly)'),
      currency: z.string().length(3).optional().describe('ISO 4217 currency code'),
      effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Effective from date (YYYY-MM-DD)'),
      effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Effective to date (YYYY-MM-DD)'),
    },
    returns: z.object({ data: rateShape }),
    handler: async (params) => {
      const result = await client.request('POST', '/rates', params);
      return result.ok ? ok(result.data) : err('creating rate', result.data);
    },
  });

  // ===== 34. bill_update_rate =====
  registerTool(server, {
    name: 'bill_update_rate',
    description: 'Update a billing rate. Provide only the fields to change.',
    input: {
      rate_id: z.string().uuid().describe('Rate UUID'),
      rate_amount: z.number().int().positive().optional().describe('Rate amount in cents'),
      rate_type: z.enum(['hourly', 'daily', 'fixed']).optional().describe('Rate type'),
      effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Effective from date (YYYY-MM-DD)'),
      effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Effective to date (YYYY-MM-DD)'),
    },
    returns: z.object({ data: rateShape }),
    handler: async ({ rate_id, ...body }) => {
      const result = await client.request('PATCH', `/rates/${rate_id}`, body);
      return result.ok ? ok(result.data) : err('updating rate', result.data);
    },
  });

  // ===== 35. bill_delete_rate =====
  registerTool(server, {
    name: 'bill_delete_rate',
    description: 'Delete a billing rate by UUID.',
    input: {
      rate_id: z.string().uuid().describe('Rate UUID'),
    },
    returns: z.object({ data: z.object({ deleted: z.boolean() }) }),
    handler: async (params) => {
      const result = await client.request('DELETE', `/rates/${params.rate_id}`);
      return result.ok ? ok(result.data) : err('deleting rate', result.data);
    },
  });

  // ===== 36. bill_get_outstanding =====
  registerTool(server, {
    name: 'bill_get_outstanding',
    description: 'Outstanding-balance report: invoices with an unpaid balance and the amount still owed.',
    input: {},
    returns: z.object({}).passthrough().describe('Outstanding-balance report data'),
    handler: async () => {
      const result = await client.request('GET', '/reports/outstanding');
      return result.ok ? ok(result.data) : err('getting outstanding', result.data);
    },
  });

  // ===== 37. bill_get_settings =====
  registerTool(server, {
    name: 'bill_get_settings',
    description: 'Get the organization billing settings (company info, default currency, tax rate, payment terms, invoice prefix).',
    input: {},
    returns: z.object({ data: z.object({}).passthrough() }),
    handler: async () => {
      const result = await client.request('GET', '/settings');
      return result.ok ? ok(result.data) : err('getting settings', result.data);
    },
  });

  // ===== 38. bill_update_settings =====
  registerTool(server, {
    name: 'bill_update_settings',
    description: 'Update the organization billing settings. Provide only the fields to change.',
    input: {
      company_name: z.string().max(255).optional().describe('Company name on invoices'),
      company_email: z.string().email().max(255).optional().describe('Company billing email'),
      company_phone: z.string().max(50).optional().describe('Company phone'),
      company_address: z.string().max(2000).optional().describe('Company address'),
      company_logo_url: z.string().url().optional().describe('Company logo URL'),
      company_tax_id: z.string().max(50).optional().describe('Company tax ID'),
      default_currency: z.string().length(3).optional().describe('Default ISO 4217 currency code'),
      default_tax_rate: z.number().min(0).max(100).optional().describe('Default tax rate percentage'),
      default_payment_terms_days: z.number().int().min(0).max(365).optional().describe('Default payment terms in days'),
      default_payment_instructions: z.string().max(2000).optional().describe('Default payment instructions'),
      default_footer_text: z.string().max(2000).optional().describe('Default invoice footer text'),
      default_terms_text: z.string().max(5000).optional().describe('Default invoice terms text'),
      invoice_prefix: z.string().min(1).max(20).optional().describe('Invoice number prefix'),
    },
    returns: z.object({ data: z.object({}).passthrough() }),
    handler: async (params) => {
      const result = await client.request('PUT', '/settings', params);
      return result.ok ? ok(result.data) : err('updating settings', result.data);
    },
  });

  // ===== Recurring / subscription billing =====

  const recurringShape = z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      status: z.string(),
      cadence: z.string(),
      client_id: z.string().uuid(),
      next_run_at: z.string(),
      created_at: z.string(),
    })
    .passthrough();

  const recurringLineItemSchema = z.object({
    description: z.string().min(1).max(1000).describe('Line item description'),
    quantity: z.number().positive().optional().describe('Quantity (default 1)'),
    unit: z.string().max(20).optional().describe('Unit type: hours, days, units, fixed'),
    unit_price: z.number().int().min(0).describe('Unit price in cents'),
  });

  // ===== 39. bill_list_recurring_invoices =====
  registerTool(server, {
    name: 'bill_list_recurring_invoices',
    description:
      'List recurring/subscription invoice schedules for the org, optionally filtered by status (active, paused, cancelled).',
    input: {
      status: z.enum(['active', 'paused', 'cancelled']).optional().describe('Filter by lifecycle status'),
    },
    returns: z.object({ data: z.array(recurringShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/recurring-invoices${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing recurring schedules', result.data);
    },
  });

  // ===== 40. bill_get_recurring_invoice =====
  registerTool(server, {
    name: 'bill_get_recurring_invoice',
    description: 'Get a recurring invoice schedule with its line-item template.',
    input: {
      recurring_id: z.string().uuid().describe('Recurring schedule UUID'),
    },
    returns: z.object({ data: recurringShape.extend({ line_items: z.array(z.object({}).passthrough()).optional() }) }),
    handler: async (params) => {
      const result = await client.request('GET', `/recurring-invoices/${params.recurring_id}`);
      return result.ok ? ok(result.data) : err('getting recurring schedule', result.data);
    },
  });

  // ===== 41. bill_create_recurring_invoice =====
  registerTool(server, {
    name: 'bill_create_recurring_invoice',
    description:
      'Create a recurring/subscription invoice schedule. The daily worker generates an invoice from the line-item template each cadence period and advances next_run_at. Set auto_finalize to issue real numbered invoices instead of drafts.',
    input: {
      client_id: z
        .string()
        .describe('Billing client — UUID, exact client name, or client email'),
      name: z.string().min(1).max(255).describe('Schedule name (e.g. "Acme monthly retainer")'),
      cadence: z
        .enum(['weekly', 'monthly', 'quarterly', 'annually'])
        .describe('How often to generate an invoice'),
      project_id: z.string().optional().describe('Link to a Bam project — UUID or exact project name'),
      auto_finalize: z
        .boolean()
        .optional()
        .describe('When true, generated invoices are finalized (numbered + sent); otherwise left as drafts (default false)'),
      currency: z.string().length(3).optional().describe('ISO 4217 currency code (defaults to org setting)'),
      tax_rate: z.number().min(0).max(100).optional().describe('Tax rate percentage'),
      discount_amount: z.number().int().min(0).optional().describe('Discount amount in cents'),
      payment_terms_days: z.number().int().min(0).max(365).optional().describe('Net payment terms in days'),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('First eligible run date (YYYY-MM-DD, default today)'),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Optional last date the series may run (YYYY-MM-DD)'),
      notes: z.string().max(5000).optional().describe('Internal notes copied onto each generated invoice'),
      line_items: z.array(recurringLineItemSchema).optional().describe('Line-item template copied onto each generated invoice'),
    },
    returns: z.object({ data: recurringShape }),
    handler: async (params) => {
      const clientId = await resolveBillClientId(client, params.client_id);
      if (!clientId) return notFound('Billing client', params.client_id);

      let projectId: string | undefined;
      if (params.project_id !== undefined) {
        const resolved = await resolveBamProjectId(api, params.project_id);
        if (!resolved) return notFound('Project', params.project_id);
        projectId = resolved;
      }

      const body = {
        ...params,
        client_id: clientId,
        ...(projectId !== undefined ? { project_id: projectId } : {}),
      };
      const result = await client.request('POST', '/recurring-invoices', body);
      return result.ok ? ok(result.data) : err('creating recurring schedule', result.data);
    },
  });

  // ===== 42. bill_update_recurring_invoice =====
  registerTool(server, {
    name: 'bill_update_recurring_invoice',
    description:
      'Update a recurring invoice schedule. Provide only the fields to change. Passing line_items replaces the whole template.',
    input: {
      recurring_id: z.string().uuid().describe('Recurring schedule UUID'),
      name: z.string().min(1).max(255).optional().describe('Schedule name'),
      cadence: z.enum(['weekly', 'monthly', 'quarterly', 'annually']).optional().describe('Generation cadence'),
      auto_finalize: z.boolean().optional().describe('Auto-finalize generated invoices'),
      currency: z.string().length(3).optional().describe('ISO 4217 currency code'),
      tax_rate: z.number().min(0).max(100).optional().describe('Tax rate percentage'),
      discount_amount: z.number().int().min(0).optional().describe('Discount amount in cents'),
      payment_terms_days: z.number().int().min(0).max(365).optional().describe('Net payment terms in days'),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('First eligible run date'),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Optional last run date'),
      next_run_at: z.string().optional().describe('Override the next scheduled generation time (ISO datetime)'),
      notes: z.string().max(5000).optional().describe('Internal notes'),
      line_items: z.array(recurringLineItemSchema).optional().describe('Replacement line-item template'),
    },
    returns: z.object({ data: recurringShape }),
    handler: async ({ recurring_id, ...body }) => {
      const result = await client.request('PATCH', `/recurring-invoices/${recurring_id}`, body);
      return result.ok ? ok(result.data) : err('updating recurring schedule', result.data);
    },
  });

  // ===== 43. bill_pause_recurring_invoice =====
  registerTool(server, {
    name: 'bill_pause_recurring_invoice',
    description: 'Pause a recurring schedule — stops invoice generation until resumed.',
    input: {
      recurring_id: z.string().uuid().describe('Recurring schedule UUID'),
    },
    returns: z.object({ data: recurringShape }),
    handler: async (params) => {
      const result = await client.request('POST', `/recurring-invoices/${params.recurring_id}/pause`);
      return result.ok ? ok(result.data) : err('pausing recurring schedule', result.data);
    },
  });

  // ===== 44. bill_resume_recurring_invoice =====
  registerTool(server, {
    name: 'bill_resume_recurring_invoice',
    description: 'Resume a paused recurring schedule — generation continues at next_run_at.',
    input: {
      recurring_id: z.string().uuid().describe('Recurring schedule UUID'),
    },
    returns: z.object({ data: recurringShape }),
    handler: async (params) => {
      const result = await client.request('POST', `/recurring-invoices/${params.recurring_id}/resume`);
      return result.ok ? ok(result.data) : err('resuming recurring schedule', result.data);
    },
  });

  // ===== 45. bill_cancel_recurring_invoice =====
  registerTool(server, {
    name: 'bill_cancel_recurring_invoice',
    description: 'Cancel a recurring schedule permanently. Already-generated invoices are unaffected.',
    input: {
      recurring_id: z.string().uuid().describe('Recurring schedule UUID'),
    },
    returns: z.object({ data: recurringShape }),
    handler: async (params) => {
      const result = await client.request('POST', `/recurring-invoices/${params.recurring_id}/cancel`);
      return result.ok ? ok(result.data) : err('cancelling recurring schedule', result.data);
    },
  });

  // ===== 46. bill_generate_recurring_invoice_now =====
  registerTool(server, {
    name: 'bill_generate_recurring_invoice_now',
    description:
      'Generate an invoice from a recurring schedule immediately, without waiting for the next scheduled run. Advances next_run_at by one cadence step. Returns the new invoice id, number, and status.',
    input: {
      recurring_id: z.string().uuid().describe('Recurring schedule UUID'),
    },
    returns: z.object({
      data: z.object({
        invoice_id: z.string().uuid(),
        invoice_number: z.string(),
        status: z.string(),
        next_run_at: z.string(),
      }),
    }),
    handler: async (params) => {
      const result = await client.request('POST', `/recurring-invoices/${params.recurring_id}/generate-now`);
      return result.ok ? ok(result.data) : err('generating invoice from schedule', result.data);
    },
  });
}
