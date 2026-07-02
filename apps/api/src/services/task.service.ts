import { eq, and, or, sql, ilike, asc, gt, desc, inArray, isNull, aliasedTable } from 'drizzle-orm';
import Redis from 'ioredis';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { projects } from '../db/schema/projects.js';
import { epics } from '../db/schema/epics.js';
import { phases } from '../db/schema/phases.js';
import { tickets, ticketMessages } from '../db/schema/tickets.js';
import { taskParentLinks } from '../db/schema/task-parent-links.js';
import type { CreateTaskInput, UpdateTaskInput, MoveTaskInput, BulkUpdateInput, TaskLink } from '@bigbluebam/shared';
import { updateTaskSchema, moveTaskSchema } from '@bigbluebam/shared';
import {
  normalizeTaskLinks,
  resolveInternalLinkTitles,
  mirrorTaskEntityLinks,
  pruneRemovedTaskLinkMirrors,
  type TaskLinkMirror,
} from './task-links.service.js';
import { enqueueTaskLinkTitleFetch } from './task-links-queue.service.js';
import { broadcastToProject } from './realtime.service.js';
import { logActivity } from './activity.service.js';
import { postToSlack, taskDeepLink } from './slack-notify.service.js';
import { env } from '../env.js';
import { escapeLike } from '../lib/escape-like.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { enrichTask, loadActor, loadOrg, loadPhase } from './bolt-event-enricher.service.js';
import { fanoutNotification, enqueueNotification } from './notification-fanout.service.js';
import { enqueueFeedFanin, feedFaninForTask } from './feed-queue.js';
import { RELATIONSHIP_FLAGS } from '@bigbluebam/shared';

/**
 * Enqueue async title-fetch jobs for links the synchronous path left
 * untitled — i.e. external URLs (internal ones already resolved inline).
 * Fire-and-forget: the queue helper swallows its own errors and the worker
 * is SSRF-guarded. An untitled link just renders as its hostname until the
 * fetch lands.
 */
function enqueueUntitledLinkFetches(taskId: string, links: TaskLink[]): void {
  for (const link of links) {
    if (link.title === null && link.title_source === 'none') {
      void enqueueTaskLinkTitleFetch(taskId, link.id, link.url);
    }
  }
}

/** Look up org_id for a project (used for Bolt event publishing). */
async function getProjectOrgId(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ org_id: projects.org_id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.org_id ?? null;
}

// Lazy-initialized Redis publisher for cross-service events (e.g. ticket sync
// broadcasts to the helpdesk frontend). We keep a single connection per process
// and reconnect lazily so tests that don't touch this path incur no Redis cost.
let ticketEventPublisher: Redis | null = null;
function getTicketEventPublisher(): Redis {
  if (!ticketEventPublisher) {
    ticketEventPublisher = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
  }
  return ticketEventPublisher;
}

// ─── Subtask many-to-many + done-gate (B3 Frndo Launch) ────────────────────

/**
 * Raised when a task transition into a terminal phase is blocked because one
 * or more of its subtasks is still open. The route layer maps this to a 409.
 */
export class IncompleteSubtasksError extends Error {
  public readonly code = 'INCOMPLETE_SUBTASKS' as const;
  constructor(
    public readonly openSubtasks: { id: string; human_id: string | null; title: string }[],
  ) {
    super(
      `Cannot mark Done — ${openSubtasks.length} subtask${
        openSubtasks.length === 1 ? '' : 's'
      } still open`,
    );
    this.name = 'IncompleteSubtasksError';
  }
}

export class TaskRelationCycleError extends Error {
  public readonly code = 'CYCLE' as const;
  constructor(message = 'This would create a cycle between tasks') {
    super(message);
    this.name = 'TaskRelationCycleError';
  }
}

export class TaskRelationSelfLoopError extends Error {
  public readonly code = 'SELF_LOOP' as const;
  constructor() {
    super('A task cannot be its own parent');
    this.name = 'TaskRelationSelfLoopError';
  }
}

/**
 * Collect every child task of `parentTaskId` by unioning the legacy
 * tasks.parent_task_id self-FK with the new task_parent_links join table.
 * The two paths overlap (every existing parent_task_id was backfilled into
 * task_parent_links by migration 0171), but we union defensively so a
 * partially-applied state still returns the correct set.
 */
async function collectChildTaskIds(parentTaskId: string): Promise<string[]> {
  const fromLegacy = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.parent_task_id, parentTaskId));
  const fromLinks = await db
    .select({ id: taskParentLinks.task_id })
    .from(taskParentLinks)
    .where(eq(taskParentLinks.parent_task_id, parentTaskId));
  return Array.from(new Set([...fromLegacy.map((r) => r.id), ...fromLinks.map((r) => r.id)]));
}

/**
 * Throws IncompleteSubtasksError if the task identified by `taskId` is about
 * to move to a phase with is_terminal=true while any of its subtasks still
 * has completed_at IS NULL.
 *
 * Pass the target phase or its id. We accept both forms because moveTask
 * has already loaded the phase row and shouldn't re-query.
 */
async function assertSubtasksDoneBeforeTerminal(
  taskId: string,
  target: { is_terminal: boolean | null } | string | null,
): Promise<void> {
  let isTerminal = false;
  if (target && typeof target === 'object') {
    isTerminal = target.is_terminal === true;
  } else if (typeof target === 'string') {
    const [row] = await db
      .select({ is_terminal: phases.is_terminal })
      .from(phases)
      .where(eq(phases.id, target))
      .limit(1);
    isTerminal = row?.is_terminal === true;
  }
  if (!isTerminal) return;

  const childIds = await collectChildTaskIds(taskId);
  if (childIds.length === 0) return;

  // A child is "open" when its current phase is not terminal. We join
  // through phases rather than reading the denormalized completed_at column
  // so the gate stays correct even if a write path forgets to update
  // completed_at when transitioning into a terminal phase (the legacy
  // updateTask path is one example).
  const openChildren = await db
    .select({ id: tasks.id, human_id: tasks.human_id, title: tasks.title })
    .from(tasks)
    .leftJoin(phases, eq(phases.id, tasks.phase_id))
    .where(
      and(
        inArray(tasks.id, childIds),
        or(sql`${phases.is_terminal} IS NOT TRUE`, isNull(tasks.phase_id)),
      ),
    );
  if (openChildren.length > 0) {
    throw new IncompleteSubtasksError(openChildren);
  }
}

