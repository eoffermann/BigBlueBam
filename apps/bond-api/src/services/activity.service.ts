import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bondActivities, bondDeals, bondContacts, bondCompanies } from '../db/schema/index.js';
import { notFound } from '../lib/utils.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import {
  loadActor,
  loadOrg,
  loadContactById,
  loadCompanyById,
  loadDealEnrichment,
  contactDisplayName,
  contactUrl,
  companyUrl,
  dealUrl,
} from '../lib/bolt-enrichment.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivityFilters {
  organization_id: string;
  contact_id?: string;
  deal_id?: string;
  company_id?: string;
  activity_type?: string;
  limit?: number;
  offset?: number;
}

export interface CreateActivityInput {
  contact_id?: string;
  deal_id?: string;
  company_id?: string;
  activity_type: string;
  subject?: string;
  body?: string;
  metadata?: Record<string, unknown>;
  performed_at?: string;
}

export interface UpdateActivityInput {
  subject?: string;
  body?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// List activities
// ---------------------------------------------------------------------------

export async function listActivities(filters: ActivityFilters) {
  const conditions = [eq(bondActivities.organization_id, filters.organization_id)];

  if (filters.contact_id) {
    conditions.push(eq(bondActivities.contact_id, filters.contact_id));
  }
  if (filters.deal_id) {
    conditions.push(eq(bondActivities.deal_id, filters.deal_id));
  }
  if (filters.company_id) {
    conditions.push(eq(bondActivities.company_id, filters.company_id));
  }
  if (filters.activity_type) {
    conditions.push(eq(bondActivities.activity_type, filters.activity_type));
  }

  const limit = Math.min(filters.limit ?? 50, 100);
  const offset = filters.offset ?? 0;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(bondActivities)
      .where(and(...conditions))
      .orderBy(desc(bondActivities.performed_at))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(bondActivities)
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
// Create activity
// ---------------------------------------------------------------------------

export async function createActivity(
  input: CreateActivityInput,
  orgId: string,
  userId: string,
) {
  // Validate at least one entity is referenced
  if (!input.contact_id && !input.deal_id && !input.company_id) {
    throw notFound('Activity must reference at least one contact, deal, or company');
  }

  // Validate entity ownership within org
  if (input.contact_id) {
    const [c] = await db
      .select({ id: bondContacts.id })
      .from(bondContacts)
      .where(and(eq(bondContacts.id, input.contact_id), eq(bondContacts.organization_id, orgId)))
      .limit(1);
    if (!c) throw notFound('Contact not found');
  }

  if (input.deal_id) {
    const [d] = await db
      .select({ id: bondDeals.id })
      .from(bondDeals)
      .where(and(eq(bondDeals.id, input.deal_id), eq(bondDeals.organization_id, orgId)))
      .limit(1);
    if (!d) throw notFound('Deal not found');
  }

  if (input.company_id) {
    const [co] = await db
      .select({ id: bondCompanies.id })
      .from(bondCompanies)
      .where(and(eq(bondCompanies.id, input.company_id), eq(bondCompanies.organization_id, orgId)))
      .limit(1);
    if (!co) throw notFound('Company not found');
  }

  const [activity] = await db
    .insert(bondActivities)
    .values({
      organization_id: orgId,
      contact_id: input.contact_id,
      deal_id: input.deal_id,
      company_id: input.company_id,
      activity_type: input.activity_type,
      subject: input.subject,
      body: input.body,
      metadata: input.metadata ?? {},
      performed_by: userId,
      performed_at: input.performed_at ? new Date(input.performed_at) : new Date(),
    })
    .returning();

  // Update last_contacted_at on contact
  if (input.contact_id) {
    await db
      .update(bondContacts)
      .set({ last_contacted_at: new Date() })
      .where(eq(bondContacts.id, input.contact_id));
  }

  // Update last_activity_at on deal
  if (input.deal_id) {
    await db
      .update(bondDeals)
      .set({ last_activity_at: new Date() })
      .where(eq(bondDeals.id, input.deal_id));
  }

  // Emit Bolt event (fire-and-forget) — enriched payload (Phase B / Tier 1)
  void (async () => {
    const a = activity!;
    const actor = await loadActor(userId);
    const org = await loadOrg(orgId);
    const contact = input.contact_id ? await loadContactById(input.contact_id) : null;
    const dealEnrichment = input.deal_id ? await loadDealEnrichment(input.deal_id) : null;
    const company = input.company_id ? await loadCompanyById(input.company_id) : null;
    await publishBoltEvent(
      'activity.logged',
      'bond',
      {
        activity: {
          id: a.id,
          type: a.activity_type,
          subject: a.subject,
          body: a.body,
          performed_at: a.performed_at,
          contact_id: a.contact_id,
          contact_name: contactDisplayName(contact),
          contact_email: contact?.email ?? null,
          deal_id: a.deal_id,
          deal_title: dealEnrichment?.deal.name ?? null,
          deal_amount: dealEnrichment?.deal.value ?? null,
          deal_currency: dealEnrichment?.deal.currency ?? null,
          company_id: a.company_id,
          company_name: company?.name ?? null,
        },
        contact: contact
          ? {
              id: contact.id,
              name: contactDisplayName(contact),
              email: contact.email,
              url: contactUrl(contact.id),
            }
          : null,
        deal: dealEnrichment
          ? {
              id: dealEnrichment.deal.id,
              title: dealEnrichment.deal.name,
              amount: dealEnrichment.deal.value,
              currency: dealEnrichment.deal.currency,
              stage_id: dealEnrichment.deal.stage_id,
              stage_name: dealEnrichment.stage?.name ?? null,
              pipeline_id: dealEnrichment.deal.pipeline_id,
              pipeline_name: dealEnrichment.pipeline?.name ?? null,
              owner_id: dealEnrichment.deal.owner_id,
              url: dealUrl(dealEnrichment.deal.id),
            }
          : null,
        company: company
          ? { id: company.id, name: company.name, url: companyUrl(company.id) }
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

  return activity!;
}

// ---------------------------------------------------------------------------
// Get activity
// ---------------------------------------------------------------------------

export async function getActivity(id: string, orgId: string) {
  const [activity] = await db
    .select()
    .from(bondActivities)
    .where(and(eq(bondActivities.id, id), eq(bondActivities.organization_id, orgId)))
    .limit(1);

  if (!activity) throw notFound('Activity not found');
  return activity;
}

// ---------------------------------------------------------------------------
// Update activity
// ---------------------------------------------------------------------------

export async function updateActivity(
  id: string,
  orgId: string,
  input: UpdateActivityInput,
) {
  const [updated] = await db
    .update(bondActivities)
    .set(input)
    .where(and(eq(bondActivities.id, id), eq(bondActivities.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Activity not found');
  return updated;
}

// ---------------------------------------------------------------------------
// Delete activity
// ---------------------------------------------------------------------------

export async function deleteActivity(id: string, orgId: string) {
  const [deleted] = await db
    .delete(bondActivities)
    .where(and(eq(bondActivities.id, id), eq(bondActivities.organization_id, orgId)))
    .returning({ id: bondActivities.id });

  if (!deleted) throw notFound('Activity not found');
  return deleted;
}
