import { eq, and, or, ilike, sql, desc, asc, inArray, gte, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  bondContacts,
  bondContactCompanies,
  bondCompanies,
  bondDealContacts,
  bondDeals,
  bondActivities,
} from '../db/schema/index.js';
import { escapeLike, notFound, badRequest } from '../lib/utils.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import {
  loadActor,
  loadOrg,
  contactDisplayName,
  contactUrl,
} from '../lib/bolt-enrichment.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContactFilters {
  organization_id: string;
  lifecycle_stage?: string;
  lead_source?: string;
  owner_id?: string;
  company_id?: string;
  lead_score_min?: number;
  lead_score_max?: number;
  search?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  /** When set, only return contacts owned by this user (for member/viewer "own only" visibility). */
  visibility_owner_id?: string;
}

export interface CreateContactInput {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  title?: string;
  avatar_url?: string;
  lifecycle_stage?: string;
  lead_source?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state_region?: string;
  postal_code?: string;
  country?: string;
  custom_fields?: Record<string, unknown>;
  owner_id?: string;
}

export interface UpdateContactInput extends Partial<CreateContactInput> {}

// ---------------------------------------------------------------------------
// List contacts
// ---------------------------------------------------------------------------

export async function listContacts(filters: ContactFilters) {
  const conditions = [eq(bondContacts.organization_id, filters.organization_id)];

  if (filters.lifecycle_stage) {
    conditions.push(eq(bondContacts.lifecycle_stage, filters.lifecycle_stage));
  }
  if (filters.lead_source) {
    conditions.push(eq(bondContacts.lead_source, filters.lead_source));
  }
  if (filters.owner_id) {
    conditions.push(eq(bondContacts.owner_id, filters.owner_id));
  }
  if (filters.lead_score_min !== undefined) {
    conditions.push(gte(bondContacts.lead_score, filters.lead_score_min));
  }
  if (filters.lead_score_max !== undefined) {
    conditions.push(lte(bondContacts.lead_score, filters.lead_score_max));
  }
  if (filters.search) {
    const pattern = `%${escapeLike(filters.search)}%`;
    conditions.push(
      or(
        ilike(bondContacts.first_name, pattern),
        ilike(bondContacts.last_name, pattern),
        ilike(bondContacts.email, pattern),
      )!,
    );
  }
  if (filters.visibility_owner_id) {
    conditions.push(eq(bondContacts.owner_id, filters.visibility_owner_id));
  }
  if (filters.company_id) {
    // Subquery: contacts linked to company
    const contactIds = db
      .select({ contact_id: bondContactCompanies.contact_id })
      .from(bondContactCompanies)
      .where(eq(bondContactCompanies.company_id, filters.company_id));

    conditions.push(inArray(bondContacts.id, contactIds));
  }

  const limit = Math.min(filters.limit ?? 50, 100);
  const offset = filters.offset ?? 0;

  // Determine sort
  let orderBy;
  switch (filters.sort) {
    case 'name':
      orderBy = [asc(bondContacts.last_name), asc(bondContacts.first_name)];
      break;
    case '-name':
      orderBy = [desc(bondContacts.last_name), desc(bondContacts.first_name)];
      break;
    case 'lead_score':
      orderBy = [asc(bondContacts.lead_score)];
      break;
    case '-lead_score':
      orderBy = [desc(bondContacts.lead_score)];
      break;
    case '-created_at':
      orderBy = [desc(bondContacts.created_at)];
      break;
    default:
      orderBy = [desc(bondContacts.created_at)];
  }

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(bondContacts)
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(bondContacts)
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
// Get contact by ID
// ---------------------------------------------------------------------------

export async function getContact(id: string, orgId: string) {
  const [contact] = await db
    .select()
    .from(bondContacts)
    .where(and(eq(bondContacts.id, id), eq(bondContacts.organization_id, orgId)))
    .limit(1);

  if (!contact) throw notFound('Contact not found');

  // Fetch associated companies
  const companies = await db
    .select({
      company_id: bondContactCompanies.company_id,
      role_at_company: bondContactCompanies.role_at_company,
      is_primary: bondContactCompanies.is_primary,
      name: bondCompanies.name,
      domain: bondCompanies.domain,
    })
    .from(bondContactCompanies)
    .innerJoin(bondCompanies, eq(bondContactCompanies.company_id, bondCompanies.id))
    .where(eq(bondContactCompanies.contact_id, id));

  // Fetch associated deals
  const deals = await db
    .select({
      deal_id: bondDealContacts.deal_id,
      role: bondDealContacts.role,
      name: bondDeals.name,
      value: bondDeals.value,
      stage_id: bondDeals.stage_id,
    })
    .from(bondDealContacts)
    .innerJoin(bondDeals, eq(bondDealContacts.deal_id, bondDeals.id))
    .where(eq(bondDealContacts.contact_id, id));

  // Fetch recent activities
  const activities = await db
    .select()
    .from(bondActivities)
    .where(eq(bondActivities.contact_id, id))
    .orderBy(desc(bondActivities.performed_at))
    .limit(20);

  return { ...contact, companies, deals, recent_activities: activities };
}

// ---------------------------------------------------------------------------
// Create contact
// ---------------------------------------------------------------------------

export async function createContact(
  input: CreateContactInput,
  orgId: string,
  userId: string,
) {
  const [contact] = await db
    .insert(bondContacts)
    .values({
      organization_id: orgId,
      first_name: input.first_name,
      last_name: input.last_name,
      email: input.email,
      phone: input.phone,
      title: input.title,
      avatar_url: input.avatar_url,
      lifecycle_stage: input.lifecycle_stage ?? 'lead',
      lead_source: input.lead_source,
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

  // Emit Bolt event (fire-and-forget) — enriched payload (Phase B / Tier 1)
  void (async () => {
    const c = contact!;
    const actor = await loadActor(userId);
    const org = await loadOrg(orgId);
    const owner = await loadActor(c.owner_id);
    await publishBoltEvent(
      'contact.created',
      'bond',
      {
        contact: {
          id: c.id,
          name: contactDisplayName(c),
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email,
          phone: c.phone,
          title: c.title,
          lifecycle_stage: c.lifecycle_stage,
          lead_source: c.lead_source,
          lead_score: c.lead_score,
          owner_id: c.owner_id,
          owner_name: owner?.name ?? null,
          owner_email: owner?.email ?? null,
          url: contactUrl(c.id),
          // company_id/company_name are NOT populated at creation time —
          // the company association is a separate relation (bondContactCompanies)
          // and createContact does not take a company_id. Rule authors should
          // rely on contact.company_assigned follow-up events once those exist.
          company_id: null,
          company_name: null,
        },
        owner: owner
          ? {
              id: owner.id,
              name: owner.name,
              email: owner.email,
              avatar_url: owner.avatar_url,
            }
          : null,
        actor: actor
          ? {
              id: actor.id,
              name: actor.name,
              email: actor.email,
              avatar_url: actor.avatar_url,
            }
          : { id: userId },
        org: org ? { id: org.id, name: org.name, slug: org.slug } : { id: orgId },
      },
      orgId,
      userId,
      'user',
    );
  })();

  return contact!;
}

// ---------------------------------------------------------------------------
// Update contact
// ---------------------------------------------------------------------------

export async function updateContact(
  id: string,
  orgId: string,
  input: UpdateContactInput,
) {
  const [updated] = await db
    .update(bondContacts)
    .set({
      ...input,
      updated_at: new Date(),
    })
    .where(and(eq(bondContacts.id, id), eq(bondContacts.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Contact not found');
  return updated;
}

// ---------------------------------------------------------------------------
// Delete contact
// ---------------------------------------------------------------------------

export async function deleteContact(id: string, orgId: string) {
  const [deleted] = await db
    .delete(bondContacts)
    .where(and(eq(bondContacts.id, id), eq(bondContacts.organization_id, orgId)))
    .returning({ id: bondContacts.id });

  if (!deleted) throw notFound('Contact not found');
  return deleted;
}

// ---------------------------------------------------------------------------
// Merge contacts — target absorbs source
// ---------------------------------------------------------------------------

export async function mergeContacts(
  targetId: string,
  sourceId: string,
  orgId: string,
) {
  if (targetId === sourceId) throw badRequest('Cannot merge a contact with itself');

  // Verify both contacts exist in this org
  const [target, source] = await Promise.all([
    db
      .select()
      .from(bondContacts)
      .where(and(eq(bondContacts.id, targetId), eq(bondContacts.organization_id, orgId)))
      .limit(1)
      .then((r) => r[0]),
    db
      .select()
      .from(bondContacts)
      .where(and(eq(bondContacts.id, sourceId), eq(bondContacts.organization_id, orgId)))
      .limit(1)
      .then((r) => r[0]),
  ]);

  if (!target) throw notFound('Target contact not found');
  if (!source) throw notFound('Source contact not found');

  // Move deal associations from source to target (skip duplicates)
  const sourceDealLinks = await db
    .select()
    .from(bondDealContacts)
    .where(eq(bondDealContacts.contact_id, sourceId));

  for (const link of sourceDealLinks) {
    await db
      .insert(bondDealContacts)
      .values({
        deal_id: link.deal_id,
        contact_id: targetId,
        role: link.role,
      })
      .onConflictDoNothing();
  }

  // Move company associations from source to target (skip duplicates)
  const sourceCompanyLinks = await db
    .select()
    .from(bondContactCompanies)
    .where(eq(bondContactCompanies.contact_id, sourceId));

  for (const link of sourceCompanyLinks) {
    await db
      .insert(bondContactCompanies)
      .values({
        contact_id: targetId,
        company_id: link.company_id,
        role_at_company: link.role_at_company,
        is_primary: false,
      })
      .onConflictDoNothing();
  }

  // Re-point activities from source to target
  await db
    .update(bondActivities)
    .set({ contact_id: targetId })
    .where(eq(bondActivities.contact_id, sourceId));

  // Merge fields: fill in blanks on target from source
  const mergeUpdates: Record<string, unknown> = {};
  if (!target.email && source.email) mergeUpdates.email = source.email;
  if (!target.phone && source.phone) mergeUpdates.phone = source.phone;
  if (!target.first_name && source.first_name) mergeUpdates.first_name = source.first_name;
  if (!target.last_name && source.last_name) mergeUpdates.last_name = source.last_name;
  if (!target.title && source.title) mergeUpdates.title = source.title;

  // Merge custom fields (source fills blanks in target)
  const targetCustom = (target.custom_fields ?? {}) as Record<string, unknown>;
  const sourceCustom = (source.custom_fields ?? {}) as Record<string, unknown>;
  const mergedCustom = { ...sourceCustom, ...targetCustom };
  mergeUpdates.custom_fields = mergedCustom;
  mergeUpdates.updated_at = new Date();

  if (Object.keys(mergeUpdates).length > 0) {
    await db
      .update(bondContacts)
      .set(mergeUpdates)
      .where(eq(bondContacts.id, targetId));
  }

  // Delete source contact
  await db.delete(bondContacts).where(eq(bondContacts.id, sourceId));

  // Return updated target
  return getContact(targetId, orgId);
}

// ---------------------------------------------------------------------------
// Search contacts (full-text)
// ---------------------------------------------------------------------------

export async function searchContacts(
  orgId: string,
  query: string,
  limit: number = 20,
) {
  const pattern = `%${escapeLike(query)}%`;

  const results = await db
    .select()
    .from(bondContacts)
    .where(
      and(
        eq(bondContacts.organization_id, orgId),
        or(
          ilike(bondContacts.first_name, pattern),
          ilike(bondContacts.last_name, pattern),
          ilike(bondContacts.email, pattern),
          ilike(bondContacts.phone, pattern),
        ),
      ),
    )
    .orderBy(desc(bondContacts.lead_score))
    .limit(Math.min(limit, 100));

  return results;
}

// ---------------------------------------------------------------------------
// Import contacts (bulk CSV rows)
// ---------------------------------------------------------------------------

export async function importContacts(
  rows: CreateContactInput[],
  orgId: string,
  userId: string,
) {
  const results = { created: 0, skipped: 0, errors: [] as string[] };

  for (const row of rows) {
    try {
      // Dedup by email within org
      if (row.email) {
        const [existing] = await db
          .select({ id: bondContacts.id })
          .from(bondContacts)
          .where(
            and(
              eq(bondContacts.organization_id, orgId),
              eq(bondContacts.email, row.email),
            ),
          )
          .limit(1);

        if (existing) {
          results.skipped++;
          continue;
        }
      }

      await createContact(row, orgId, userId);
      results.created++;
    } catch (err) {
      results.errors.push(`Failed to import ${row.email ?? 'unknown'}: ${(err as Error).message}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Export contacts
// ---------------------------------------------------------------------------

export async function exportContacts(orgId: string, filters?: ContactFilters) {
  const effectiveFilters = filters ?? { organization_id: orgId, limit: 10000, offset: 0 };
  effectiveFilters.organization_id = orgId;
  effectiveFilters.limit = 10000;
  effectiveFilters.offset = 0;

  const result = await listContacts(effectiveFilters);
  return result.data;
}