/**
 * Rejects a proposed `taskId → parentTaskId` relation that would create a
 * cycle. Walks upward from the proposed parent through BOTH the
 * task_parent_links join table and the legacy tasks.parent_task_id self-FK;
 * if the walk ever reaches `taskId`, the child is an ancestor of its
 * would-be parent and the relation is recursive. The visited set bounds the
 * walk by the number of distinct ancestors; the depth cap is a backstop
 * against pathological data, generous enough (256) that no legitimate
 * hierarchy hits it — the old cap of 16 let cycles past chains deeper than
 * 16 links.
 *
 * Shared by every path that can write a parent relation: addTaskParent
 * (POST /tasks/:id/parents) and updateTask's parent_task_id field (PATCH
 * /tasks/:id, MCP task-update).
 */
export async function assertNoParentCycle(
  taskId: string,
  parentTaskId: string,
): Promise<void> {
  if (taskId === parentTaskId) throw new TaskRelationSelfLoopError();

  const visited = new Set<string>();
  let frontier = [parentTaskId];
  for (let depth = 0; depth < 256 && frontier.length > 0; depth++) {
    if (frontier.includes(taskId)) throw new TaskRelationCycleError();
    for (const id of frontier) visited.add(id);
    const next = await db
      .select({ id: taskParentLinks.parent_task_id })
      .from(taskParentLinks)
      .where(inArray(taskParentLinks.task_id, frontier));
    // Also include the legacy single-FK parents above each frontier task.
    const legacy = await db
      .select({ id: tasks.parent_task_id })
      .from(tasks)
      .where(and(inArray(tasks.id, frontier), sql`${tasks.parent_task_id} IS NOT NULL`));
    const merged = new Set<string>();
    for (const r of next) if (r.id && !visited.has(r.id)) merged.add(r.id);
    for (const r of legacy) if (r.id && !visited.has(r.id)) merged.add(r.id);
    frontier = Array.from(merged);
  }
}

/**
 * Add `parentTaskId` as a parent of `taskId`. Idempotent (ON CONFLICT DO
 * NOTHING). Rejects self-loops and ancestor cycles via assertNoParentCycle.
 */
export async function addTaskParent(
  taskId: string,
  parentTaskId: string,
  createdBy: string | null,
): Promise<{ already_linked: boolean }> {
  await assertNoParentCycle(taskId, parentTaskId);

  // Skip insert if the link already exists.
  const [existing] = await db
    .select({ task_id: taskParentLinks.task_id })
    .from(taskParentLinks)
    .where(
      and(
        eq(taskParentLinks.task_id, taskId),
        eq(taskParentLinks.parent_task_id, parentTaskId),
      ),
    )
    .limit(1);
  if (existing) return { already_linked: true };

  await db
    .insert(taskParentLinks)
    .values({ task_id: taskId, parent_task_id: parentTaskId, created_by: createdBy })
    .onConflictDoNothing({
      target: [taskParentLinks.task_id, taskParentLinks.parent_task_id],
    });

  // Keep the parent's subtask_count counter coherent with reality. We only
  // bump if this is a brand-new link AND the link wasn't already accounted
  // for by the legacy parent_task_id pointer (so we don't double-count when
  // a task already had this parent via the self-FK).
  const [primaryParent] = await db
    .select({ parent_task_id: tasks.parent_task_id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (primaryParent?.parent_task_id !== parentTaskId) {
    const [childRow] = await db
      .select({ completed_at: tasks.completed_at })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    await db
      .update(tasks)
      .set({
        subtask_count: sql`${tasks.subtask_count} + 1`,
        subtask_done_count:
          childRow?.completed_at != null
            ? sql`${tasks.subtask_done_count} + 1`
            : tasks.subtask_done_count,
      })
      .where(eq(tasks.id, parentTaskId));
  }
  return { already_linked: false };
}

export async function removeTaskParent(
  taskId: string,
  parentTaskId: string,
): Promise<{ removed: boolean }> {
  // Check primary-parent first; if this is the canonical parent_task_id,
  // null it out to keep the legacy column in sync.
  const [child] = await db
    .select({ parent_task_id: tasks.parent_task_id, completed_at: tasks.completed_at })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  let counterShouldDrop = false;
  if (child?.parent_task_id === parentTaskId) {
    await db.update(tasks).set({ parent_task_id: null }).where(eq(tasks.id, taskId));
    counterShouldDrop = true;
  }

  const deleted = await db
    .delete(taskParentLinks)
    .where(
      and(
        eq(taskParentLinks.task_id, taskId),
        eq(taskParentLinks.parent_task_id, parentTaskId),
      ),
    )
    .returning({ task_id: taskParentLinks.task_id });

  if (deleted.length === 0 && !counterShouldDrop) return { removed: false };
  // If we removed an actual link (either via legacy column or via join table)
  // decrement the parent's counters by the right amount.
  counterShouldDrop = counterShouldDrop || deleted.length > 0;
  if (counterShouldDrop) {
    await db
      .update(tasks)
      .set({
        subtask_count: sql`greatest(${tasks.subtask_count} - 1, 0)`,
        subtask_done_count:
          child?.completed_at != null
            ? sql`greatest(${tasks.subtask_done_count} - 1, 0)`
            : tasks.subtask_done_count,
      })
      .where(eq(tasks.id, parentTaskId));
  }
  return { removed: true };
}

/** Returns every parent task of taskId via both legacy and join-table paths. */
export async function listTaskParents(taskId: string) {
  const fromLegacy = await db
    .select({ id: tasks.parent_task_id })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  const fromLinks = await db
    .select({ id: taskParentLinks.parent_task_id })
    .from(taskParentLinks)
    .where(eq(taskParentLinks.task_id, taskId));
  const parentIds = Array.from(
    new Set([
      ...fromLegacy.map((r) => r.id).filter((id): id is string => id != null),
      ...fromLinks.map((r) => r.id),
    ]),
  );
  if (parentIds.length === 0) return [];
  const rows = await db
    .select({
      id: tasks.id,
      human_id: tasks.human_id,
      title: tasks.title,
      phase_id: tasks.phase_id,
      state_id: tasks.state_id,
      completed_at: tasks.completed_at,
      project_id: tasks.project_id,
    })
    .from(tasks)
    .where(inArray(tasks.id, parentIds));
  return rows;
}

/** Returns every child (subtask) of taskId via both legacy and join-table paths. */
export async function listTaskSubtasks(taskId: string) {
  const ids = await collectChildTaskIds(taskId);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: tasks.id,
      human_id: tasks.human_id,
      title: tasks.title,
      phase_id: tasks.phase_id,
      state_id: tasks.state_id,
      completed_at: tasks.completed_at,
      project_id: tasks.project_id,
    })
    .from(tasks)
    .where(inArray(tasks.id, ids));
  return rows;
}

// ─── Timeline parent-expansion cascade (feat/timeline-interactive) ──────────

/**
 * Direct parents of `taskId`: the union of the legacy tasks.parent_task_id
 * self-FK and every task_parent_links.parent_task_id where task_id = taskId.
 * Same dual-model union assertNoParentCycle / listTaskParents walk, trimmed to
 * just the parent ids one level up (no full-row join — the cascade only needs
 * dates, which it reads per-parent).
 */
