import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { isUuid } from '../middleware/resolve-helpers.js';

/**
 * Helper to make requests to the bond-api service.
 * Same pattern as bolt-tools.ts — a lightweight fetch wrapper that targets
 * the bond-api base URL and forwards the user's auth token.
 */
function createBondClient(bondApiUrl: string, api: ApiClient) {
  const baseUrl = bondApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};

    // Forward the bearer token from the main API client
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

// ---------------------------------------------------------------------------
// Name-or-UUID resolvers for Bond write tools.
//
// Phase D / Tier 3 relaxes the schemas on all canonical action tools from
// `.uuid()` to `.string()` so rule authors and prompts can feed in natural
// identifiers (pipeline name, stage name, contact email, company name, deal
// title, owner email). Each resolver short-circuits when the input is already
// a UUID, then falls back to a lookup against the existing bond-api read
// endpoints. On ambiguous or missing matches we return `null`; callers turn
// that into a clean "not found / ambiguous" error so we never blindly mutate
// the wrong record.
//
// We intentionally use only endpoints that already exist in bond-api:
//   - GET /pipelines                   (listPipelines — returns {data:[{id,name,...}]})
//   - GET /pipelines/:id/stages        (listStages    — returns {data:[{id,name,...}]})
//   - GET /deals?search=&limit=2       (listDeals     — returns {data:[{id,name,pipeline_id,...}]})
//   - GET /contacts/search?q=&limit=2  (searchContacts)
//   - GET /companies?search=&limit=2   (listCompanies)
// Owner resolution hits the main Bam api `/users/by-email` / `/users/search`
// via the shared ApiClient, mirroring `find_user_by_email`.
// ---------------------------------------------------------------------------

type BondClient = ReturnType<typeof createBondClient>;

/**
 * Resolve a pipeline identifier that may be either a UUID or a pipeline name
 * (case-insensitive exact match). Returns the UUID or `null` if nothing
 * matches.
 */
async function resolvePipelineId(
  bond: BondClient,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await bond.request('GET', '/pipelines');
  if (!result.ok) return null;
  const pipelines =
    (result.data as { data?: Array<{ id: string; name: string }> }).data ?? [];
  const target = nameOrId.toLowerCase();
  const match = pipelines.find((p) => p.name.toLowerCase() === target);
  return match?.id ?? null;
}

/**
 * Resolve a stage identifier inside a specific pipeline. Stages are scoped to
 * their pipeline in the schema, so the caller MUST supply the resolved
 * pipeline UUID first. Case-insensitive exact match on stage name.
 */
async function resolveStageId(
  bond: BondClient,
  pipelineId: string,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await bond.request('GET', `/pipelines/${pipelineId}/stages`);
  if (!result.ok) return null;
  const stages =
    (result.data as { data?: Array<{ id: string; name: string }> }).data ?? [];
  const target = nameOrId.toLowerCase();
  const match = stages.find((s) => s.name.toLowerCase() === target);
  return match?.id ?? null;
}

/**
 * Resolve a deal identifier that may be either a UUID or a deal name (fuzzy
 * substring match via the list endpoint's `search` filter). We ask for two
 * results and only return a UUID when exactly one row comes back — anything
 * else is treated as ambiguous so the caller can surface a clear error
 * instead of mutating the wrong deal.
 *
 * The returned object also carries `pipeline_id` so `bond_move_deal_stage`
 * can use it to scope the subsequent stage resolution without a second round
 * trip.
 */
async function resolveDeal(
  bond: BondClient,
  nameOrId: string,
): Promise<{ id: string; pipeline_id?: string } | null> {
  if (isUuid(nameOrId)) return { id: nameOrId };
  const qs = buildQs({ search: nameOrId, limit: 2 });
  const result = await bond.request('GET', `/deals${qs}`);
  if (!result.ok) return null;
  const deals =
    (result.data as { data?: Array<{ id: string; pipeline_id?: string }> })
      .data ?? [];
  const onlyDeal = deals.length === 1 ? deals[0] : undefined;
  if (onlyDeal) {
    return { id: onlyDeal.id, pipeline_id: onlyDeal.pipeline_id };
  }
  return null;
}

async function resolveDealId(
  bond: BondClient,
  nameOrId: string,
): Promise<string | null> {
  const deal = await resolveDeal(bond, nameOrId);
  return deal?.id ?? null;
}

/**
 * Resolve a contact identifier that may be a UUID, an email, or a name
 * fragment. Uses the existing `/contacts/search?q=` endpoint (single search
 * spans name, email, and phone). Same single-match-only policy as deals.
 */
