import { eq, sql, avg } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bearingKeyResults, bearingPeriods } from '../db/schema/index.js';
import { computeAutoStatus } from './status-engine.js';
import type Redis from 'ioredis';

// ---------------------------------------------------------------------------
// Progress computation engine
// ---------------------------------------------------------------------------

const CACHE_TTL_SECONDS = 300; // 5 minutes

/**
 * Compute progress for a single key result based on its progress_mode.
 */
export function computeKrProgress(kr: {
  start_value: string;
  current_value: string;
  target_value: string;
  direction: string;
  progress_mode: string;
}): number {
  if (kr.progress_mode === 'linked') {
    // Linked progress is computed via computeLinkedProgress
    return 0;
  }

  const start = Number.parseFloat(kr.start_value);
  const current = Number.parseFloat(kr.current_value);
  const target = Number.parseFloat(kr.target_value);

  if (kr.direction === 'decrease') {
    // For decrease direction: progress when current goes down from start toward target
    const range = start - target;
    if (range <= 0) return 100;
    const moved = start - current;
    return Math.min(100, Math.max(0, (moved / range) * 100));
  }

  // Default: increase direction
  const range = target - start;
  if (range <= 0) return 100;
  const moved = current - start;
  return Math.min(100, Math.max(0, (moved / range) * 100));
}

/**
 * Compute linked progress by querying Bam tasks/epics via direct DB access.
 * Iterates over all bearing_kr_links for the KR and produces a weighted
 * average of per-link progress.  Supported target_types:
 *   - task / tasks  — individual task done/total among linked tasks
 *   - epic          — done/total tasks within the linked epic
 *   - project       — done/total tasks within the linked project
 *   - sprint        — done/total tasks within the linked sprint
 *   - goal          — reads the linked Bearing goal's own progress field
 */
export async function computeLinkedProgress(kr: {
  id: string;
  linked_query: unknown;
  organization_id: string;
}): Promise<number> {
  // Load all links for this KR
  const links: any[] = await db.execute(sql`
    SELECT id, target_type, target_id, metadata
    FROM bearing_kr_links
    WHERE key_result_id = ${kr.id}
  `);

  if (links.length === 0) {
    // Fall back to legacy linked_query approach for task links
    if (!kr.linked_query) return 0;
    const query = kr.linked_query as Record<string, unknown>;
    const targetType = query.target_type as string | undefined;
    if (targetType === 'task' || targetType === 'tasks') {
      return computeTaskLinksProgress(kr.id, kr.organization_id);
    }
    return 0;
  }

  let totalWeight = 0;
  let weightedProgress = 0;

  for (const link of links) {
    const weight = Number((link.metadata as any)?.weight ?? 1);
    let linkProgress = 0;

    switch (link.target_type) {
      case 'task':
      case 'tasks': {
        linkProgress = await computeTaskLinksProgress(kr.id, kr.organization_id);
        break;
      }

      case 'epic': {
        // Count tasks within the epic that are in 'done' state vs total
        const epicResult: any[] = await db.execute(sql`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ts.category = 'done')::int AS done
          FROM tasks t
          JOIN task_states ts ON ts.id = t.state_id
          JOIN projects p ON p.id = t.project_id
          WHERE t.epic_id = ${link.target_id}
            AND p.org_id = ${kr.organization_id}
        `);
        const epicRow = epicResult[0];
        if (epicRow && epicRow.total > 0) {
          linkProgress = (epicRow.done / epicRow.total) * 100;
        }
        break;
      }

      case 'project': {
        // Count done tasks / total tasks in the project
        const projResult: any[] = await db.execute(sql`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ts.category = 'done')::int AS done
          FROM tasks t
          JOIN task_states ts ON ts.id = t.state_id
          JOIN projects p ON p.id = t.project_id
          WHERE t.project_id = ${link.target_id}
            AND p.org_id = ${kr.organization_id}
        `);
        const projRow = projResult[0];
        if (projRow && projRow.total > 0) {
          linkProgress = (projRow.done / projRow.total) * 100;
        }
        break;
      }

      case 'sprint': {
        // Count done tasks / total tasks in the sprint
        const sprintResult: any[] = await db.execute(sql`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ts.category = 'done')::int AS done
          FROM tasks t
          JOIN task_states ts ON ts.id = t.state_id
          JOIN projects p ON p.id = t.project_id
          WHERE t.sprint_id = ${link.target_id}
            AND p.org_id = ${kr.organization_id}
        `);
        const sprintRow = sprintResult[0];
        if (sprintRow && sprintRow.total > 0) {
          linkProgress = (sprintRow.done / sprintRow.total) * 100;
        }
        break;
      }

      case 'goal': {
        // Read the linked Bearing goal's own progress field
        const goalResult: any[] = await db.execute(sql`
          SELECT progress
          FROM bearing_goals
          WHERE id = ${link.target_id}
            AND organization_id = ${kr.organization_id}
        `);
        const goalRow = goalResult[0];
        if (goalRow) {
          linkProgress = Number(goalRow.progress ?? 0);
        }
        break;
      }

      default:
        // Unknown target_type — skip
        break;
    }

    totalWeight += weight;
    weightedProgress += linkProgress * weight;
  }

  if (totalWeight === 0) return 0;
  return Math.min(100, Math.max(0, weightedProgress / totalWeight));
}