async function getDirectParentIds(taskId: string): Promise<string[]> {
  const fromLegacy = await db
    .select({ id: tasks.parent_task_id })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  const fromLinks = await db
    .select({ id: taskParentLinks.parent_task_id })
    .from(taskParentLinks)
    .where(eq(taskParentLinks.task_id, taskId));
  return Array.from(
    new Set([
      ...fromLegacy.map((r) => r.id).filter((id): id is string => id != null),
      ...fromLinks.map((r) => r.id),
    ]),
  );
}

/**
 * Focused date-only writer for derived date propagation (ancestor widening or
 * descendant shifting). Persists ONLY the supplied
 * date column(s) + updated_at and broadcasts task.updated. Deliberately does
 * NOT route through updateTask: an ancestor widening is a derived side effect,
 * not a user edit, so it must skip the cycle re-check, the subtask_count /
 * subtask_done_count bumps, the done-gate, and the Bolt / notification
 * fan-out. Writes are attributed to `actorId` via the standard broadcast.
 */
async function writeDerivedTaskDates(
  taskId: string,
  patch: { start_date?: string; due_date?: string },
  actorId?: string,
): Promise<void> {
  const [row] = await db
    .update(tasks)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(tasks.id, taskId))
    .returning();
  if (row) {
    broadcastToProject(
      row.project_id,
      'task.updated',
      { id: taskId, changes: patch, task: row },
      actorId,
    );
  }
}

/**
 * Expand every ancestor of `taskId` so each parent's [start_date, due_date]
 * window fully encompasses its child's. EXPAND-ONLY: a bound is only ever
 * pushed outward (start earlier, due later) or POPULATED when the parent's
 * bound is null (the confirmed product decision — a null parent bound is
 * filled from the child so the parent encompasses it); a bound is never
 * shrunk. Dates compare as YYYY-MM-DD strings (lexicographic == chronological
 * for ISO dates).
 *
 * Walks upward through BOTH the legacy tasks.parent_task_id self-FK and the
 * task_parent_links join table, so a subtask with multiple parents widens all
 * of them, and each changed parent recurses to ITS parents (a parent is itself
 * a subtask of its grandparents). Only parents that actually changed are
 * re-queued, so propagation halts naturally once no bound moves; the depth cap
 * of 256 mirrors assertNoParentCycle as a hard backstop that guarantees
 * termination even on shared/diamond/cyclic data.
 */
export async function expandParentsToEncompass(
  taskId: string,
  actorId?: string,
): Promise<void> {
  let frontier = new Set<string>([taskId]);
  for (let depth = 0; depth < 256 && frontier.size > 0; depth++) {
    const changedParents = new Set<string>();
    for (const childId of frontier) {
      const [child] = await db
        .select({ start_date: tasks.start_date, due_date: tasks.due_date })
        .from(tasks)
        .where(eq(tasks.id, childId))
        .limit(1);
      // Nothing to propagate if the child has no dates at all.
      if (!child || (child.start_date == null && child.due_date == null)) continue;

      const parentIds = await getDirectParentIds(childId);
      for (const parentId of parentIds) {
        if (parentId === childId) continue; // self-loop: nothing to widen
        const [parent] = await db
          .select({ start_date: tasks.start_date, due_date: tasks.due_date })
          .from(tasks)
          .where(eq(tasks.id, parentId))
          .limit(1);
        if (!parent) continue;

        const patch: { start_date?: string; due_date?: string } = {};
        if (
          child.start_date != null &&
          (parent.start_date == null || child.start_date < parent.start_date)
        ) {
          patch.start_date = child.start_date;
        }
        if (
          child.due_date != null &&
          (parent.due_date == null || child.due_date > parent.due_date)
        ) {
          patch.due_date = child.due_date;
        }

        if (patch.start_date !== undefined || patch.due_date !== undefined) {
          await writeDerivedTaskDates(parentId, patch, actorId);
          // Recurse upward only when this parent actually widened.
          changedParents.add(parentId);
        }
      }
    }
    frontier = changedParents;
  }
}

/** Add whole days to a YYYY-MM-DD date string, returning YYYY-MM-DD. DATE columns
 *  are timezone-free, so anchor at UTC midnight to avoid DST drift. */
