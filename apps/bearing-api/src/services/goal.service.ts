import { eq, and, gt, asc, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  bearingGoals,
  bearingKeyResults,
  bearingGoalWatchers,
  bearingUpdates,
  bearingPeriods,
  users,
} from '../db/schema/index.js';
import type Redis from 'ioredis';
import { BearingError } from './period.service.js';
import {
  computeGoalProgress,
  computeGoalStatus,
  getCachedGoalProgress,
  invalidateGoalProgressCache,
} from './progress-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

async function validateOwnerInOrg(ownerId: string, orgId: string): Promise<void> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, ownerId), eq(users.org_id, orgId), eq(users.is_active, true)))
    .limit(1);

  if (!user) {
    throw new BearingError('BAD_REQUEST', 'owner_id must reference an active user in the same organization', 400);
  }
}

async function validatePeriodOrg(periodId: string, orgId: string): Promise<void> {
  const [period] = await db
    .select({ id: bearingPeriods.id })
    .from(bearingPeriods)
    .where(and(eq(bearingPeriods.id, periodId), eq(bearingPeriods.organization_id, orgId)))
    .limit(1);

  if (!period) {
    throw new BearingError('NOT_FOUND', 'Period not found', 404);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListGoalFilters {
  orgId: string;
  periodId?: string;
  scope?: string;
  projectId?: string;
  ownerId?: string;
  status?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface CreateGoalInput {
  period_id: string;
  scope?: string;
  project_id?: string | null;
  team_name?: string | null;
  title: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  status?: string;
  owner_id?: string | null;
}

export interface UpdateGoalInput {
  period_id?: string;
  scope?: string;
  project_id?: string | null;
  team_name?: string | null;
  title?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  status?: string;
  owner_id?: string | null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listGoals(filters: ListGoalFilters) {
  const conditions = [eq(bearingGoals.organization_id, filters.orgId)];

  if (filters.periodId) {
    conditions.push(eq(bearingGoals.period_id, filters.periodId));
  }

  if (filters.scope) {
    conditions.push(eq(bearingGoals.scope, filters.scope));
  }

  if (filters.projectId) {
    conditions.push(eq(bearingGoals.project_id, filters.projectId));
  }

  if (filters.ownerId) {
    conditions.push(eq(bearingGoals.owner_id, filters.ownerId));
  }

  if (filters.status) {
    conditions.push(eq(bearingGoals.status, filters.status));
  }

  if (filters.search) {
    const escaped = escapeLike(filters.search);
    conditions.push(
      or(
        ilike(bearingGoals.title, `%${escaped}%`),
        ilike(bearingGoals.description, `%${escaped}%`),
      )!,
    );
  }

  const limit = Math.min(filters.limit ?? 50, 100);

  if (filters.cursor) {
    conditions.push(gt(bearingGoals.created_at, new Date(filters.cursor)));
  }

  const rows = await db
    .select()
    .from(bearingGoals)
    .where(and(...conditions))
    .orderBy(asc(bearingGoals.created_at))
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

export async function getGoal(id: string, orgId: string, redis?: Redis) {
  const [goal] = await db
    .select()
    .from(bearingGoals)
    .where(and(eq(bearingGoals.id, id), eq(bearingGoals.organization_id, orgId)))
    .limit(1);

  if (!goal) return null;

  const keyResults = await db
    .select()
    .from(bearingKeyResults)
    .where(eq(bearingKeyResults.goal_id, id))
    .orderBy(asc(bearingKeyResults.sort_order));

  // Use cached progress when Redis is available, otherwise compute live
  const progress = redis
    ? await getCachedGoalProgress(id, redis)
    : await computeGoalProgress(id);
  const status = await computeGoalStatus({ ...goal, progress: progress.toString() });

  return {
    ...goal,
    progress: progress.toFixed(2),
    computed_status: status,
    key_results: keyResults,
  };
}

export async function getGoalById(id: string, orgId: string) {
  const [goal] = await db
    .select()
    .from(bearingGoals)
    .where(and(eq(bearingGoals.id, id), eq(bearingGoals.organization_id, orgId)))
    .limit(1);
  return goal ?? null;
}

export async function createGoal(
  data: CreateGoalInput,
  userId: string,
  orgId: string,
) {
  await validatePeriodOrg(data.period_id, orgId);

  if (data.owner_id) {
    await validateOwnerInOrg(data.owner_id, orgId);
  }

  const [goal] = await db
    .insert(bearingGoals)
    .values({
      organization_id: orgId,
      period_id: data.period_id,
      scope: data.scope ?? 'organization',
      project_id: data.project_id ?? null,
      team_name: data.team_name ?? null,
      title: data.title,
      description: data.description ?? null,
      icon: data.icon ?? null,
      color: data.color ?? null,
      status: data.status ?? 'draft',
      owner_id: data.owner_id ?? userId,
      created_by: userId,
    })
    .returning();

  return goal!;
}

export async function updateGoal(
  id: string,
  data: UpdateGoalInput,
  orgId: string,
  redis?: Redis,
) {
  const existing = await getGoalById(id, orgId);
  if (!existing) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  if (data.period_id !== undefined) {
    await validatePeriodOrg(data.period_id, orgId);
  }

  if (data.owner_id !== undefined && data.owner_id !== null) {
    await validateOwnerInOrg(data.owner_id, orgId);
  }

  const updateValues: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (data.period_id !== undefined) updateValues.period_id = data.period_id;
  if (data.scope !== undefined) updateValues.scope = data.scope;
  if (data.project_id !== undefined) updateValues.project_id = data.project_id;
  if (data.team_name !== undefined) updateValues.team_name = data.team_name;
  if (data.title !== undefined) updateValues.title = data.title;
  if (data.description !== undefined) updateValues.description = data.description;
  if (data.icon !== undefined) updateValues.icon = data.icon;
  if (data.color !== undefined) updateValues.color = data.color;
  if (data.status !== undefined) updateValues.status = data.status;
  if (data.owner_id !== undefined) updateValues.owner_id = data.owner_id;

  const [goal] = await db
    .update(bearingGoals)
    .set(updateValues)
    .where(and(eq(bearingGoals.id, id), eq(bearingGoals.organization_id, orgId)))
    .returning();

  if (!goal) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  // Invalidate cached progress so the next GET recomputes
  if (redis) {
    await invalidateGoalProgressCache(id, redis);
  }

  return goal;
}

/**
 * Invalidate goal progress cache. Exported for use by KR mutation paths.
 */
export async function invalidateGoalCache(goalId: string, redis?: Redis) {
  if (redis) {
    await invalidateGoalProgressCache(goalId, redis);
  }
}

export async function deleteGoal(id: string, orgId: string) {
  const existing = await getGoalById(id, orgId);
  if (!existing) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  await db.delete(bearingGoals).where(and(eq(bearingGoals.id, id), eq(bearingGoals.organization_id, orgId)));
  return { deleted: true };
}

export async function overrideStatus(id: string, status: string, orgId: string, redis?: Redis) {
  const existing = await getGoalById(id, orgId);
  if (!existing) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  const [goal] = await db
    .update(bearingGoals)
    .set({
      status,
      status_override: true,
      updated_at: new Date(),
    })
    .where(and(eq(bearingGoals.id, id), eq(bearingGoals.organization_id, orgId)))
    .returning();

  if (!goal) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  if (redis) {
    await invalidateGoalProgressCache(id, redis);
  }

  return goal;
}

// ---------------------------------------------------------------------------
// Updates (check-ins)
// ---------------------------------------------------------------------------

export async function listUpdates(goalId: string, orgId: string) {
  // Verify goal exists and belongs to org
  const goal = await getGoalById(goalId, orgId);
  if (!goal) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  const rows = await db
    .select()
    .from(bearingUpdates)
    .where(eq(bearingUpdates.goal_id, goalId))
    .orderBy(asc(bearingUpdates.created_at))
    .limit(500);

  return { data: rows };
}

export async function createUpdate(
  goalId: string,
  input: { status: string; body?: string | null },
  userId: string,
  orgId: string,
) {
  const goal = await getGoalById(goalId, orgId);
  if (!goal) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  const [update] = await db
    .insert(bearingUpdates)
    .values({
      goal_id: goalId,
      author_id: userId,
      status: input.status,
      body: input.body ?? null,
      // Snapshot the goal's status and progress at update time. These
      // columns exist on the DB row since migration 0028 (NOT NULL) and
      // were previously omitted by this insert, which would have failed on
      // any real call. The snapshot lets historic updates display their
      // at-time state even after the goal's live status/progress change.
      status_at_time: goal.status,
      progress_at_time: String(goal.progress ?? '0'),
    })
    .returning();

  return update!;
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

export async function listWatchers(goalId: string, orgId: string) {
  const goal = await getGoalById(goalId, orgId);
  if (!goal) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  const rows = await db
    .select()
    .from(bearingGoalWatchers)
    .where(eq(bearingGoalWatchers.goal_id, goalId))
    .limit(200);

  return { data: rows };
}

export async function addWatcher(goalId: string, userId: string, orgId: string) {
  const goal = await getGoalById(goalId, orgId);
  if (!goal) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  const [watcher] = await db
    .insert(bearingGoalWatchers)
    .values({
      goal_id: goalId,
      user_id: userId,
    })
    .onConflictDoNothing()
    .returning();

  return watcher ?? { goal_id: goalId, user_id: userId };
}

export async function removeWatcher(goalId: string, userId: string, orgId: string) {
  const goal = await getGoalById(goalId, orgId);
  if (!goal) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  await db
    .delete(bearingGoalWatchers)
    .where(
      and(
        eq(bearingGoalWatchers.goal_id, goalId),
        eq(bearingGoalWatchers.user_id, userId),
      ),
    );

  return { deleted: true };
}

// ---------------------------------------------------------------------------
// History (progress snapshots for charting)
// ---------------------------------------------------------------------------

export async function getGoalHistory(goalId: string, orgId: string) {
  const goal = await getGoalById(goalId, orgId);
  if (!goal) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  const rows: any[] = await db.execute(sql`
    SELECT
      s.recorded_at,
      AVG(CAST(s.progress AS NUMERIC))::numeric(5,2) AS avg_progress
    FROM bearing_kr_snapshots s
    JOIN bearing_key_results kr ON kr.id = s.key_result_id
    WHERE kr.goal_id = ${goalId}
    GROUP BY s.recorded_at
    ORDER BY s.recorded_at ASC
    LIMIT 1000
  `);

  return { data: rows };
}
