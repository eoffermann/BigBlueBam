import { eq, and, or, ilike, desc, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blastSegments, bondContacts } from '../db/schema/index.js';
import { escapeLike, notFound } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SegmentFilters {
  organization_id: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface CreateSegmentInput {
  name: string;
  description?: string;
  filter_criteria: {
    conditions: Array<{ field: string; op: string; value?: unknown }>;
    match: 'all' | 'any';
  };
}

export interface UpdateSegmentInput extends Partial<CreateSegmentInput> {}

// ---------------------------------------------------------------------------
// List segments
// ---------------------------------------------------------------------------

export async function listSegments(filters: SegmentFilters) {
  const conditions = [eq(blastSegments.organization_id, filters.organization_id)];

  if (filters.search) {
    const pattern = `%${escapeLike(filters.search)}%`;
    conditions.push(ilike(blastSegments.name, pattern));
  }

  const limit = Math.min(filters.limit ?? 50, 100);
  const offset = filters.offset ?? 0;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(blastSegments)
      .where(and(...conditions))
      .orderBy(desc(blastSegments.updated_at))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(blastSegments)
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
// Get segment
// ---------------------------------------------------------------------------

export async function getSegment(id: string, orgId: string) {
  const [segment] = await db
    .select()
    .from(blastSegments)
    .where(and(eq(blastSegments.id, id), eq(blastSegments.organization_id, orgId)))
    .limit(1);

  if (!segment) throw notFound('Segment not found');
  return segment;
}

// ---------------------------------------------------------------------------
// Create segment
// ---------------------------------------------------------------------------

export async function createSegment(
  input: CreateSegmentInput,
  orgId: string,
  userId: string,
) {
  const [segment] = await db
    .insert(blastSegments)
    .values({
      organization_id: orgId,
      name: input.name,
      description: input.description,
      filter_criteria: input.filter_criteria,
      created_by: userId,
    })
    .returning();

  if (!segment) {
    throw new Error('Segment insert returned no row');
  }
  return segment;
}

// ---------------------------------------------------------------------------
// Update segment
// ---------------------------------------------------------------------------

export async function updateSegment(
  id: string,
  orgId: string,
  input: UpdateSegmentInput,
) {
  const [updated] = await db
    .update(blastSegments)
    .set({
      ...input,
      updated_at: new Date(),
    })
    .where(and(eq(blastSegments.id, id), eq(blastSegments.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Segment not found');
  return updated;
}

// ---------------------------------------------------------------------------
// Delete segment
// ---------------------------------------------------------------------------

export async function deleteSegment(id: string, orgId: string) {
  const [deleted] = await db
    .delete(blastSegments)
    .where(and(eq(blastSegments.id, id), eq(blastSegments.organization_id, orgId)))
    .returning({ id: blastSegments.id });

  if (!deleted) throw notFound('Segment not found');
  return deleted;
}

// ---------------------------------------------------------------------------
// Supported filter fields mapped to bond_contacts columns
// ---------------------------------------------------------------------------

const CONTACT_COLUMN_MAP: Record<string, typeof bondContacts[keyof typeof bondContacts] | undefined> = {
  lifecycle_stage: bondContacts.lifecycle_stage,
  lead_source: bondContacts.lead_source,
  lead_score: bondContacts.lead_score,
  city: bondContacts.city,
  country: bondContacts.country,
  last_contacted_at: bondContacts.last_contacted_at,
  email: bondContacts.email,
  first_name: bondContacts.first_name,
  last_name: bondContacts.last_name,
};

/**
 * Translate a single filter condition into a Drizzle SQL fragment.
 * Returns undefined if the field or operator is not recognized.
 */
function buildConditionSql(condition: {
  field: string;
  op: string;
  value: unknown;
}): SQL | undefined {
  const col = CONTACT_COLUMN_MAP[condition.field];
  if (!col) return undefined;

  switch (condition.op) {
    case 'equals':
      return sql`${col} = ${condition.value as string}`;

    case 'not_equals':
      return sql`${col} != ${condition.value as string}`;

    case 'in': {
      const values = condition.value as string[];
      if (!values || values.length === 0) return undefined;
      return sql`${col} = ANY(${values}::text[])`;
    }

    case 'contains': {
      const pattern = `%${escapeLike(String(condition.value))}%`;
      return sql`${col} ILIKE ${pattern}`;
    }

    case 'greater_than':
      return sql`${col} > ${condition.value as string | number}`;

    case 'less_than':
      return sql`${col} < ${condition.value as string | number}`;

    case 'older_than_days': {
      const days = Number(condition.value);
      if (Number.isNaN(days)) return undefined;
      return sql`${col} < NOW() - INTERVAL '1 day' * ${days}`;
    }

    case 'is_set':
      return sql`${col} IS NOT NULL`;

    case 'is_not_set':
      return sql`${col} IS NULL`;

    default:
      return undefined;
  }
}

/**
 * Build all SQL conditions from filter_criteria and combine with AND or OR.
 * Always includes the org-scoping condition.
 */
function buildFilterWhere(
  orgId: string,
  criteria: {
    conditions: Array<{ field: string; op: string; value: unknown }>;
    match: string;
  },
): SQL {
  const orgCondition = eq(bondContacts.organization_id, orgId);

  const filterConditions: SQL[] = [];
  for (const condition of criteria.conditions ?? []) {
    const fragment = buildConditionSql(condition);
    if (fragment) filterConditions.push(fragment);
  }

  if (filterConditions.length === 0) {
    return orgCondition;
  }

  // drizzle's and()/or() are typed `SQL | undefined` because a zero-arg
  // call yields undefined — filterConditions is non-empty here (guarded
  // above), so fall back to the org pin alone rather than assert.
  const combined =
    criteria.match === 'any'
      ? or(...filterConditions)
      : and(...filterConditions);
  if (!combined) {
    return orgCondition;
  }

  return and(orgCondition, combined) ?? orgCondition;
}

// ---------------------------------------------------------------------------
// Recalculate segment count (queries Bond contacts)
// ---------------------------------------------------------------------------

export async function recalculateSegmentCount(id: string, orgId: string) {
  const segment = await getSegment(id, orgId);

  const criteria = segment.filter_criteria as {
    conditions: Array<{ field: string; op: string; value: unknown }>;
    match: string;
  };

  const whereClause = buildFilterWhere(orgId, criteria);

  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bondContacts)
    .where(whereClause);

  const count = result?.count ?? 0;

  // Update cached count
  await db
    .update(blastSegments)
    .set({
      cached_count: count,
      cached_at: new Date(),
    })
    .where(eq(blastSegments.id, id));

  return { count, cached_at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Evaluate segment for campaign recipients (full list with emails)
// ---------------------------------------------------------------------------

/**
 * Evaluate a segment's filter_criteria against the contacts table and
 * return the full recipient list. Excludes contacts without an email
 * and contacts who have unsubscribed.
 */
export async function evaluateSegmentRecipients(
  segmentId: string,
  orgId: string,
): Promise<{
  recipients: Array<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
  }>;
  total: number;
}> {
  const segment = await getSegment(segmentId, orgId);

  const criteria = segment.filter_criteria as {
    conditions: Array<{ field: string; op: string; value: unknown }>;
    match: string;
  };

  const whereClause = buildFilterWhere(orgId, criteria);

  // Fetch all matching contacts with a valid email, excluding unsubscribed
  const contacts = await db
    .select({
      id: bondContacts.id,
      first_name: bondContacts.first_name,
      last_name: bondContacts.last_name,
      email: bondContacts.email,
    })
    .from(bondContacts)
    .where(whereClause);

  // Filter out contacts with no email (post-query for safety)
  const withEmail = contacts.filter(
    (c): c is typeof c & { email: string } => !!c.email,
  );

  // Exclude unsubscribed contacts
  const { blastUnsubscribes } = await import('../db/schema/index.js');
  const unsubRows = await db
    .select({ email: blastUnsubscribes.email })
    .from(blastUnsubscribes)
    .where(eq(blastUnsubscribes.organization_id, orgId));

  const unsubSet = new Set(unsubRows.map((r) => r.email.toLowerCase()));

  const recipients = withEmail.filter(
    (c) => !unsubSet.has(c.email.toLowerCase()),
  );

  // Update cached count on the segment
  await db
    .update(blastSegments)
    .set({
      cached_count: recipients.length,
      cached_at: new Date(),
    })
    .where(eq(blastSegments.id, segmentId));

  return { recipients, total: recipients.length };
}

// ---------------------------------------------------------------------------
// Preview segment contacts
// ---------------------------------------------------------------------------

export async function previewSegmentContacts(id: string, orgId: string) {
  const segment = await getSegment(id, orgId);

  const criteria = segment.filter_criteria as {
    conditions: Array<{ field: string; op: string; value: unknown }>;
    match: string;
  };

  const whereClause = buildFilterWhere(orgId, criteria);

  const contacts = await db
    .select({
      id: bondContacts.id,
      first_name: bondContacts.first_name,
      last_name: bondContacts.last_name,
      email: bondContacts.email,
      lifecycle_stage: bondContacts.lifecycle_stage,
    })
    .from(bondContacts)
    .where(whereClause)
    .limit(50);

  return { segment_id: segment.id, contacts, count: contacts.length };
}