function addDaysToDateStr(dateStr: string, days: number): string {
  return new Date(Date.parse(dateStr) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Rigidly slide EVERY descendant of `rootTaskId` by `deltaDays` so a whole-bar
 * MOVE of a parent (both bounds shifted by the same delta) drags its subtree
 * along and keeps children aligned. Only set dates are shifted (null bounds stay
 * null). Walks downward through BOTH parent representations (collectChildTaskIds),
 * visited-guarded so a task reachable via multiple parents (diamond) shifts
 * exactly once; the depth cap of 256 mirrors the upward cascade as a hard
 * termination backstop. The root itself is excluded (it was already moved), and
 * this does NOT re-run the upward expand for shifted nodes — a rigid shift
 * preserves their alignment within the moved subtree.
 */
export async function shiftSubtreeDates(
  rootTaskId: string,
  deltaDays: number,
  actorId?: string,
): Promise<void> {
  if (deltaDays === 0) return;
  const visited = new Set<string>([rootTaskId]);
  let frontier = [rootTaskId];
  for (let depth = 0; depth < 256 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const parentId of frontier) {
      const childIds = await collectChildTaskIds(parentId);
      for (const childId of childIds) {
        if (visited.has(childId)) continue;
        visited.add(childId);
        const [child] = await db
          .select({ start_date: tasks.start_date, due_date: tasks.due_date })
          .from(tasks)
          .where(eq(tasks.id, childId))
          .limit(1);
        if (child) {
          const patch: { start_date?: string; due_date?: string } = {};
          if (child.start_date != null) patch.start_date = addDaysToDateStr(child.start_date, deltaDays);
          if (child.due_date != null) patch.due_date = addDaysToDateStr(child.due_date, deltaDays);
          if (patch.start_date !== undefined || patch.due_date !== undefined) {
            await writeDerivedTaskDates(childId, patch, actorId);
          }
        }
        next.push(childId);
      }
    }
    frontier = next;
  }
}

export async function createTask(
  projectId: string,
  data: CreateTaskInput,
  reporterId: string,
  impersonatorId?: string | null,
  viaSuperuserContext?: boolean,
) {
  // Atomically increment task_id_sequence and get new value
  const [updated] = await db
    .update(projects)
    .set({
      task_id_sequence: sql`${projects.task_id_sequence} + 1`,
    })
    .where(eq(projects.id, projectId))
    .returning({
      task_id_prefix: projects.task_id_prefix,
      task_id_sequence: projects.task_id_sequence,
    });

  if (!updated) {
    throw new TaskError('NOT_FOUND', 'Project not found', 404);
  }

  const humanId = `${updated.task_id_prefix}-${updated.task_id_sequence}`;

  // If no state_id provided and phase has auto_state_on_enter, use it
  let stateId = data.state_id ?? null;
  if (!stateId) {
    const [phase] = await db
      .select()
      .from(phases)
      .where(eq(phases.id, data.phase_id))
      .limit(1);

    if (phase?.auto_state_on_enter) {
      stateId = phase.auto_state_on_enter;
    }
  }

  // Links field (CSV-import plan Phase 0): normalize, then resolve internal
  // suite URLs synchronously (org-scoped) so the inserted row already carries
  // fetched titles. The entity_links mirror happens after insert (needs the
  // task id). orgId is resolved up-front because internal title lookups MUST
  // be scoped to the caller's org.
  let links: TaskLink[] = [];
  let linkMirrors: TaskLinkMirror[] = [];
  // Resolve the project's owning org up-front. We set tasks.org_id on EVERY
  // insert (not just the links path) so Bench analytics over Bam tasks and the
  // future RLS org-scoping gate see a populated column. Reused below for
  // internal-link title resolution when links are present.
  const createOrgId: string | null = await getProjectOrgId(projectId);
  if (data.links && data.links.length > 0) {
    const normalized = normalizeTaskLinks(data.links, reporterId);
    if (normalized.truncated) {
      console.warn('[task.service] task links truncated to cap:', { projectId });
    }
    if (createOrgId) {
      const resolved = await resolveInternalLinkTitles(normalized.links, createOrgId);
      links = resolved.links;
      linkMirrors = resolved.mirrors;
    } else {
      // No org (shouldn't happen) — store links without internal resolution.
      links = normalized.links;
    }
  }

  const [task] = await db
    .insert(tasks)
    .values({
      project_id: projectId,
      org_id: createOrgId,
      human_id: humanId,
      parent_task_id: data.parent_task_id ?? null,
      title: data.title,
      description: data.description ?? null,
      phase_id: data.phase_id,
      state_id: stateId,
      sprint_id: data.sprint_id ?? null,
      epic_id: data.epic_id ?? null,
      assignee_id: data.assignee_id ?? null,
      reporter_id: reporterId,
      priority: data.priority ?? 'medium',
      story_points: data.story_points ?? null,
      time_estimate_minutes: data.time_estimate_minutes ?? null,
      start_date: data.start_date ?? null,
      due_date: data.due_date ?? null,
      labels: data.label_ids ?? [],
      custom_fields: data.custom_fields ?? {},
      links,
      position: await getNextPosition(data.phase_id),
    })
    .returning();

  // Mirror resolved internal links into entity_links. Best-effort: the
  // canonical write (tasks.links) already landed.
  if (linkMirrors.length > 0 && createOrgId) {
    try {
      await mirrorTaskEntityLinks(task!.id, createOrgId, reporterId, linkMirrors);
    } catch (err) {
      console.error('[task.service] entity_links mirror failed:', { taskId: task!.id, err });
    }
  }
  // Queue async title fetch for links still untitled (external URLs that
  // didn't resolve internally). Fire-and-forget; SSRF-guarded in the worker.
  enqueueUntitledLinkFetches(task!.id, links);

  // Update subtask_count on parent if this is a subtask
  if (data.parent_task_id) {
    await db
      .update(tasks)
      .set({
        subtask_count: sql`${tasks.subtask_count} + 1`,
        updated_at: new Date(),
      })
      .where(eq(tasks.id, data.parent_task_id));
  }

  // Timeline rollup: a newly-created subtask that carries a date widens its
  // parent chain so every ancestor encompasses it. EXPAND-ONLY. Only worth a
  // walk when the task actually has a parent AND at least one date to project.
  if (data.parent_task_id && (data.start_date != null || data.due_date != null)) {
    await expandParentsToEncompass(task!.id, reporterId);
  }

  // Broadcast realtime event
  broadcastToProject(projectId, 'task.created', task, reporterId);

  // Log activity
  logActivity(projectId, reporterId, 'task.created', task!.id, { title: task!.title }, impersonatorId ?? null, viaSuperuserContext).catch(() => {});

  // Slack outbound notification (fire-and-forget)
  postToSlack(projectId, {
    event_type: 'task.created',
    text: `:new: Task created: *<${taskDeepLink(projectId, task!.id)}|${task!.human_id}>* — ${task!.title}`,
  }).catch(() => {});

  // Bolt workflow event (fire-and-forget)
  getProjectOrgId(projectId).then(async (orgId) => {
    if (!orgId) return;
    const [enriched, actor, org] = await Promise.all([
      enrichTask(task!),
      loadActor(reporterId),
      loadOrg(orgId),
    ]);
    publishBoltEvent(
      'task.created',
      'bam',
      {
        task: enriched.task,
        project: enriched.project,
        phase: enriched.phase,
        sprint: enriched.sprint,
        epic: enriched.epic,
        assignee: enriched.assignee,
        reporter: enriched.reporter,
        actor,
        org,
      },
      orgId,
      reporterId,
      'user',
    );
  }).catch(() => {});

  return task!;
}

async function getNextPosition(phaseId: string): Promise<number> {
  const result = await db
    .select({ maxPos: sql<number>`coalesce(max(${tasks.position}), 0)` })
    .from(tasks)
    .where(eq(tasks.phase_id, phaseId));

  return (result[0]?.maxPos ?? 0) + 1024;
}

export async function getTask(taskId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  return task ?? null;
}

/** Look up a task by its human-readable id (e.g. "MAGE-38"). Matches the
 *  full tasks.human_id column exactly, which already encodes the project
 *  prefix + sequence number. Returns null if no such ref exists. */
export async function getTaskByHumanId(humanId: string) {
  const [task] = await db
    .select({
      id: tasks.id,
      project_id: tasks.project_id,
      human_id: tasks.human_id,
      title: tasks.title,
    })
    .from(tasks)
    .where(eq(tasks.human_id, humanId))
    .limit(1);
  return task ?? null;
}

export async function updateTask(taskId: string, data: UpdateTaskInput, actorId?: string, impersonatorId?: string | null, viaSuperuserContext?: boolean) {
  const updateValues: Record<string, unknown> = {
    updated_at: new Date(),
  };

  const changedFields: string[] = [];
  if (data.title !== undefined) { updateValues.title = data.title; changedFields.push('title'); }
  if (data.description !== undefined) { updateValues.description = data.description; changedFields.push('description'); }
  if (data.phase_id !== undefined) { updateValues.phase_id = data.phase_id; changedFields.push('phase_id'); }
  if (data.state_id !== undefined) { updateValues.state_id = data.state_id; changedFields.push('state_id'); }
  if (data.sprint_id !== undefined) { updateValues.sprint_id = data.sprint_id; changedFields.push('sprint_id'); }
  if (data.epic_id !== undefined) { updateValues.epic_id = data.epic_id; changedFields.push('epic_id'); }
  if (data.assignee_id !== undefined) { updateValues.assignee_id = data.assignee_id; changedFields.push('assignee_id'); }
  if (data.priority !== undefined) { updateValues.priority = data.priority; changedFields.push('priority'); }
  if (data.story_points !== undefined) { updateValues.story_points = data.story_points; changedFields.push('story_points'); }
  if (data.time_estimate_minutes !== undefined) { updateValues.time_estimate_minutes = data.time_estimate_minutes; changedFields.push('time_estimate_minutes'); }
  if (data.start_date !== undefined) { updateValues.start_date = data.start_date; changedFields.push('start_date'); }
  if (data.due_date !== undefined) { updateValues.due_date = data.due_date; changedFields.push('due_date'); }
  if (data.label_ids !== undefined) { updateValues.labels = data.label_ids; changedFields.push('labels'); }
  if (data.parent_task_id !== undefined) {
    // Same recursion guard the POST /tasks/:id/parents path enforces — this
    // legacy field used to be writable unchecked, letting a task become a
    // child of its own descendant.
    if (data.parent_task_id !== null) {
      await assertNoParentCycle(taskId, data.parent_task_id);
    }
    updateValues.parent_task_id = data.parent_task_id;
    changedFields.push('parent_task_id');
  }
  if (data.custom_fields !== undefined) { updateValues.custom_fields = data.custom_fields; changedFields.push('custom_fields'); }

  // Links field (CSV-import plan Phase 0): the incoming array replaces the
  // stored one wholesale (same semantics as custom_fields). Normalize against
  // the EXISTING stored links (so provenance — added_by/added_at/fetched —
  // is only preserved for entries whose id was already present, never trusted
  // from the wire), then resolve internal suite titles org-scoped.
  let linkMirrors: TaskLinkMirror[] = [];
  let updateOrgId: string | null = null;
  let normalizedLinks: TaskLink[] = [];
  // Previous links (hoisted) so the post-write reconcile can prune
  // entity_links mirrors for internal links that this update removed.
  let previousLinks: TaskLink[] = [];
  if (data.links !== undefined) {
    const [existingRow] = await db
      .select({ links: tasks.links, project_id: tasks.project_id })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    const existingLinks = (existingRow?.links as TaskLink[] | undefined) ?? [];
    previousLinks = existingLinks;
    const normalized = normalizeTaskLinks(data.links, actorId ?? null, existingLinks);
    if (normalized.truncated) {
      console.warn('[task.service] task links truncated to cap:', { taskId });
    }
    updateOrgId = existingRow ? await getProjectOrgId(existingRow.project_id) : null;
    if (updateOrgId) {
      const resolved = await resolveInternalLinkTitles(normalized.links, updateOrgId);
      normalizedLinks = resolved.links;
      linkMirrors = resolved.mirrors;
    } else {
      normalizedLinks = normalized.links;
    }
    updateValues.links = normalizedLinks;
    changedFields.push('links');
  }

  // B3 Frndo Launch — Done-gate on direct phase updates. If the caller is
  // moving the task into a terminal phase via updateTask (not moveTask),
  // apply the same "all subtasks must be done" guard.
  if (data.phase_id !== undefined) {
    await assertSubtasksDoneBeforeTerminal(taskId, data.phase_id);
  }

  // Capture the pre-update dates so a whole-bar MOVE (both bounds shifted by the
  // same delta) can be told apart from a resize and slide the descendant subtree.
  let oldStartDate: string | null = null;
  let oldDueDate: string | null = null;
  if (data.start_date !== undefined || data.due_date !== undefined) {
    const [prevDates] = await db
      .select({ start_date: tasks.start_date, due_date: tasks.due_date })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    oldStartDate = prevDates?.start_date ?? null;
    oldDueDate = prevDates?.due_date ?? null;
  }

  const [task] = await db
    .update(tasks)
    .set(updateValues)
    .where(eq(tasks.id, taskId))
    .returning();

  // Broadcast realtime event
  if (task) {
    // Mirror resolved internal links into entity_links. Best-effort: the
    // canonical write (tasks.links) already landed.
    if (linkMirrors.length > 0 && updateOrgId) {
      try {
        await mirrorTaskEntityLinks(taskId, updateOrgId, actorId ?? null, linkMirrors);
      } catch (err) {
        console.error('[task.service] entity_links mirror failed:', { taskId, err });
      }
    }
    // Reconcile: when links changed, prune entity_links mirrors for internal
    // links this update removed (and that no remaining link still references),
    // so the cross-app graph doesn't accumulate stale edges. Best-effort.
    if (data.links !== undefined && updateOrgId) {
      try {
        await pruneRemovedTaskLinkMirrors(taskId, updateOrgId, previousLinks, linkMirrors);
      } catch (err) {
        console.error('[task.service] entity_links prune failed:', { taskId, err });
      }
    }
    // Queue async title fetch for links still untitled after internal
    // resolution (external URLs). Fire-and-forget; SSRF-guarded in worker.
    if (data.links !== undefined) {
      enqueueUntitledLinkFetches(taskId, normalizedLinks);
    }

    // Broadcast the CHANGES with links in their stored (normalized) shape —
    // raw `data.links` lacks the stamped id/added_at/title_source, so a
    // realtime client applying `changes` would otherwise see a different
    // shape than a refetch returns.
    const changes: Record<string, unknown> = { ...data };
    if (data.links !== undefined) changes.links = normalizedLinks;
    broadcastToProject(task.project_id, 'task.updated', {
      id: taskId,
      changes,
      task,
    });

    // Timeline rollup: if this edit moved either date, widen every ancestor so
    // each parent still encompasses this task. EXPAND-ONLY, runs AFTER the row
    // is written so the cascade reads the persisted bounds.
    if (changedFields.includes('start_date') || changedFields.includes('due_date')) {
      await expandParentsToEncompass(taskId, actorId);

      // Whole-bar MOVE: if BOTH bounds shifted by the SAME nonzero delta (dragging
      // the whole task, not resizing one edge), slide the entire descendant subtree
      // by that delta so children stay aligned under the parent. A resize (only one
      // bound changed, or unequal deltas) leaves children where they are.
      if (
        changedFields.includes('start_date') &&
        changedFields.includes('due_date') &&
        oldStartDate != null &&
        oldDueDate != null &&
        task.start_date != null &&
        task.due_date != null
      ) {
        const deltaStart = (Date.parse(task.start_date) - Date.parse(oldStartDate)) / 86_400_000;
        const deltaDue = (Date.parse(task.due_date) - Date.parse(oldDueDate)) / 86_400_000;
        if (deltaStart === deltaDue && deltaStart !== 0) {
          await shiftSubtreeDates(taskId, deltaStart, actorId);
        }
      }
    }

    // Log activity
    if (actorId) {
      logActivity(task.project_id, actorId, 'task.updated', taskId, { changed_fields: changedFields }, impersonatorId ?? null, viaSuperuserContext).catch(() => {});
    }

    // Blueprint↔Bam two-way sync: if title or description changed, push
    // the new value into every blueprint_node that references this task.
    // The blueprint-api endpoint writes raw (no service-layer round-trip)
    // so it never loops back here. Failures are swallowed because the
    // source-of-truth write already succeeded.
    if (data.title !== undefined || data.description !== undefined) {
      const payload: Record<string, unknown> = { task_id: taskId };
      if (data.title !== undefined) payload.title = data.title;
      if (data.description !== undefined) payload.description = data.description;
      const blueprintUrl =
        process.env.BLUEPRINT_API_INTERNAL_URL || 'http://blueprint-api:4015/v1';
      const secret = process.env.INTERNAL_SERVICE_SECRET ?? '';
      if (secret) {
        fetch(`${blueprintUrl}/internal/sync-from-task`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': secret,
          },
          body: JSON.stringify(payload),
        }).catch(() => {
          // Sync is best-effort; the canonical write already landed.
        });
      }
    }

    // Bolt workflow event (fire-and-forget)
    getProjectOrgId(task.project_id).then(async (orgId) => {
      if (!orgId) return;
      const [enriched, actor, org] = await Promise.all([
        enrichTask(task),
        loadActor(actorId),
        loadOrg(orgId),
      ]);
      publishBoltEvent(
        'task.updated',
        'bam',
        {
          task: enriched.task,
          changes: data,
          changed_fields: changedFields,
          project: enriched.project,
          phase: enriched.phase,
          sprint: enriched.sprint,
          epic: enriched.epic,
          assignee: enriched.assignee,
          reporter: enriched.reporter,
          actor,
          org,
        },
        orgId,
        actorId,
        actorId ? 'user' : 'system',
      );

      // Cross-product notification fan-out: when a task is assigned,
      // notify the new assignee via email + Banter DM (G6) and persist
      // a notification row via the notifications queue.
      if (
        data.assignee_id &&
        enriched.assignee &&
        data.assignee_id !== actorId
      ) {
        const notifTitle = `Task assigned: ${task.title}`;
        const notifBody = `${actor?.name ?? 'Someone'} assigned you to "${task.title}" in project ${enriched.project?.name ?? 'unknown'}.`;

        fanoutNotification(
          {
            recipient_user_id: data.assignee_id,
            recipient_email: enriched.assignee.email ?? undefined,
            subject: notifTitle,
            body: notifBody,
            url: `/b3/tasks/${task.id}`,
            org_id: orgId,
            actor_name: actor?.name ?? undefined,
          },
          ['email', 'banter_dm'],
        ).catch(() => {});

        enqueueNotification({
          user_id: data.assignee_id,
          project_id: task.project_id,
          task_id: task.id,
          type: 'task.assigned',
          category: 'assignment',
          source_app: 'bbb',
          title: notifTitle,
          body: notifBody,
          deep_link: `/b3/tasks/${task.id}`,
        }).catch(() => {});

        // Banter Feed: the new assignee gets a direct (Path A) entry. Assigned
        // is direct-only — no broad surfacing (§8).
        const nowIso = new Date().toISOString();
        enqueueFeedFanin({
          entity_type: 'bam.task',
          entity_id: task.id,
          source: 'bam',
          org_id: orgId,
          actor_id: actorId ?? null,
          project_id: task.project_id,
          published_at: nowIso,
          last_activity_at: nowIso,
          direct_recipients: [
            {
              user_id: data.assignee_id,
              relationship_flags: RELATIONSHIP_FLAGS.ASSIGNEE,
              category: 'bam.task.assigned_to_me',
            },
          ],
        }).catch(() => {});
      }
    }).catch(() => {});
  }

  return task ?? null;
}

