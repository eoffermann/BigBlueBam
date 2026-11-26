import { eq, and, ilike, sql, desc, asc, or, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  bondCompanies,
  bondContactCompanies,
  bondContacts,
  bondDeals,
} from '../db/schema/index.js';
import { escapeLike, notFound } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompanyFilters {
  organization_id: string;
  industry?: string;
  size_bucket?: string;
  owner_id?: string;
  search?: string;
  include_deleted?: boolean;
  limit?: number;
  offset?: number;
  sort?: string;
}

export interface CreateCompanyInput {
  name: string;
  domain?: string;
  industry?: string;
  size_bucket?: string;
  annual_revenue?: number;
  phone?: string;
  website?: string;
  logo_url?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state_region?: string;
  postal_code?: string;
  country?: string;
  custom_fields?: Record<string, unknown>;
  owner_id?: string;
}

export interface UpdateCompanyInput extends Partial<CreateCompanyInput> {}

// ---------------------------------------------------------------------------
// List companies
// ---------------------------------------------------------------------------

export async function listCompanies(filters: CompanyFilters) {
  const conditions = [
    eq(bondCompanies.organization_id, filters.organization_id),
  ];
  if (!filters.include_deleted) {
    conditions.push(isNull(bondCompanies.deleted_at));
  }

  if (filters.industry) {
    conditions.push(eq(bondCompanies.industry, filters.industry));
  }
  if (filters.size_bucket) {
    conditions.push(eq(bondCompanies.size_bucket, filters.size_bucket));
  }
  if (filters.owner_id) {
    conditions.push(eq(bondCompanies.owner_id, filters.owner_id));
  }
  if (filters.search) {
    const pattern = `%${escapeLike(filters.search)}%`;
    conditions.push(
      or(
        ilike(bondCompanies.name, pattern),
        ilike(bondCompanies.domain, pattern),
      )!,
    );
  }

  const limit = Math.min(filters.limit ?? 50, 100);
  const offset = filters.offset ?? 0;

  let orderBy;
  switch (filters.sort) {
    case 'name':
      orderBy = [asc(bondCompanies.name)];
      break;
    case '-name':
      orderBy = [desc(bondCompanies.name)];
      break;
    case '-created_at':
      orderBy = [desc(bondCompanies.created_at)];
      break;
    default:
      orderBy = [desc(bondCompanies.created_at)];
  }

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(bondCompanies)
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(bondCompanies)
      .where(and(...conditions)),
  ]);

  return {
    data: rows,
    total: countResult[0]?.count ?? 0,
    limit,
    offset,
  };
}

// ---------------------------------------------------------------------------
// Get company by ID
// ---------------------------------------------------------------------------

export async function getCompany(id: string, orgId: string) {
  const [company] = await db
    .select()
    .from(bondCompanies)
    .where(
      and(
        eq(bondCompanies.id, id),
        eq(bondCompanies.organization_id, orgId),
        isNull(bondCompanies.deleted_at),
      ),
    )
    .limit(1);

  if (!company) throw notFound('Company not found');

  // Fetch contacts at this company
  const contacts = await db
    .select({
      contact_id: bondContactCompanies.contact_id,
      role_at_company: bondContactCompanies.role_at_company,
      is_primary: bondContactCompanies.is_primary,
      first_name: bondContacts.first_name,
      last_name: bondContacts.last_name,
      email: bondContacts.email,
    })
    .from(bondContactCompanies)
    .innerJoin(bondContacts, eq(bondContactCompanies.contact_id, bondContacts.id))
    .where(eq(bondContactCompanies.company_id, id));

  // Fetch deals with this company (exclude soft-deleted)
  const deals = await db
    .select({
      id: bondDeals.id,
      name: bondDeals.name,
      value: bondDeals.value,
      stage_id: bondDeals.stage_id,
      closed_at: bondDeals.closed_at,
    })
    .from(bondDeals)
    .where(and(eq(bondDeals.company_id, id), isNull(bondDeals.deleted_at)))
    .orderBy(desc(bondDeals.created_at));

  return { ...company, contacts, deals };
}

// ---------------------------------------------------------------------------
// Create company
// ---------------------------------------------------------------------------

export async function createCompany(
  input: CreateCompanyInput,
  orgId: string,
  userId: string,
) {
  const [company] = await db
    .insert(bondCompanies)
    .values({
      organization_id: orgId,
      name: input.name,
      domain: input.domain,
      industry: input.industry,
      size_bucket: input.size_bucket,
      annual_revenue: input.annual_revenue,
      phone: input.phone,
      website: input.website,
      logo_url: input.logo_url,
      address_line1: input.address_line1,
      address_line2: input.address_line2,
      city: input.city,
      state_region: input.state_region,
      postal_code: input.postal_code,
      country: input.country,
      custom_fields: input.custom_fields ?? {},
      owner_id: input.owner_id ?? userId,
      created_by: userId,
    })
    .returning();

  return company!;
}

// ---------------------------------------------------------------------------
// Update company
// ---------------------------------------------------------------------------

export async function updateCompany(
  id: string,
  orgId: string,
  input: UpdateCompanyInput,
) {
  const [updated] = await db
    .update(bondCompanies)
    .set({
      ...input,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(bondCompanies.id, id),
        eq(bondCompanies.organization_id, orgId),
        isNull(bondCompanies.deleted_at),
      ),
    )
    .returning();

  if (!updated) throw notFound('Company not found');
  return updated;
}