async function resolveContactId(
  bond: BondClient,
  nameOrIdOrEmail: string,
): Promise<string | null> {
  if (isUuid(nameOrIdOrEmail)) return nameOrIdOrEmail;
  const qs = buildQs({ q: nameOrIdOrEmail, limit: 2 });
  const result = await bond.request('GET', `/contacts/search${qs}`);
  if (!result.ok) return null;
  const contacts =
    (result.data as { data?: Array<{ id: string }> }).data ?? [];
  const only = contacts.length === 1 ? contacts[0] : undefined;
  return only?.id ?? null;
}

/**
 * Resolve a company identifier that may be a UUID or a company name (or
 * domain — the bond-api `search` filter matches both). Single-match-only.
 */
async function resolveCompanyId(
  bond: BondClient,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const qs = buildQs({ search: nameOrId, limit: 2 });
  const result = await bond.request('GET', `/companies${qs}`);
  if (!result.ok) return null;
  const companies =
    (result.data as { data?: Array<{ id: string }> }).data ?? [];
  const only = companies.length === 1 ? companies[0] : undefined;
  return only?.id ?? null;
}

/**
 * Resolve an owner identifier that may be a UUID, an email, or a name
 * fragment. Routes through the Bam api (`/users/by-email`, `/users/search`),
 * mirroring the `find_user_by_email` tool in user-resolver-tools.ts. Users
 * live in the shared `users` table, so a UUID resolved here is valid for any
 * `owner_id` column in bond-api.
 */
async function resolveOwnerId(
  api: ApiClient,
  idOrEmail: string,
): Promise<string | null> {
  if (isUuid(idOrEmail)) return idOrEmail;
  if (idOrEmail.includes('@')) {
    const result = await api.get(
      `/users/by-email?email=${encodeURIComponent(idOrEmail)}`,
    );
    if (!result.ok) return null;
    return (
      (result.data as { data?: { id?: string } | null }).data?.id ?? null
    );
  }
  const result = await api.get(
    `/users/search?q=${encodeURIComponent(idOrEmail)}&limit=1`,
  );
  if (!result.ok) return null;
  const users =
    (result.data as { data?: Array<{ id: string }> }).data ?? [];
  return users[0]?.id ?? null;
}