export async function deleteTask(taskId: string, actorId?: string, impersonatorId?: string | null, viaSuperuserContext?: boolean) {
  // Soft delete by moving to a terminal state - or we do actual delete
  // For now, actually delete but handle subtask counts
  const task = await getTask(taskId);
  if (!task) return null;

  if (task.parent_task_id) {
    await db
      .update(tasks)
      .set({
        subtask_count: sql`greatest(${tasks.subtask_count} - 1, 0)`,
        updated_at: new Date(),
      })
      .where(eq(tasks.id, task.parent_task_id));
  }

  const [deleted] = await db
    .delete(tasks)
    .where(eq(tasks.id, taskId))
    .returning();

  // Broadcast realtime event
  if (deleted) {
    broadcastToProject(deleted.project_id, 'task.deleted', {
      id: taskId,
      task: deleted,
    });

    // Log activity
    if (actorId) {
      logActivity(deleted.project_id, actorId, 'task.deleted', null, { task_id: taskId, title: deleted.title }, impersonatorId ?? null, viaSuperuserContext).catch(() => {});
    }

    // Bolt workflow event (fire-and-forget)
    getProjectOrgId(deleted.project_id).then(async (orgId) => {
      if (!orgId) return;
      const [enriched, actor, org] = await Promise.all([
        enrichTask(deleted),
        loadActor(actorId),
        loadOrg(orgId),
      ]);
      publishBoltEvent(
        'task.deleted',
        'bam',
        {
          task_id: taskId,
          task: enriched.task,
          project: enriched.project,
          assignee: enriched.assignee,
          reporter: enriched.reporter,
          actor,
          org,
        },
        orgId,
        actorId,
        actorId ? 'user' : 'system',
      );
    }).catch(() => {});
  }

  return deleted ?? null;
}