// ---------------------------------------------------------------------------
// Delete company
// ---------------------------------------------------------------------------

export async function deleteCompany(id: string, orgId: string) {
  // Soft-delete: see contact.service.deleteContact for rationale.
  const [deleted] = await db
    .update(bondCompanies)
    .set({ deleted_at: new Date(), updated_at: new Date() })
    .where(
      and(
        eq(bondCompanies.id, id),
        eq(bondCompanies.organization_id, orgId),
        isNull(bondCompanies.deleted_at),
      ),
    )
    .returning({ id: bondCompanies.id });

  if (!deleted) throw notFound('Company not found');
  return deleted;
}

// ---------------------------------------------------------------------------
// Restore (undelete) company — admin-only via the routes layer
// ---------------------------------------------------------------------------

export async function restoreCompany(id: string, orgId: string) {
  const [restored] = await db
    .update(bondCompanies)
    .set({ deleted_at: null, updated_at: new Date() })
    .where(and(eq(bondCompanies.id, id), eq(bondCompanies.organization_id, orgId)))
    .returning();

  if (!restored) throw notFound('Company not found');
  return restored;
}

// ---------------------------------------------------------------------------
// Search companies
// ---------------------------------------------------------------------------

export async function searchCompanies(
  orgId: string,
  query: string,
  limit = 20,
) {
  const pattern = `%${escapeLike(query)}%`;

  return db
    .select()
    .from(bondCompanies)
    .where(
      and(
        eq(bondCompanies.organization_id, orgId),
        isNull(bondCompanies.deleted_at),
        or(
          ilike(bondCompanies.name, pattern),
          ilike(bondCompanies.domain, pattern),
          ilike(bondCompanies.industry, pattern),
        ),
      ),
    )
    .orderBy(asc(bondCompanies.name))
    .limit(Math.min(limit, 100));
}

// ---------------------------------------------------------------------------
// Get contacts for a company
// ---------------------------------------------------------------------------

export async function getCompanyContacts(companyId: string, orgId: string) {
  // Verify company belongs to org and is not soft-deleted.
  const [company] = await db
    .select({ id: bondCompanies.id })
    .from(bondCompanies)
    .where(
      and(
        eq(bondCompanies.id, companyId),
        eq(bondCompanies.organization_id, orgId),
        isNull(bondCompanies.deleted_at),
      ),
    )
    .limit(1);

  if (!company) throw notFound('Company not found');

  return db
    .select({
      contact_id: bondContactCompanies.contact_id,
      role_at_company: bondContactCompanies.role_at_company,
      is_primary: bondContactCompanies.is_primary,
      first_name: bondContacts.first_name,
      last_name: bondContacts.last_name,
      email: bondContacts.email,
      phone: bondContacts.phone,
      title: bondContacts.title,
      lifecycle_stage: bondContacts.lifecycle_stage,
      lead_score: bondContacts.lead_score,
    })
    .from(bondContactCompanies)
    .innerJoin(bondContacts, eq(bondContactCompanies.contact_id, bondContacts.id))
    .where(
      and(
        eq(bondContactCompanies.company_id, companyId),
        isNull(bondContacts.deleted_at),
      ),
    )
    .orderBy(asc(bondContacts.last_name));
}

// ---------------------------------------------------------------------------
// Get deals for a company (paginated) — G3
// ---------------------------------------------------------------------------

export interface CompanyDealsOptions {
  limit?: number;
  offset?: number;
  sort?: string;
}

export async function getCompanyDeals(
  companyId: string,
  orgId: string,
  options: CompanyDealsOptions = {},
) {
  // Verify company belongs to org and is not soft-deleted.
  const [company] = await db
    .select({ id: bondCompanies.id })
    .from(bondCompanies)
    .where(
      and(
        eq(bondCompanies.id, companyId),
        eq(bondCompanies.organization_id, orgId),
        isNull(bondCompanies.deleted_at),
      ),
    )
    .limit(1);

  if (!company) throw notFound('Company not found');

  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  const conditions = [
    eq(bondDeals.company_id, companyId),
    eq(bondDeals.organization_id, orgId),
    isNull(bondDeals.deleted_at),
  ];

  let orderBy;
  switch (options.sort) {
    case 'expected_close_date':
      orderBy = [asc(bondDeals.expected_close_date)];
      break;
    case '-expected_close_date':
      orderBy = [desc(bondDeals.expected_close_date)];
      break;
    case 'value':
      orderBy = [asc(bondDeals.value)];
      break;
    case '-value':
      orderBy = [desc(bondDeals.value)];
      break;
    case 'name':
      orderBy = [asc(bondDeals.name)];
      break;
    case '-created_at':
      orderBy = [desc(bondDeals.created_at)];
      break;
    default:
      orderBy = [desc(bondDeals.created_at)];
  }

  const [rows, countResult, totalsResult] = await Promise.all([
    db
      .select()
      .from(bondDeals)
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(bondDeals)
      .where(and(...conditions)),
    db
      .select({
        total_value: sql<number>`COALESCE(sum(${bondDeals.value}), 0)::bigint`,
      })
      .from(bondDeals)
      .where(and(...conditions)),
  ]);

  return {
    deals: rows,
    total_count: countResult[0]?.count ?? 0,
    total_value: Number(totalsResult[0]?.total_value ?? 0),
    limit,
    offset,
  };
}
