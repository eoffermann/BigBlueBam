import { eq, and, asc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  bearingKeyResults,
  bearingKrLinks,
  bearingKrSnapshots,
  bearingGoals,
} from '../db/schema/index.js';
import type Redis from 'ioredis';
import { BearingError } from './period.service.js';
import { computeKrProgress, invalidateGoalProgressCache } from './progress-engine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateKeyResultInput {
  title: string;
  description?: string | null;
  metric_type?: string;
  target_value?: number;
  current_value?: number;
  start_value?: number;
  unit?: string | null;
  direction?: string;
  progress_mode?: string;
  linked_query?: Record<string, unknown> | null;
  owner_id?: string | null;
  sort_order?: number;
}

export interface UpdateKeyResultInput {
  title?: string;
  description?: string | null;
  metric_type?: string;
  target_value?: number;
  current_value?: number;
  start_value?: number;
  unit?: string | null;
  direction?: string;
  progress_mode?: string;
  linked_query?: Record<string, unknown> | null;
  owner_id?: string | null;
  sort_order?: number;
}

export interface AddLinkInput {
  link_type: string;
  target_type: string;
  target_id: string;
  metadata?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * `orgId` is required (BRG-1, #246). bearing_key_results has no org column of
 * its own, so the only tenant predicate is the join through bearing_goals. A
 * caller-supplied goal id from another org yields zero rows instead of that
 * org's key results.
 */
export async function listKeyResults(goalId: string, orgId: string) {
  const rows = await db
    .select({ kr: bearingKeyResults })
    .from(bearingKeyResults)
    .innerJoin(bearingGoals, eq(bearingKeyResults.goal_id, bearingGoals.id))
    .where(and(eq(bearingKeyResults.goal_id, goalId), eq(bearingGoals.organization_id, orgId)))
    .orderBy(asc(bearingKeyResults.sort_order))
    .limit(200);

  return { data: rows.map((r) => r.kr) };
}

export async function getKeyResult(id: string) {
  const [kr] = await db
    .select()
    .from(bearingKeyResults)
    .where(eq(bearingKeyResults.id, id))
    .limit(1);

  return kr ?? null;
}

export async function getKeyResultWithOrgCheck(id: string, orgId: string) {
  const [kr] = await db
    .select({
      kr: bearingKeyResults,
      goal_org_id: bearingGoals.organization_id,
    })
    .from(bearingKeyResults)
    .innerJoin(bearingGoals, eq(bearingKeyResults.goal_id, bearingGoals.id))
    .where(eq(bearingKeyResults.id, id))
    .limit(1);

  if (!kr) return null;
  if (kr.goal_org_id !== orgId) return null;
  return kr.kr;
}

export async function createKeyResult(
  goalId: string,
  data: CreateKeyResultInput,
  orgId: string,
) {
  // Verify goal belongs to org
  const [goal] = await db
    .select()
    .from(bearingGoals)
    .where(and(eq(bearingGoals.id, goalId), eq(bearingGoals.organization_id, orgId)))
    .limit(1);

  if (!goal) throw new BearingError('NOT_FOUND', 'Goal not found', 404);

  const [kr] = await db
    .insert(bearingKeyResults)
    .values({
      goal_id: goalId,
      title: data.title,
      description: data.description ?? null,
      metric_type: data.metric_type ?? 'percentage',
      target_value: (data.target_value ?? 100).toString(),
      current_value: (data.current_value ?? 0).toString(),
      start_value: (data.start_value ?? 0).toString(),
      unit: data.unit ?? null,
      direction: data.direction ?? 'increase',
      progress_mode: data.progress_mode ?? 'manual',
      linked_query: data.linked_query ?? null,
      owner_id: data.owner_id ?? null,
      sort_order: data.sort_order ?? 0,
    })
    .returning();

  // Compute and set initial progress
  const progress = computeKrProgress({
    start_value: kr!.start_value,
    current_value: kr!.current_value,
    target_value: kr!.target_value,
    direction: kr!.direction,
    progress_mode: kr!.progress_mode,
  });

  if (progress > 0) {
    const [updated] = await db
      .update(bearingKeyResults)
      .set({ progress: progress.toFixed(2) })
      .where(eq(bearingKeyResults.id, kr!.id))
      .returning();
    return updated!;
  }

  return kr!;
}

export async function updateKeyResult(
  id: string,
  data: UpdateKeyResultInput,
  orgId: string,
  redis?: Redis,
) {
  const existing = await getKeyResultWithOrgCheck(id, orgId);
  if (!existing) throw new BearingError('NOT_FOUND', 'Key result not found', 404);

  const updateValues: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (data.title !== undefined) updateValues.title = data.title;
  if (data.description !== undefined) updateValues.description = data.description;
  if (data.metric_type !== undefined) updateValues.metric_type = data.metric_type;
  if (data.target_value !== undefined) updateValues.target_value = data.target_value.toString();
  if (data.current_value !== undefined) updateValues.current_value = data.current_value.toString();
  if (data.start_value !== undefined) updateValues.start_value = data.start_value.toString();
  if (data.unit !== undefined) updateValues.unit = data.unit;
  if (data.direction !== undefined) updateValues.direction = data.direction;
  if (data.progress_mode !== undefined) updateValues.progress_mode = data.progress_mode;
  if (data.linked_query !== undefined) updateValues.linked_query = data.linked_query;
  if (data.owner_id !== undefined) updateValues.owner_id = data.owner_id;
  if (data.sort_order !== undefined) updateValues.sort_order = data.sort_order;

  // Use a subquery join to scope the UPDATE to the correct org
  const [kr] = await db
    .update(bearingKeyResults)
    .set(updateValues)
    .where(eq(bearingKeyResults.id, id))
    .returning();

  if (!kr) throw new BearingError('NOT_FOUND', 'Key result not found', 404);

  // Recompute progress
  const progress = computeKrProgress({
    start_value: kr.start_value,
    current_value: kr.current_value,
    target_value: kr.target_value,
    direction: kr.direction,
    progress_mode: kr.progress_mode,
  });

  const [updated] = await db
    .update(bearingKeyResults)
    .set({ progress: progress.toFixed(2) })
    .where(eq(bearingKeyResults.id, id))
    .returning();

  // Record snapshot if current_value was changed
  if (data.current_value !== undefined) {
    await db.insert(bearingKrSnapshots).values({
      key_result_id: id,
      value: updated!.current_value,
      progress: progress.toFixed(2),
    });
  }

  // Invalidate parent goal's cached progress
  if (redis) {
    await invalidateGoalProgressCache(kr!.goal_id, redis);
  }

  return updated!;
}

export async function deleteKeyResult(id: string, orgId: string) {
  const existing = await getKeyResultWithOrgCheck(id, orgId);
  if (!existing) throw new BearingError('NOT_FOUND', 'Key result not found', 404);

  await db.delete(bearingKeyResults).where(eq(bearingKeyResults.id, id));
  return { deleted: true };
}

export async function setCurrentValue(id: string, value: number, orgId: string, redis?: Redis) {
  const existing = await getKeyResultWithOrgCheck(id, orgId);
  if (!existing) throw new BearingError('NOT_FOUND', 'Key result not found', 404);

  const newCurrentValue = value.toString();

  // Compute progress with new value
  const progress = computeKrProgress({
    start_value: existing.start_value,
    current_value: newCurrentValue,
    target_value: existing.target_value,
    direction: existing.direction,
    progress_mode: existing.progress_mode,
  });

  const [kr] = await db
    .update(bearingKeyResults)
    .set({
      current_value: newCurrentValue,
      progress: progress.toFixed(2),
      updated_at: new Date(),
    })
    .where(eq(bearingKeyResults.id, id))
    .returning();

  // Record snapshot
  await db.insert(bearingKrSnapshots).values({
    key_result_id: id,
    value: newCurrentValue,
    progress: progress.toFixed(2),
  });

  // Invalidate parent goal's cached progress
  if (redis) {
    await invalidateGoalProgressCache(existing.goal_id, redis);
  }

  return kr!;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export async function listLinks(krId: string, orgId: string) {
  const kr = await getKeyResultWithOrgCheck(krId, orgId);
  if (!kr) throw new BearingError('NOT_FOUND', 'Key result not found', 404);

  const rows = await db
    .select()
    .from(bearingKrLinks)
    .where(eq(bearingKrLinks.key_result_id, krId))
    .limit(200);

  return { data: rows };
}

export async function addLink(krId: string, data: AddLinkInput, orgId: string) {
  const kr = await getKeyResultWithOrgCheck(krId, orgId);
  if (!kr) throw new BearingError('NOT_FOUND', 'Key result not found', 404);

  // Validate that the link target belongs to the caller's org
  await validateLinkTargetOrg(data.target_type, data.target_id, orgId);

  const [link] = await db
    .insert(bearingKrLinks)
    .values({
      key_result_id: krId,
      link_type: data.link_type,
      target_type: data.target_type,
      target_id: data.target_id,
      metadata: data.metadata ?? null,
    })
    .returning();

  return link!;
}

/**
 * Validate that a link target entity belongs to the caller's organization.
 * For tasks/epics/sprints, checks via the project's org_id.
 * For goals, checks bearing_goals.organization_id directly.
 * For projects, checks projects.org_id directly.
 */
async function validateLinkTargetOrg(
  targetType: string,
  targetId: string,
  orgId: string,
): Promise<void> {
  let rows: any[];

  switch (targetType) {
    case 'task':
    case 'epic':
      // tasks -> projects.org_id
      rows = await db.execute(sql`
        SELECT t.id FROM tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE t.id = ${targetId} AND p.org_id = ${orgId}
        LIMIT 1
      `);
      break;

    case 'sprint':
      // sprints -> projects.org_id
      rows = await db.execute(sql`
        SELECT s.id FROM sprints s
        JOIN projects p ON p.id = s.project_id
        WHERE s.id = ${targetId} AND p.org_id = ${orgId}
        LIMIT 1
      `);
      break;

    case 'project':
      rows = await db.execute(sql`
        SELECT id FROM projects
        WHERE id = ${targetId} AND org_id = ${orgId}
        LIMIT 1
      `);
      break;

    case 'goal':
      rows = await db.execute(sql`
        SELECT id FROM bearing_goals
        WHERE id = ${targetId} AND organization_id = ${orgId}
        LIMIT 1
      `);
      break;

    default:
      throw new BearingError('BAD_REQUEST', `Unsupported target_type: ${targetType}`, 400);
  }

  if (!rows || rows.length === 0) {
    throw new BearingError(
      'NOT_FOUND',
      `Target ${targetType} not found or does not belong to your organization`,
      404,
    );
  }
}

export async function removeLink(linkId: string, orgId: string) {
  // Verify the link belongs to a KR in the user's org
  const [link] = await db
    .select({
      link: bearingKrLinks,
      goal_org_id: bearingGoals.organization_id,
    })
    .from(bearingKrLinks)
    .innerJoin(bearingKeyResults, eq(bearingKrLinks.key_result_id, bearingKeyResults.id))
    .innerJoin(bearingGoals, eq(bearingKeyResults.goal_id, bearingGoals.id))
    .where(eq(bearingKrLinks.id, linkId))
    .limit(1);

  if (!link || link.goal_org_id !== orgId) {
    throw new BearingError('NOT_FOUND', 'Link not found', 404);
  }

  await db.delete(bearingKrLinks).where(eq(bearingKrLinks.id, linkId));
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// History (snapshots)
// ---------------------------------------------------------------------------

export async function getHistory(krId: string, orgId: string) {
  const kr = await getKeyResultWithOrgCheck(krId, orgId);
  if (!kr) throw new BearingError('NOT_FOUND', 'Key result not found', 404);

  const rows = await db
    .select()
    .from(bearingKrSnapshots)
    .where(eq(bearingKrSnapshots.key_result_id, krId))
    .orderBy(asc(bearingKrSnapshots.recorded_at))
    .limit(1000);

  return { data: rows };
}