export async function moveTask(taskId: string, data: MoveTaskInput, actorId?: string, impersonatorId?: string | null, viaSuperuserContext?: boolean) {
  // Get the task before move to know from_phase
  const existingTask = await getTask(taskId);

  const updateValues: Record<string, unknown> = {
    phase_id: data.phase_id,
    position: data.position,
    updated_at: new Date(),
  };

  if (data.sprint_id !== undefined) {
    updateValues.sprint_id = data.sprint_id;
  }

  // Check if phase has auto_state_on_enter
  const [phase] = await db
    .select()
    .from(phases)
    .where(eq(phases.id, data.phase_id))
    .limit(1);

  if (phase?.auto_state_on_enter) {
    updateValues.state_id = phase.auto_state_on_enter;
  }

  // B3 Frndo Launch — Done-gate. Refuse to move a task to a terminal phase
  // while any of its subtasks (legacy parent_task_id OR many-to-many
  // task_parent_links) are still open. The check is a no-op for non-
  // terminal phases and for tasks that already happen to be in a terminal
  // phase (re-entering Done from Done is fine).
  if (phase?.is_terminal && existingTask?.phase_id !== data.phase_id) {
    await assertSubtasksDoneBeforeTerminal(taskId, phase);
  }

  // If moving to terminal phase, set completed_at
  if (phase?.is_terminal) {
    updateValues.completed_at = new Date();
  } else {
    // Clear completed_at when leaving terminal phase
    updateValues.completed_at = null;
  }

  const [task] = await db
    .update(tasks)
    .set(updateValues)
    .where(eq(tasks.id, taskId))
    .returning();

  // Sync ticket status if this task is linked to a helpdesk ticket.
  //
  // HB-34 — Lossy phase→status mapping:
  // Helpdesk tickets have 5 statuses (open, in_progress, waiting_on_customer,
  // resolved, closed) but Bam phases only expose 3 categorical flags
  // (is_start, is_terminal, or neither). This path therefore collapses the
  // mapping to: is_terminal → resolved, is_start → open, else → in_progress.
  //
  // This means `waiting_on_customer` and `closed` CANNOT be set via Bam task
  // moves — they are reachable only through helpdesk-api directly. If an
  // agent sets a ticket to `waiting_on_customer` in the helpdesk UI and the
  // Bam task is then moved, this sync will overwrite it back to one of the
  // three mapped values. A richer mapping would require schema changes
  // (e.g. a phase→status lookup table) and is out of scope here.
  try {
    const ticketSync = await db
      .select()
      .from(tickets)
      .where(eq(tickets.task_id, taskId))
      .limit(1);

    if (ticketSync.length > 0) {
      const ticket = ticketSync[0]!;
      // Map phase to ticket status (lossy — see HB-34 note above)
      let newStatus = ticket.status;
      if (phase?.is_terminal) {
        newStatus = 'resolved';
      } else if (phase?.is_start) {
        newStatus = 'open';
      } else {
        newStatus = 'in_progress';
      }

      if (newStatus !== ticket.status) {
        const updates: Record<string, unknown> = { status: newStatus };
        if (newStatus === 'resolved') updates.resolved_at = new Date();

        await db.update(tickets).set(updates).where(eq(tickets.id, ticket.id));

        // HB-35 — Idempotent system messages:
        // Before inserting the status-change system message, check if an
        // identical one was already written for this ticket within the last
        // 60 seconds. This guards against duplicate messages caused by
        // retries, webhook replays, or rapid double-fires of the sync path.
        const messageBody = `Status changed to ${newStatus.replace('_', ' ')}`;
        const sixtySecondsAgo = new Date(Date.now() - 60_000);
        const [recentDuplicate] = await db
          .select({ id: ticketMessages.id })
          .from(ticketMessages)
          .where(
            and(
              eq(ticketMessages.ticket_id, ticket.id),
              eq(ticketMessages.author_type, 'system'),
              eq(ticketMessages.body, messageBody),
              gt(ticketMessages.created_at, sixtySecondsAgo),
            ),
          )
          .orderBy(desc(ticketMessages.created_at))
          .limit(1);

        if (!recentDuplicate) {
          await db.insert(ticketMessages).values({
            ticket_id: ticket.id,
            author_type: 'system',
            author_id: actorId ?? '00000000-0000-0000-0000-000000000000',
            author_name: 'System',
            body: messageBody,
            is_internal: false,
          });
        }

        // Broadcast the ticket status change so the helpdesk frontend
        // (subscribed to `ticket:{id}`) picks it up live.
        try {
          const publisher = getTicketEventPublisher();
          await publisher.publish(
            'bigbluebam:events',
            JSON.stringify({
              room: `ticket:${ticket.id}`,
              type: 'ticket.status.changed',
              payload: {
                ticket_id: ticket.id,
                status: newStatus,
                updated_at: new Date(),
              },
              triggeredBy: actorId,
            }),
          );
        } catch (err) {
          console.error('[task.service] Ticket event broadcast failed:', { taskId, ticketId: ticket.id, err });
        }
      }
    }
  } catch (err) {
    console.error('[task.service] Ticket sync failed:', { taskId, err });
  }

  // Broadcast realtime event
  if (task) {
    broadcastToProject(task.project_id, 'task.moved', {
      id: taskId,
      phase_id: data.phase_id,
      position: data.position,
      task,
    });

    // Log activity
    if (actorId) {
      logActivity(task.project_id, actorId, 'task.moved', taskId, {
        from_phase: existingTask?.phase_id,
        to_phase: data.phase_id,
      }, impersonatorId ?? null, viaSuperuserContext).catch(() => {});
    }

    // Slack outbound notification on entering a terminal phase.
    // Only fire when the task TRANSITIONED into terminal this move (i.e.
    // it wasn't already in a terminal phase) so we don't spam on reorders
    // within the Done column.
    if (phase?.is_terminal && existingTask && existingTask.phase_id !== data.phase_id) {
      postToSlack(task.project_id, {
        event_type: 'task.completed',
        text: `:white_check_mark: Task completed: *<${taskDeepLink(task.project_id, task.id)}|${task.human_id}>* — ${task.title}`,
      }).catch(() => {});
    }

    // Bolt workflow event (fire-and-forget)
    getProjectOrgId(task.project_id).then(async (orgId) => {
      if (!orgId) return;
      const [enriched, actor, org, fromPhase, toPhase] = await Promise.all([
        enrichTask(task),
        loadActor(actorId),
        loadOrg(orgId),
        loadPhase(existingTask?.phase_id ?? null),
        loadPhase(data.phase_id),
      ]);
      publishBoltEvent(
        'task.moved',
        'bam',
        {
          task: enriched.task,
          from_phase_id: existingTask?.phase_id ?? null,
          to_phase_id: data.phase_id,
          from_phase_name: fromPhase?.name ?? null,
          to_phase_name: toPhase?.name ?? null,
          project: enriched.project,
          sprint: enriched.sprint,
          assignee: enriched.assignee,
          actor,
          org,
        },
        orgId,
        actorId,
        actorId ? 'user' : 'system',
      );

      // Banter Feed: a state/phase change surfaces to the task's people (Path A)
      // and to project followers (Path B, §8 broad_surface=true).
      feedFaninForTask({
        taskId: task.id,
        category: 'bam.task.state_changed',
        actorId,
        orgId,
        projectId: task.project_id,
        broad: true,
      }).catch(() => {});
    }).catch(() => {});
  }

  return task ?? null;
}

