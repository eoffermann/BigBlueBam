import { eq, and, gt, asc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bearingPeriods } from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class BearingError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'BearingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListPeriodFilters {
  orgId: string;
  status?: string;
  year?: number;
  cursor?: string;
  limit?: number;
}

export interface CreatePeriodInput {
  name: string;
  period_type: string;
  starts_at: string;
  ends_at: string;
  status?: string;
}

export interface UpdatePeriodInput {
  name?: string;
  period_type?: string;
  starts_at?: string;
  ends_at?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listPeriods(filters: ListPeriodFilters) {
  const conditions = [eq(bearingPeriods.organization_id, filters.orgId)];

  if (filters.status) {
    conditions.push(eq(bearingPeriods.status, filters.status));
  }

  if (filters.year) {
    conditions.push(
      sql`EXTRACT(YEAR FROM ${bearingPeriods.starts_at}::date) = ${filters.year}` as any,
    );
  }

  const limit = Math.min(filters.limit ?? 50, 100);

  if (filters.cursor) {
    conditions.push(gt(bearingPeriods.created_at, new Date(filters.cursor)));
  }

  const rows = await db
    .select()
    .from(bearingPeriods)
    .where(and(...conditions))
    .orderBy(asc(bearingPeriods.created_at))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && data.length > 0 ? data[data.length - 1]!.created_at.toISOString() : null;

  return {
    data,
    meta: {
      next_cursor: nextCursor,
      has_more: hasMore,
    },
  };
}

export async function getPeriod(id: string, orgId: string) {
  const [period] = await db
    .select()
    .from(bearingPeriods)
    .where(and(eq(bearingPeriods.id, id), eq(bearingPeriods.organization_id, orgId)))
    .limit(1);

  if (!period) return null;

  // Get summary stats
  const stats: any[] = await db.execute(sql`
    SELECT
      COUNT(*)::int AS goal_count,
      COALESCE(AVG(CAST(progress AS NUMERIC)), 0)::numeric(5,2) AS avg_progress,
      COUNT(*) FILTER (WHERE status = 'at_risk' OR status = 'behind')::int AS at_risk_count
    FROM bearing_goals
    WHERE period_id = ${id}
      AND organization_id = ${orgId}
  `);

  const row = stats[0] ?? { goal_count: 0, avg_progress: 0, at_risk_count: 0 };

  return {
    ...period,
    stats: {
      goal_count: row.goal_count,
      avg_progress: Number.parseFloat(row.avg_progress),
      at_risk_count: row.at_risk_count,
    },
  };
}

export async function getPeriodById(id: string, orgId: string) {
  const [period] = await db
    .select()
    .from(bearingPeriods)
    .where(and(eq(bearingPeriods.id, id), eq(bearingPeriods.organization_id, orgId)))
    .limit(1);
  return period ?? null;
}

export async function createPeriod(
  data: CreatePeriodInput,
  userId: string,
  orgId: string,
) {
  // Validate dates
  if (new Date(data.starts_at) >= new Date(data.ends_at)) {
    throw new BearingError('VALIDATION_ERROR', 'starts_at must be before ends_at', 400);
  }

  const [period] = await db
    .insert(bearingPeriods)
    .values({
      organization_id: orgId,
      name: data.name,
      period_type: data.period_type,
      starts_at: data.starts_at,
      ends_at: data.ends_at,
      status: data.status ?? 'planning',
      created_by: userId,
    })
    .returning();

  return period!;
}

export async function updatePeriod(
  id: string,
  data: UpdatePeriodInput,
  orgId: string,
) {
  const existing = await getPeriodById(id, orgId);
  if (!existing) throw new BearingError('NOT_FOUND', 'Period not found', 404);

  const updateValues: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (data.name !== undefined) updateValues.name = data.name;
  if (data.period_type !== undefined) updateValues.period_type = data.period_type;
  if (data.starts_at !== undefined) updateValues.starts_at = data.starts_at;
  if (data.ends_at !== undefined) updateValues.ends_at = data.ends_at;
  if (data.status !== undefined) updateValues.status = data.status;

  // Validate dates if both present
  const startsAt = (data.starts_at ?? existing.starts_at) as string;
  const endsAt = (data.ends_at ?? existing.ends_at) as string;
  if (new Date(startsAt) >= new Date(endsAt)) {
    throw new BearingError('VALIDATION_ERROR', 'starts_at must be before ends_at', 400);
  }

  const [period] = await db
    .update(bearingPeriods)
    .set(updateValues)
    .where(and(eq(bearingPeriods.id, id), eq(bearingPeriods.organization_id, orgId)))
    .returning();

  if (!period) throw new BearingError('NOT_FOUND', 'Period not found', 404);

  return period;
}

export async function deletePeriod(id: string, orgId: string) {
  const existing = await getPeriodById(id, orgId);
  if (!existing) throw new BearingError('NOT_FOUND', 'Period not found', 404);

  // Check if period has goals (scoped to org)
  const goalCount: any[] = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM bearing_goals WHERE period_id = ${id} AND organization_id = ${orgId}
  `);
  if (goalCount[0]?.c > 0) {
    throw new BearingError(
      'CONFLICT',
      'Cannot delete period with existing goals. Remove goals first.',
      409,
    );
  }

  await db.delete(bearingPeriods).where(and(eq(bearingPeriods.id, id), eq(bearingPeriods.organization_id, orgId)));
  return { deleted: true };
}

export async function activatePeriod(id: string, orgId: string) {
  const existing = await getPeriodById(id, orgId);
  if (!existing) throw new BearingError('NOT_FOUND', 'Period not found', 404);

  if (existing.status === 'active') {
    throw new BearingError('BAD_REQUEST', 'Period is already active', 400);
  }

  if (existing.status === 'completed') {
    throw new BearingError('BAD_REQUEST', 'Cannot activate a completed period', 400);
  }

  const [period] = await db
    .update(bearingPeriods)
    .set({ status: 'active', updated_at: new Date() })
    .where(and(eq(bearingPeriods.id, id), eq(bearingPeriods.organization_id, orgId)))
    .returning();

  if (!period) throw new BearingError('NOT_FOUND', 'Period not found', 404);

  return period;
}

export async function completePeriod(id: string, orgId: string) {
  const existing = await getPeriodById(id, orgId);
  if (!existing) throw new BearingError('NOT_FOUND', 'Period not found', 404);

  if (existing.status === 'completed') {
    throw new BearingError('BAD_REQUEST', 'Period is already completed', 400);
  }

  const [period] = await db
    .update(bearingPeriods)
    .set({ status: 'completed', updated_at: new Date() })
    .where(and(eq(bearingPeriods.id, id), eq(bearingPeriods.organization_id, orgId)))
    .returning();

  if (!period) throw new BearingError('NOT_FOUND', 'Period not found', 404);

  return period;
}