/**
 * Helper: compute progress from individually-linked tasks (target_type = 'task').
 */
async function computeTaskLinksProgress(
  krId: string,
  orgId: string,
): Promise<number> {
  const result: any[] = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE ts.category = 'done')::int AS completed
    FROM bearing_kr_links l
    JOIN tasks t ON t.id = l.target_id
    JOIN task_states ts ON ts.id = t.state_id
    JOIN projects p ON p.id = t.project_id
    WHERE l.key_result_id = ${krId}
      AND l.target_type = 'task'
      AND p.org_id = ${orgId}
  `);

  const row = result[0];
  if (!row || row.total === 0) return 0;
  return (row.completed / row.total) * 100;
}

/**
 * Compute aggregate goal progress from its key results.
 * Returns the average of all KR progress values.
 */
export async function computeGoalProgress(goalId: string): Promise<number> {
  const result = await db
    .select({
      avg_progress: avg(bearingKeyResults.progress),
    })
    .from(bearingKeyResults)
    .where(eq(bearingKeyResults.goal_id, goalId));

  const row = result[0];
  if (!row || row.avg_progress === null) return 0;
  return Number.parseFloat(row.avg_progress);
}

/**
 * Compute goal status based on progress vs elapsed time in the period.
 * Returns auto-status unless status_override is set.
 */
export async function computeGoalStatus(
  goal: {
    id: string;
    period_id: string;
    progress: string;
    status_override: boolean;
    status: string;
  },
): Promise<string> {
  if (goal.status_override) return goal.status;

  const [period] = await db
    .select()
    .from(bearingPeriods)
    .where(eq(bearingPeriods.id, goal.period_id))
    .limit(1);

  if (!period) return goal.status;

  return computeAutoStatus({
    progress: Number.parseFloat(goal.progress),
    starts_at: period.starts_at,
    ends_at: period.ends_at,
  });
}

/**
 * Get cached progress or compute and cache it.
 */
export async function getCachedGoalProgress(
  goalId: string,
  redis: Redis,
): Promise<number> {
  const cacheKey = `bearing:goal:progress:${goalId}`;
  const cached = await redis.get(cacheKey);
  if (cached !== null) return Number.parseFloat(cached);

  const progress = await computeGoalProgress(goalId);
  await redis.set(cacheKey, progress.toString(), 'EX', CACHE_TTL_SECONDS);
  return progress;
}

/**
 * Invalidate cached progress for a goal.
 */
export async function invalidateGoalProgressCache(
  goalId: string,
  redis: Redis,
): Promise<void> {
  await redis.del(`bearing:goal:progress:${goalId}`);
}