export interface ListTasksFilters {
  sprint_id?: string;
  phase_id?: string;
  state_id?: string;
  assignee_id?: string;
  priority?: string;
  labels?: string[];
  search?: string;
  cursor?: string;
  limit?: number;
}

export async function listTasks(projectId: string, filters: ListTasksFilters) {
  const conditions = [eq(tasks.project_id, projectId)];

  if (filters.sprint_id) {
    conditions.push(eq(tasks.sprint_id, filters.sprint_id));
  }
  if (filters.phase_id) {
    conditions.push(eq(tasks.phase_id, filters.phase_id));
  }
  if (filters.state_id) {
    conditions.push(eq(tasks.state_id, filters.state_id));
  }
  if (filters.assignee_id) {
    conditions.push(eq(tasks.assignee_id, filters.assignee_id));
  }
  if (filters.priority) {
    conditions.push(eq(tasks.priority, filters.priority));
  }
  if (filters.search) {
    conditions.push(ilike(tasks.title, `%${escapeLike(filters.search)}%`));
  }
  if (filters.labels && filters.labels.length > 0) {
    conditions.push(sql`${tasks.labels} && ARRAY[${sql.join(filters.labels.map(l => sql`${l}::uuid`), sql`,`)}]`);
  }

  const limit = Math.min(filters.limit ?? 50, 200);

  if (filters.cursor) {
    conditions.push(gt(tasks.created_at, new Date(filters.cursor)));
  }

  const result = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.created_at))
    .limit(limit + 1);

  const hasMore = result.length > limit;
  const data = hasMore ? result.slice(0, limit) : result;
  const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.created_at.toISOString() : null;

  return {
    data,
    meta: {
      next_cursor: nextCursor,
      has_more: hasMore,
    },
  };
}