const contactShape = z.object({
  id: z.string().uuid(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  lifecycle_stage: z.string().optional(),
  lead_score: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const companyShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  domain: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const dealShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  value: z.number().nullable().optional(),
  currency: z.string().optional(),
  stage_id: z.string().uuid().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

export function registerBondTools(server: McpServer, api: ApiClient, bondApiUrl: string): void {
  const client = createBondClient(bondApiUrl, api);

  // ===== CONTACTS (5) =====

  registerTool(server, {
    name: 'bond_list_contacts',
    description: 'Search and filter CRM contacts with pagination. Supports lifecycle stage, owner, company, lead score range, and custom field filters.',
    input: {
      lifecycle_stage: z.enum(['subscriber', 'lead', 'marketing_qualified', 'sales_qualified', 'opportunity', 'customer', 'evangelist', 'other']).optional().describe('Filter by lifecycle stage'),
      owner_id: z.string().uuid().optional().describe('Filter by owner user ID'),
      company_id: z.string().uuid().optional().describe('Filter by associated company'),
      lead_source: z.string().max(60).optional().describe('Filter by lead source (e.g., "website", "referral", "express_interest")'),
      lead_score_min: z.number().int().optional().describe('Minimum lead score'),
      lead_score_max: z.number().int().optional().describe('Maximum lead score'),
      search: z.string().max(200).optional().describe('Full-text search across name, email, and custom fields'),
      sort: z.string().optional().describe('Sort field with optional - prefix for descending (e.g., "-lead_score", "last_name")'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Page size (default 50, max 100)'),
    },
    returns: z.object({ data: z.array(contactShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/contacts${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing contacts', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_get_contact',
    description: 'Get full contact detail including associated companies, deals, and recent activities.',
    input: {
      id: z.string().uuid().describe('Contact ID'),
    },
    returns: contactShape.extend({ companies: z.array(companyShape).optional(), deals: z.array(dealShape).optional() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/contacts/${id}`);
      return result.ok ? ok(result.data) : err('getting contact', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_create_contact',
    description: 'Create a new CRM contact with identity, classification, and optional company association. `owner_id` accepts a user UUID or email; `company_id` accepts a company UUID or name.',
    input: {
      first_name: z.string().max(100).optional().describe('First name'),
      last_name: z.string().max(100).optional().describe('Last name'),
      email: z.string().email().max(255).optional().describe('Email address'),
      phone: z.string().max(50).optional().describe('Phone number'),
      title: z.string().max(150).optional().describe('Job title'),
      lifecycle_stage: z.enum(['subscriber', 'lead', 'marketing_qualified', 'sales_qualified', 'opportunity', 'customer', 'evangelist', 'other']).optional().describe('Lifecycle stage (default "lead")'),
      lead_source: z.string().max(60).optional().describe('Lead source (e.g., "website", "referral", "express_interest")'),
      owner_id: z.string().optional().describe('Owner — accepts a user UUID or email address'),
      company_id: z.string().optional().describe('Primary company to associate — accepts a company UUID or name'),
      address_line1: z.string().max(255).optional().describe('Address line 1'),
      address_line2: z.string().max(255).optional().describe('Address line 2'),
      city: z.string().max(100).optional().describe('City'),
      state_region: z.string().max(100).optional().describe('State or region'),
      postal_code: z.string().max(20).optional().describe('Postal code'),
      country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code'),
      custom_fields: z.record(z.unknown()).optional().describe('Custom field values as key-value pairs'),
    },
    returns: contactShape,
    handler: async (params) => {
      const { owner_id, company_id, ...rest } = params;
      const body: Record<string, unknown> = { ...rest };

      if (owner_id !== undefined) {
        const resolved = await resolveOwnerId(api, owner_id);
        if (!resolved) {
          return err('creating contact', {
            error: `Could not resolve owner_id "${owner_id}" — pass a user UUID or an email that matches a user in this org.`,
          });
        }
        body.owner_id = resolved;
      }
      if (company_id !== undefined) {
        const resolved = await resolveCompanyId(client, company_id);
        if (!resolved) {
          return err('creating contact', {
            error: `Could not resolve company_id "${company_id}" — pass a company UUID, or a company name that matches exactly one record.`,
          });
        }
        body.company_id = resolved;
      }

      const result = await client.request('POST', '/contacts', body);
      return result.ok ? ok(result.data) : err('creating contact', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_update_contact',
    description: 'Update an existing contact. Provide only the fields to change. `id` accepts a contact UUID, an email, or a name fragment (single-match only). `owner_id` accepts a user UUID or email.',
    input: {
      id: z.string().describe('Contact — accepts a UUID, email address, or unique name fragment'),
      first_name: z.string().max(100).optional().describe('Updated first name'),
      last_name: z.string().max(100).optional().describe('Updated last name'),
      email: z.string().email().max(255).optional().describe('Updated email'),
      phone: z.string().max(50).optional().describe('Updated phone'),
      title: z.string().max(150).optional().describe('Updated job title'),
      lifecycle_stage: z.enum(['subscriber', 'lead', 'marketing_qualified', 'sales_qualified', 'opportunity', 'customer', 'evangelist', 'other']).optional().describe('Updated lifecycle stage'),
      lead_source: z.string().max(60).optional().describe('Updated lead source'),
      owner_id: z.string().optional().describe('Updated owner — accepts a user UUID or email address'),
      address_line1: z.string().max(255).optional().describe('Updated address line 1'),
      address_line2: z.string().max(255).optional().describe('Updated address line 2'),
      city: z.string().max(100).optional().describe('Updated city'),
      state_region: z.string().max(100).optional().describe('Updated state or region'),
      postal_code: z.string().max(20).optional().describe('Updated postal code'),
      country: z.string().length(2).optional().describe('Updated country code'),
      custom_fields: z.record(z.unknown()).optional().describe('Updated custom field values'),
    },
    returns: contactShape,
    handler: async ({ id, owner_id, ...rest }) => {
      const resolvedId = await resolveContactId(client, id);
      if (!resolvedId) {
        return err('updating contact', {
          error: `Could not resolve contact "${id}" — pass a contact UUID, an email, or a name that matches exactly one record.`,
        });
      }

      const body: Record<string, unknown> = { ...rest };
      if (owner_id !== undefined) {
        const resolvedOwner = await resolveOwnerId(api, owner_id);
        if (!resolvedOwner) {
          return err('updating contact', {
            error: `Could not resolve owner_id "${owner_id}" — pass a user UUID or an email that matches a user in this org.`,
          });
        }
        body.owner_id = resolvedOwner;
      }

      const result = await client.request('PATCH', `/contacts/${resolvedId}`, body);
      return result.ok ? ok(result.data) : err('updating contact', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_merge_contacts',
    description: 'Merge duplicate contacts. The target contact absorbs the source contact\'s deals, activities, and company associations. The source contact is soft-deleted.',
    input: {
      target_id: z.string().uuid().describe('Contact ID to keep (target)'),
      source_id: z.string().uuid().describe('Contact ID to merge into target (will be soft-deleted)'),
    },
    returns: contactShape,
    handler: async ({ target_id, source_id }) => {
      const result = await client.request('POST', `/contacts/${target_id}/merge`, { source_id });
      return result.ok ? ok(result.data) : err('merging contacts', result.data);
    },
  });

  // ===== §14 Wave 4 upserts =====

  registerTool(server, {
    name: 'bond_upsert_contact',
    description: 'Idempotent create-or-update of a CRM contact by email. Natural key is (organization_id, lower(email)). Soft-deleted matches are resurrected. Returns { data, created, idempotency_key } — `created` is true on insert, false on update.',
    input: {
      email: z.string().email().max(255).describe('Email address — idempotency key (case-insensitive)'),
      first_name: z.string().max(100).optional().describe('First name'),
      last_name: z.string().max(100).optional().describe('Last name'),
      phone: z.string().max(50).optional().describe('Phone number'),
      title: z.string().max(150).optional().describe('Job title'),
      avatar_url: z.string().url().optional().describe('Avatar URL'),
      lifecycle_stage: z.enum(['subscriber', 'lead', 'marketing_qualified', 'sales_qualified', 'opportunity', 'customer', 'evangelist', 'other']).optional().describe('Lifecycle stage'),
      lead_source: z.string().max(60).optional().describe('Lead source'),
      address_line1: z.string().max(255).optional(),
      address_line2: z.string().max(255).optional(),
      city: z.string().max(100).optional(),
      state_region: z.string().max(100).optional(),
      postal_code: z.string().max(20).optional(),
      country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code'),
      custom_fields: z.record(z.unknown()).optional(),
      owner_id: z.string().uuid().optional().describe('Owner user UUID (defaults to acting user on insert; unchanged on update)'),
    },
    returns: z.object({
      data: contactShape,
      created: z.boolean(),
      idempotency_key: z.string(),
    }),
    handler: async (params) => {
      const result = await client.request('POST', '/contacts/upsert', params);
      return result.ok ? ok(result.data) : err('upserting contact', result.data);
    },
  });

  // ===== COMPANIES (4) =====

  registerTool(server, {
    name: 'bond_list_companies',
    description: 'Search and filter CRM companies with pagination.',
    input: {
      search: z.string().max(200).optional().describe('Search by company name or domain'),
      industry: z.string().max(100).optional().describe('Filter by industry'),
      size_bucket: z.enum(['1-10', '11-50', '51-200', '201-1000', '1001-5000', '5000+']).optional().describe('Filter by company size'),
      owner_id: z.string().uuid().optional().describe('Filter by owner user ID'),
      sort: z.string().optional().describe('Sort field with optional - prefix (e.g., "-annual_revenue", "name")'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Page size (default 50, max 100)'),
    },
    returns: z.object({ data: z.array(companyShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/companies${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing companies', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_get_company',
    description: 'Get full company detail including associated contacts, deals, and recent activities.',
    input: {
      id: z.string().uuid().describe('Company ID'),
    },
    returns: companyShape.extend({ contacts: z.array(contactShape).optional(), deals: z.array(dealShape).optional() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/companies/${id}`);
      return result.ok ? ok(result.data) : err('getting company', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_create_company',
    description: 'Create a new CRM company.',
    input: {
      name: z.string().max(255).describe('Company name'),
      domain: z.string().max(255).optional().describe('Company domain (e.g., "acme.com")'),
      industry: z.string().max(100).optional().describe('Industry'),
      size_bucket: z.enum(['1-10', '11-50', '51-200', '201-1000', '1001-5000', '5000+']).optional().describe('Company size bucket'),
      annual_revenue: z.number().int().optional().describe('Annual revenue in cents (USD)'),
      phone: z.string().max(50).optional().describe('Phone number'),
      website: z.string().url().optional().describe('Website URL'),
      address_line1: z.string().max(255).optional().describe('Address line 1'),
      address_line2: z.string().max(255).optional().describe('Address line 2'),
      city: z.string().max(100).optional().describe('City'),
      state_region: z.string().max(100).optional().describe('State or region'),
      postal_code: z.string().max(20).optional().describe('Postal code'),
      country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code'),
      owner_id: z.string().uuid().optional().describe('Owner user ID'),
      custom_fields: z.record(z.unknown()).optional().describe('Custom field values as key-value pairs'),
    },
    returns: companyShape,
    handler: async (params) => {
      const result = await client.request('POST', '/companies', params);
      return result.ok ? ok(result.data) : err('creating company', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_update_company',
    description: 'Update an existing company. Provide only the fields to change.',
    input: {
      id: z.string().uuid().describe('Company ID'),
      name: z.string().max(255).optional().describe('Updated name'),
      domain: z.string().max(255).optional().describe('Updated domain'),
      industry: z.string().max(100).optional().describe('Updated industry'),
      size_bucket: z.enum(['1-10', '11-50', '51-200', '201-1000', '1001-5000', '5000+']).optional().describe('Updated size bucket'),
      annual_revenue: z.number().int().optional().describe('Updated annual revenue in cents'),
      phone: z.string().max(50).optional().describe('Updated phone'),
      website: z.string().url().optional().describe('Updated website'),
      address_line1: z.string().max(255).optional().describe('Updated address line 1'),
      address_line2: z.string().max(255).optional().describe('Updated address line 2'),
      city: z.string().max(100).optional().describe('Updated city'),
      state_region: z.string().max(100).optional().describe('Updated state or region'),
      postal_code: z.string().max(20).optional().describe('Updated postal code'),
      country: z.string().length(2).optional().describe('Updated country code'),
      owner_id: z.string().uuid().optional().describe('Updated owner user ID'),
      custom_fields: z.record(z.unknown()).optional().describe('Updated custom field values'),
    },
    returns: companyShape,
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/companies/${id}`, body);
      return result.ok ? ok(result.data) : err('updating company', result.data);
    },
  });

  // ===== DEALS (7) =====

  registerTool(server, {
    name: 'bond_list_deals',
    description: 'Search and filter CRM deals with pagination. Supports pipeline, stage, owner, value range, and stale flag filters.',
    input: {
      pipeline_id: z.string().uuid().optional().describe('Filter by pipeline'),
      stage_id: z.string().uuid().optional().describe('Filter by pipeline stage'),
      owner_id: z.string().uuid().optional().describe('Filter by deal owner'),
      company_id: z.string().uuid().optional().describe('Filter by associated company'),
      contact_id: z.string().uuid().optional().describe('Filter by associated contact'),
      value_min: z.number().int().optional().describe('Minimum deal value in cents'),
      value_max: z.number().int().optional().describe('Maximum deal value in cents'),
      expected_close_before: z.string().optional().describe('Expected close date before (ISO date)'),
      expected_close_after: z.string().optional().describe('Expected close date after (ISO date)'),
      is_open: z.boolean().optional().describe('Filter open deals only (closed_at IS NULL)'),
      sort: z.string().optional().describe('Sort field (e.g., "-value", "expected_close_date", "-created_at")'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Page size (default 50, max 100)'),
    },
    returns: z.object({ data: z.array(dealShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/deals${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing deals', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_get_deal',
    description: 'Get full deal detail including associated contacts, activities, and stage change history.',
    input: {
      id: z.string().uuid().describe('Deal ID'),
    },
    returns: dealShape.extend({ contacts: z.array(contactShape).optional() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/deals/${id}`);
      return result.ok ? ok(result.data) : err('getting deal', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_create_deal',
    description: 'Create a new deal in a pipeline. `pipeline_id` accepts a pipeline UUID or exact name; `stage_id` accepts a stage UUID or exact name (within the resolved pipeline); `owner_id` accepts a user UUID or email; `company_id` accepts a company UUID or name; `contact_ids` entries each accept a contact UUID or email.',
    input: {
      name: z.string().max(255).describe('Deal name'),
      pipeline_id: z.string().describe('Pipeline — accepts a UUID or exact pipeline name'),
      stage_id: z.string().optional().describe('Initial stage — accepts a UUID or exact stage name (scoped to the resolved pipeline). Defaults to the first stage in the pipeline.'),
      value: z.number().int().optional().describe('Deal value in cents'),
      currency: z.string().length(3).optional().describe('Currency code (default "USD")'),
      expected_close_date: z.string().optional().describe('Expected close date (ISO date)'),
      probability_pct: z.number().int().min(0).max(100).optional().describe('Win probability override (0-100)'),
      description: z.string().max(5000).optional().describe('Deal description'),
      owner_id: z.string().optional().describe('Deal owner — accepts a user UUID or email'),
      company_id: z.string().optional().describe('Primary company — accepts a company UUID or name'),
      contact_ids: z.array(z.string()).optional().describe('Contacts to associate — each entry accepts a UUID or email'),
      custom_fields: z.record(z.unknown()).optional().describe('Custom field values'),
    },
    returns: dealShape,
    handler: async (params) => {
      const {
        pipeline_id,
        stage_id,
        owner_id,
        company_id,
        contact_ids,
        ...rest
      } = params;

      // 1. Pipeline must resolve first — stage resolution depends on it.
      const resolvedPipelineId = await resolvePipelineId(client, pipeline_id);
      if (!resolvedPipelineId) {
        return err('creating deal', {
          error: `Could not resolve pipeline_id "${pipeline_id}" — pass a pipeline UUID or an exact pipeline name.`,
        });
      }

      // 2. Resolve stage (scoped to pipeline), owner, company, contacts in parallel.
      const [
        resolvedStageId,
        resolvedOwnerId,
        resolvedCompanyId,
        resolvedContactIds,
      ] = await Promise.all([
        stage_id !== undefined
          ? resolveStageId(client, resolvedPipelineId, stage_id)
          : Promise.resolve(undefined),
        owner_id !== undefined
          ? resolveOwnerId(api, owner_id)
          : Promise.resolve(undefined),
        company_id !== undefined
          ? resolveCompanyId(client, company_id)
          : Promise.resolve(undefined),
        contact_ids !== undefined
          ? Promise.all(contact_ids.map((c) => resolveContactId(client, c)))
          : Promise.resolve(undefined),
      ]);

      if (stage_id !== undefined && !resolvedStageId) {
        return err('creating deal', {
          error: `Could not resolve stage_id "${stage_id}" inside pipeline "${pipeline_id}" — pass a stage UUID or an exact stage name.`,
        });
      }
      if (owner_id !== undefined && !resolvedOwnerId) {
        return err('creating deal', {
          error: `Could not resolve owner_id "${owner_id}" — pass a user UUID or an email that matches a user in this org.`,
        });
      }
      if (company_id !== undefined && !resolvedCompanyId) {
        return err('creating deal', {
          error: `Could not resolve company_id "${company_id}" — pass a company UUID, or a company name that matches exactly one record.`,
        });
      }
      if (contact_ids !== undefined && resolvedContactIds) {
        const failedIdx = resolvedContactIds.findIndex((r) => r === null);
        if (failedIdx !== -1) {
          return err('creating deal', {
            error: `Could not resolve contact_ids[${failedIdx}] "${contact_ids[failedIdx]}" — pass a contact UUID, email, or unique name fragment.`,
          });
        }
      }

      const body: Record<string, unknown> = {
        ...rest,
        pipeline_id: resolvedPipelineId,
      };
      if (resolvedStageId !== undefined) body.stage_id = resolvedStageId;
      if (resolvedOwnerId !== undefined) body.owner_id = resolvedOwnerId;
      if (resolvedCompanyId !== undefined) body.company_id = resolvedCompanyId;
      if (resolvedContactIds !== undefined) {
        body.contact_ids = resolvedContactIds as string[];
      }

      const result = await client.request('POST', '/deals', body);
      return result.ok ? ok(result.data) : err('creating deal', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_update_deal',
    description: 'Update an existing deal. Provide only the fields to change. `id` accepts a deal UUID or a unique title fragment (single-match only). `owner_id` accepts a user UUID or email; `company_id` accepts a company UUID or name.',
    input: {
      id: z.string().describe('Deal — accepts a UUID or unique deal title fragment'),
      name: z.string().max(255).optional().describe('Updated name'),
      value: z.number().int().optional().describe('Updated value in cents'),
      currency: z.string().length(3).optional().describe('Updated currency'),
      expected_close_date: z.string().optional().describe('Updated expected close date'),
      probability_pct: z.number().int().min(0).max(100).optional().describe('Updated win probability'),
      description: z.string().max(5000).optional().describe('Updated description'),
      owner_id: z.string().optional().describe('Updated owner — accepts a user UUID or email'),
      company_id: z.string().optional().describe('Updated primary company — accepts a company UUID or name'),
      custom_fields: z.record(z.unknown()).optional().describe('Updated custom field values'),
    },
    returns: dealShape,
    handler: async ({ id, owner_id, company_id, ...rest }) => {
      const resolvedId = await resolveDealId(client, id);
      if (!resolvedId) {
        return err('updating deal', {
          error: `Could not resolve deal "${id}" — pass a deal UUID or a title fragment that matches exactly one deal.`,
        });
      }

      const body: Record<string, unknown> = { ...rest };
      if (owner_id !== undefined) {
        const resolvedOwner = await resolveOwnerId(api, owner_id);
        if (!resolvedOwner) {
          return err('updating deal', {
            error: `Could not resolve owner_id "${owner_id}" — pass a user UUID or an email that matches a user in this org.`,
          });
        }
        body.owner_id = resolvedOwner;
      }
      if (company_id !== undefined) {
        const resolvedCompany = await resolveCompanyId(client, company_id);
        if (!resolvedCompany) {
          return err('updating deal', {
            error: `Could not resolve company_id "${company_id}" — pass a company UUID or a unique company name.`,
          });
        }
        body.company_id = resolvedCompany;
      }

      const result = await client.request('PATCH', `/deals/${resolvedId}`, body);
      return result.ok ? ok(result.data) : err('updating deal', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_move_deal_stage',
    description: 'Move a deal to a new pipeline stage. Records stage history and emits a deal.stage_changed event for Bolt automations. `id` accepts a deal UUID or a unique title fragment; `stage_id` accepts a stage UUID or exact stage name (stage name is resolved within the deal\'s pipeline).',
    input: {
      id: z.string().describe('Deal — accepts a UUID or unique deal title fragment'),
      stage_id: z.string().describe('Target stage — accepts a UUID or exact stage name (resolved within the deal\'s pipeline)'),
    },
    returns: dealShape,
    handler: async ({ id, stage_id }) => {
      // 1. Resolve the deal first — we need its pipeline_id to scope the stage lookup.
      const resolvedDeal = await resolveDeal(client, id);
      if (!resolvedDeal) {
        return err('moving deal stage', {
          error: `Could not resolve deal "${id}" — pass a deal UUID or a title fragment that matches exactly one deal.`,
        });
      }

      // 2. Determine pipeline_id. resolveDeal only carries it when we searched
      //    by name; when the caller passed a UUID we have to fetch the deal.
      let pipelineId = resolvedDeal.pipeline_id;
      if (!pipelineId) {
        const dealResult = await client.request(
          'GET',
          `/deals/${resolvedDeal.id}`,
        );
        if (!dealResult.ok) {
          return err('moving deal stage', dealResult.data);
        }
        pipelineId = (dealResult.data as { data?: { pipeline_id?: string } })
          .data?.pipeline_id;
        if (!pipelineId) {
          return err('moving deal stage', {
            error: `Deal "${id}" has no pipeline_id — cannot resolve target stage.`,
          });
        }
      }

      // 3. Resolve stage within that pipeline.
      const resolvedStageId = await resolveStageId(client, pipelineId, stage_id);
      if (!resolvedStageId) {
        return err('moving deal stage', {
          error: `Could not resolve stage_id "${stage_id}" inside the deal's pipeline — pass a stage UUID or an exact stage name.`,
        });
      }

      const result = await client.request(
        'PATCH',
        `/deals/${resolvedDeal.id}/stage`,
        { stage_id: resolvedStageId },
      );
      return result.ok ? ok(result.data) : err('moving deal stage', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_close_deal_won',
    description: 'Mark a deal as won. Sets closed_at, moves to the won stage, and emits a deal.won event for Bolt automations. `id` accepts a deal UUID or a unique title fragment.',
    input: {
      id: z.string().describe('Deal — accepts a UUID or unique deal title fragment'),
      close_reason: z.string().max(2000).optional().describe('Reason for winning the deal'),
    },
    returns: dealShape,
    handler: async ({ id, ...body }) => {
      const resolvedId = await resolveDealId(client, id);
      if (!resolvedId) {
        return err('closing deal as won', {
          error: `Could not resolve deal "${id}" — pass a deal UUID or a title fragment that matches exactly one deal.`,
        });
      }
      const result = await client.request('POST', `/deals/${resolvedId}/won`, body);
      return result.ok ? ok(result.data) : err('closing deal as won', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_close_deal_lost',
    description: 'Mark a deal as lost. Sets closed_at, close_reason, and optionally the competitor who won. Emits a deal.lost event for Bolt automations. `id` accepts a deal UUID or a unique title fragment.',
    input: {
      id: z.string().describe('Deal — accepts a UUID or unique deal title fragment'),
      close_reason: z.string().max(2000).optional().describe('Reason for losing the deal'),
      lost_to_competitor: z.string().max(255).optional().describe('Competitor who won the deal'),
    },
    returns: dealShape,
    handler: async ({ id, ...body }) => {
      const resolvedId = await resolveDealId(client, id);
      if (!resolvedId) {
        return err('closing deal as lost', {
          error: `Could not resolve deal "${id}" — pass a deal UUID or a title fragment that matches exactly one deal.`,
        });
      }
      const result = await client.request('POST', `/deals/${resolvedId}/lost`, body);
      return result.ok ? ok(result.data) : err('closing deal as lost', result.data);
    },
  });

  // ===== ACTIVITIES (1) =====

  registerTool(server, {
    name: 'bond_log_activity',
    description: 'Log an activity (note, call, email, meeting, task, etc.) against a contact, deal, or both. `contact_id` accepts a UUID or email; `deal_id` accepts a UUID or unique deal title fragment; `company_id` accepts a UUID or company name.',
    input: {
      activity_type: z.enum([
        'note', 'email_sent', 'email_received', 'call', 'meeting',
        'task', 'form_submission', 'custom',
      ]).describe('Type of activity'),
      contact_id: z.string().optional().describe('Contact — accepts a UUID, email, or unique name fragment'),
      deal_id: z.string().optional().describe('Deal — accepts a UUID or unique deal title fragment'),
      company_id: z.string().optional().describe('Company — accepts a UUID or unique company name'),
      subject: z.string().max(255).optional().describe('Activity subject/title'),
      body: z.string().max(10000).optional().describe('Activity body/notes'),
      performed_at: z.string().optional().describe('When the activity occurred (ISO datetime, defaults to now)'),
      metadata: z.record(z.unknown()).optional().describe('Additional activity-type-specific data'),
    },
    returns: z.object({ id: z.string().uuid(), activity_type: z.string(), created_at: z.string() }).passthrough(),
    handler: async (params) => {
      const { contact_id, deal_id, company_id, ...rest } = params;

      const [
        resolvedContactId,
        resolvedDealId,
        resolvedCompanyId,
      ] = await Promise.all([
        contact_id !== undefined
          ? resolveContactId(client, contact_id)
          : Promise.resolve(undefined),
        deal_id !== undefined
          ? resolveDealId(client, deal_id)
          : Promise.resolve(undefined),
        company_id !== undefined
          ? resolveCompanyId(client, company_id)
          : Promise.resolve(undefined),
      ]);

      if (contact_id !== undefined && !resolvedContactId) {
        return err('logging activity', {
          error: `Could not resolve contact_id "${contact_id}" — pass a contact UUID, email, or unique name fragment.`,
        });
      }
      if (deal_id !== undefined && !resolvedDealId) {
        return err('logging activity', {
          error: `Could not resolve deal_id "${deal_id}" — pass a deal UUID or a title fragment that matches exactly one deal.`,
        });
      }
      if (company_id !== undefined && !resolvedCompanyId) {
        return err('logging activity', {
          error: `Could not resolve company_id "${company_id}" — pass a company UUID or a unique company name.`,
        });
      }

      const body: Record<string, unknown> = { ...rest };
      if (resolvedContactId !== undefined) body.contact_id = resolvedContactId;
      if (resolvedDealId !== undefined) body.deal_id = resolvedDealId;
      if (resolvedCompanyId !== undefined) body.company_id = resolvedCompanyId;

      const result = await client.request('POST', '/activities', body);
      return result.ok ? ok(result.data) : err('logging activity', result.data);
    },
  });

  // ===== ANALYTICS (2) =====

  registerTool(server, {
    name: 'bond_get_pipeline_summary',
    description: 'Get pipeline summary with deal count, total value, and weighted value per stage.',
    input: {
      pipeline_id: z.string().uuid().optional().describe('Pipeline ID (defaults to the org default pipeline)'),
    },
    returns: z.object({ pipeline_id: z.string().uuid().optional(), stages: z.array(z.object({ stage_id: z.string().uuid(), name: z.string(), deal_count: z.number(), total_value: z.number(), weighted_value: z.number() }).passthrough()) }).passthrough(),
    handler: async (params) => {
      const result = await client.request('GET', `/analytics/pipeline-summary${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting pipeline summary', result.data);
    },
  });

  registerTool(server, {
    name: 'bond_get_stale_deals',
    description: 'List deals that have exceeded the rotting threshold for their current pipeline stage. Useful for stale deal follow-up automations.',
    input: {
      pipeline_id: z.string().uuid().optional().describe('Filter by pipeline'),
      owner_id: z.string().uuid().optional().describe('Filter by deal owner'),
      limit: z.number().int().positive().max(100).optional().describe('Max results (default 50, max 100)'),
    },
    returns: z.object({ data: z.array(dealShape.extend({ days_in_stage: z.number().optional() })) }),
    handler: async (params) => {
      const result = await client.request('GET', `/analytics/stale-deals${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting stale deals', result.data);
    },
  });

  // ===== LEAD SCORING (1) =====

  registerTool(server, {
    name: 'bond_score_lead',
    description: 'Trigger lead score recalculation for a specific contact. Evaluates all enabled scoring rules and updates the cached lead_score on the contact.',
    input: {
      contact_id: z.string().uuid().describe('Contact ID to score'),
    },
    returns: z.object({ contact_id: z.string().uuid(), lead_score: z.number(), evaluated_rules: z.number().optional() }).passthrough(),
    handler: async ({ contact_id }) => {
      const result = await client.request('POST', '/scoring/recalculate', { contact_id });
      return result.ok ? ok(result.data) : err('scoring lead', result.data);
    },
  });

  // ===== FORECAST (1) =====

  registerTool(server, {
    name: 'bond_get_forecast',
    description: 'Get revenue forecast from weighted pipeline value, broken into 30/60/90 day buckets based on expected close dates.',
    input: {
      pipeline_id: z.string().uuid().optional().describe('Pipeline ID (defaults to the org default pipeline)'),
    },
    returns: z.object({ pipeline_id: z.string().uuid().optional(), next_30_days: z.number(), next_60_days: z.number(), next_90_days: z.number(), currency: z.string().optional() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('GET', `/analytics/forecast${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting forecast', result.data);
    },
  });

  // ===== SEARCH (1) =====

  registerTool(server, {
    name: 'bond_search_contacts',
    description: 'Full-text search across contact name, email, and phone. Returns contacts ranked by lead score.',
    input: {
      query: z.string().min(1).max(200).describe('Search query string'),
      limit: z.number().int().positive().max(100).optional().describe('Max results (default 20, max 100)'),
    },
    returns: z.object({ data: z.array(contactShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/contacts/search${buildQs({ q: params.query, limit: params.limit })}`);
      return result.ok ? ok(result.data) : err('searching contacts', result.data);
    },
  });
}