export async function getBoardState(projectId: string, sprintId?: string) {
  const projectPhases = await db
    .select()
    .from(phases)
    .where(eq(phases.project_id, projectId))
    .orderBy(asc(phases.position));

  const taskConditions = [eq(tasks.project_id, projectId)];
  if (sprintId) {
    taskConditions.push(eq(tasks.sprint_id, sprintId));
  }

  const allTasks = await db
    .select()
    .from(tasks)
    .where(and(...taskConditions))
    .orderBy(asc(tasks.position));

  // Enrich every task with its parents — union of the m2m join table and
  // the legacy parent_task_id pointer — as `{ id, human_id }[]`. Board
  // cards badge subtasks with their parents' ids, and the list view builds
  // its hierarchy from this, so it has to ride along with the board
  // payload rather than costing a request per task.
  const taskIds = allTasks.map((t) => t.id);
  const parentsByTask = new Map<string, { id: string; human_id: string | null }[]>();
  if (taskIds.length > 0) {
    const parentTasks = aliasedTable(tasks, 'parent_tasks');
    const linkRows = await db
      .select({
        task_id: taskParentLinks.task_id,
        parent_id: parentTasks.id,
        parent_human_id: parentTasks.human_id,
      })
      .from(taskParentLinks)
      .innerJoin(parentTasks, eq(parentTasks.id, taskParentLinks.parent_task_id))
      .where(inArray(taskParentLinks.task_id, taskIds));
    for (const row of linkRows) {
      const list = parentsByTask.get(row.task_id) ?? [];
      list.push({ id: row.parent_id, human_id: row.parent_human_id });
      parentsByTask.set(row.task_id, list);
    }
    // Legacy single-FK parents not yet mirrored into the join table.
    const humanIdById = new Map(allTasks.map((t) => [t.id, t.human_id] as const));
    const missingLegacyParentIds = new Set<string>();
    for (const task of allTasks) {
      if (!task.parent_task_id) continue;
      const list = parentsByTask.get(task.id) ?? [];
      if (list.some((p) => p.id === task.parent_task_id)) continue;
      if (!humanIdById.has(task.parent_task_id)) {
        missingLegacyParentIds.add(task.parent_task_id);
      }
    }
    if (missingLegacyParentIds.size > 0) {
      const extra = await db
        .select({ id: tasks.id, human_id: tasks.human_id })
        .from(tasks)
        .where(inArray(tasks.id, Array.from(missingLegacyParentIds)));
      for (const row of extra) humanIdById.set(row.id, row.human_id);
    }
    for (const task of allTasks) {
      if (!task.parent_task_id) continue;
      const list = parentsByTask.get(task.id) ?? [];
      if (!list.some((p) => p.id === task.parent_task_id)) {
        list.push({
          id: task.parent_task_id,
          human_id: humanIdById.get(task.parent_task_id) ?? null,
        });
        parentsByTask.set(task.id, list);
      }
    }
  }

  // Enrich every task with its epic mini-shape — { id, name, color } | null —
  // so board cards can render an epic chip without a per-task fetch. Same
  // Map pre-pass pattern as the `parents` enrichment above: one query over
  // the distinct epic_ids referenced by this project's tasks.
  const epicsById = new Map<string, { id: string; name: string; color: string | null }>();
  const epicIds = Array.from(
    new Set(allTasks.map((t) => t.epic_id).filter((id): id is string => id != null)),
  );
  if (epicIds.length > 0) {
    const epicRows = await db
      .select({ id: epics.id, name: epics.name, color: epics.color })
      .from(epics)
      .where(inArray(epics.id, epicIds));
    for (const row of epicRows) {
      epicsById.set(row.id, { id: row.id, name: row.name, color: row.color });
    }
  }

  const enrichedTasks = allTasks.map((task) => ({
    ...task,
    parents: parentsByTask.get(task.id) ?? [],
    epic: task.epic_id ? epicsById.get(task.epic_id) ?? null : null,
  }));

  // Group tasks by phase (skip tasks with null phase_id)
  const tasksByPhase = new Map<string, typeof enrichedTasks>();
  for (const task of enrichedTasks) {
    if (!task.phase_id) continue;
    const list = tasksByPhase.get(task.phase_id) ?? [];
    list.push(task);
    tasksByPhase.set(task.phase_id, list);
  }

  return projectPhases.map((phase) => ({
    ...phase,
    tasks: tasksByPhase.get(phase.id) ?? [],
  }));
}

export async function bulkOperations(data: BulkUpdateInput, _userId: string) {
  const results: Array<{ task_id: string; success: boolean; error?: string }> = [];

  for (const taskId of data.task_ids) {
    try {
      if (data.operation === 'update' && data.fields) {
        // Zod-validate the raw fields bag before it reaches updateTask — a
        // malformed link object (e.g. non-string url) would otherwise throw a
        // confusing "raw.url.trim is not a function" deep in normalization.
        await updateTask(taskId, updateTaskSchema.parse(data.fields));
        results.push({ task_id: taskId, success: true });
      } else if (data.operation === 'delete') {
        await deleteTask(taskId);
        results.push({ task_id: taskId, success: true });
      } else if (data.operation === 'move' && data.fields) {
        await moveTask(taskId, moveTaskSchema.parse(data.fields));
        results.push({ task_id: taskId, success: true });
      }
    } catch (err) {
      results.push({
        task_id: taskId,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return results;
}

export class TaskError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
