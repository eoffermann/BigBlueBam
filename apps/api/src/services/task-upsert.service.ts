// ---------------------------------------------------------------------------
// task_upsert_by_external_id service (AGENTIC_TODO §14 Wave 4)
//
// Idempotent create-or-update on (project_id, external_id). Natural key is
// backed by the partial unique index `tasks_project_external_id_uniq` from
// migration 0130 (WHERE external_id IS NOT NULL). Returns the full task row
// plus a `created` boolean so callers (webhooks, import pipelines, MCP tool)
// can log retries correctly.
//
// We issue the upsert in two phases instead of one raw-SQL `INSERT ... ON
// CONFLICT ... RETURNING *, (xmax = 0) AS created` statement so we can stay
// inside Drizzle's typed query builder. The pre-check also lets us skip
// bumping projects.task_id_sequence on update-path retries (every retry
// would otherwise waste a human_id).
// ---------------------------------------------------------------------------

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { projects } from '../db/schema/projects.js';
import { phases } from '../db/schema/phases.js';
import { broadcastToProject } from './realtime.service.js';
import { logActivity } from './activity.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { enrichTask, loadActor, loadOrg } from './bolt-event-enricher.service.js';

export class TaskUpsertError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'TaskUpsertError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface TaskUpsertInput {
  project_id: string;
  external_id: string;
  title: string;
  description?: string | null;
  phase_id?: string | null;
  state_id?: string | null;
  sprint_id?: string | null;
  epic_id?: string | null;
  assignee_id?: string | null;
  priority?: string;
  story_points?: number | null;
  time_estimate_minutes?: number | null;
  start_date?: string | null;
  due_date?: string | null;
  labels?: string[];
  custom_fields?: Record<string, unknown>;
  parent_task_id?: string | null;
}

export interface TaskUpsertResult {
  data: typeof tasks.$inferSelect;
  created: boolean;
  idempotency_key: string;
}

async function getNextPosition(phaseId: string): Promise<number> {
  const result = await db
    .select({ maxPos: sql<number>`coalesce(max(${tasks.position}), 0)` })
    .from(tasks)
    .where(eq(tasks.phase_id, phaseId));
  return (result[0]?.maxPos ?? 0) + 1024;
}

/**
 * Upsert a task by (project_id, external_id). Insert path allocates a new
 * human_id from projects.task_id_sequence; update path leaves human_id alone
 * so existing references (links, activity rows) still resolve.
 */
export async function upsertTaskByExternalId(
  input: TaskUpsertInput,
  reporterId: string,
): Promise<TaskUpsertResult> {
  if (!input.external_id || input.external_id.trim() === '') {
    throw new TaskUpsertError(
      'VALIDATION_ERROR',
      'external_id is required and must be non-empty',
      400,
    );
  }
  if (!input.title || input.title.trim() === '') {
    throw new TaskUpsertError(
      'VALIDATION_ERROR',
      'title is required and must be non-empty',
      400,
    );
  }

  // Pre-check: does a row already exist? If so we can skip the human_id
  // allocation (which would otherwise bump projects.task_id_sequence on
  // every webhook retry even though the row is just being updated).
  const [existing] = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.project_id, input.project_id),
        eq(tasks.external_id, input.external_id),
      ),
    )
    .limit(1);

  if (!existing) {
    // Insert path requires a phase_id. If the caller omits one, pick the
    // project's first phase (by position) so intake from webhooks works
    // even when the upstream source has no phase concept.
    let resolvedPhaseId = input.phase_id ?? null;
    let resolvedStateId = input.state_id ?? null;
    if (!resolvedPhaseId) {
      const [firstPhase] = await db
        .select({ id: phases.id, auto_state_on_enter: phases.auto_state_on_enter })
        .from(phases)
        .where(eq(phases.project_id, input.project_id))
        .orderBy(phases.position)
        .limit(1);
      if (!firstPhase) {
        throw new TaskUpsertError(
          'VALIDATION_ERROR',
          'project has no phases; cannot insert task without phase_id',
          400,
        );
      }
      resolvedPhaseId = firstPhase.id;
      if (!resolvedStateId && firstPhase.auto_state_on_enter) {
        resolvedStateId = firstPhase.auto_state_on_enter;
      }
    } else if (!resolvedStateId) {
      const [phase] = await db
        .select({ auto_state_on_enter: phases.auto_state_on_enter })
        .from(phases)
        .where(eq(phases.id, resolvedPhaseId))
        .limit(1);
      if (phase?.auto_state_on_enter) {
        resolvedStateId = phase.auto_state_on_enter;
      }
    }

    // Allocate a human_id atomically from the project sequence.
    const [updated] = await db
      .update(projects)
      .set({ task_id_sequence: sql`${projects.task_id_sequence} + 1` })
      .where(eq(projects.id, input.project_id))
      .returning({
        task_id_prefix: projects.task_id_prefix,
        task_id_sequence: projects.task_id_sequence,
      });
    if (!updated) {
      throw new TaskUpsertError('NOT_FOUND', 'Project not found', 404);
    }
    const humanId = `${updated.task_id_prefix}-${updated.task_id_sequence}`;

    // Resolve the project's owning org so the inserted task carries org_id
    // (Bench analytics + RLS gate). Webhook/import callers never pass it.
    const [orgRow] = await db
      .select({ org_id: projects.org_id })
      .from(projects)
      .where(eq(projects.id, input.project_id))
      .limit(1);
    const upsertOrgId = orgRow?.org_id ?? null;

    // Insert with ON CONFLICT for race safety. If another writer inserted
    // the same (project_id, external_id) tuple between our pre-check and
    // the insert, the conflict branch updates the title/description so the
    // caller still gets a consistent row. `xmax = 0` tells us which branch
    // fired: new inserts have xmax = 0; updated-by-conflict rows do not.
    {
      const inserted = await db
        .insert(tasks)
        .values({
          project_id: input.project_id,
          org_id: upsertOrgId,
          human_id: humanId,
          external_id: input.external_id,
          title: input.title,
          description: input.description ?? null,
          phase_id: resolvedPhaseId,
          state_id: resolvedStateId,
          sprint_id: input.sprint_id ?? null,
          epic_id: input.epic_id ?? null,
          assignee_id: input.assignee_id ?? null,
          reporter_id: reporterId,
          priority: input.priority ?? 'medium',
          story_points: input.story_points ?? null,
          time_estimate_minutes: input.time_estimate_minutes ?? null,
          start_date: input.start_date ?? null,
          due_date: input.due_date ?? null,
          labels: input.labels ?? [],
          custom_fields: input.custom_fields ?? {},
          parent_task_id: input.parent_task_id ?? null,
          position: await getNextPosition(resolvedPhaseId),
        })
        .onConflictDoUpdate({
          target: [tasks.project_id, tasks.external_id],
          targetWhere: isNotNull(tasks.external_id),
          set: {
            title: input.title,
            description: input.description ?? null,
            updated_at: new Date(),
          },
        })
        .returning({
          // Table-as-field cast (same as beacon-api/bond-api/helpdesk-api
          // upsert services) to satisfy drizzle's returning() type under
          // @bigbluebam/db-stubs.
          task: tasks as unknown as import('drizzle-orm').SQL<typeof tasks.$inferSelect>,
          // xmax = 0 on a fresh insert; non-zero when ON CONFLICT fired.
          created: sql<boolean>`(xmax = 0)`.as('created'),
        });

      const row = inserted[0];
      if (!row) {
        throw new TaskUpsertError('INTERNAL', 'Upsert returned no row', 500);
      }
      const task = row.task as typeof tasks.$inferSelect;
      const created = row.created === true;

      broadcastToProject(
        input.project_id,
        created ? 'task.created' : 'task.updated',
        task,
        reporterId,
      );
      logActivity(
        input.project_id,
        reporterId,
        created ? 'task.created' : 'task.updated',
        task.id,
        { title: input.title, external_id: input.external_id, via_upsert: true },
      ).catch(() => {});

      void publishBoltEventForUpsert(task, reporterId, created);

      return {
        data: task,
        created,
        idempotency_key: `external_id:${input.project_id}:${input.external_id}`,
      };
    }
  }

  // Update path: existing row with same (project_id, external_id).
  const updateValues: Record<string, unknown> = {
    updated_at: new Date(),
  };
  if (input.title !== undefined) updateValues.title = input.title;
  if (input.description !== undefined) updateValues.description = input.description;
  if (input.phase_id !== undefined && input.phase_id !== null) updateValues.phase_id = input.phase_id;
  if (input.state_id !== undefined) updateValues.state_id = input.state_id;
  if (input.sprint_id !== undefined) updateValues.sprint_id = input.sprint_id;
  if (input.epic_id !== undefined) updateValues.epic_id = input.epic_id;
  if (input.assignee_id !== undefined) updateValues.assignee_id = input.assignee_id;
  if (input.priority !== undefined) updateValues.priority = input.priority;
  if (input.story_points !== undefined) updateValues.story_points = input.story_points;
  if (input.time_estimate_minutes !== undefined) updateValues.time_estimate_minutes = input.time_estimate_minutes;
  if (input.start_date !== undefined) updateValues.start_date = input.start_date;
  if (input.due_date !== undefined) updateValues.due_date = input.due_date;
  if (input.labels !== undefined) updateValues.labels = input.labels;
  if (input.custom_fields !== undefined) updateValues.custom_fields = input.custom_fields;
  if (input.parent_task_id !== undefined) updateValues.parent_task_id = input.parent_task_id;

  const [task] = await db
    .update(tasks)
    .set(updateValues)
    .where(eq(tasks.id, existing.id))
    .returning();

  if (!task) {
    throw new TaskUpsertError('INTERNAL', 'Update returned no row', 500);
  }

  broadcastToProject(input.project_id, 'task.updated', task);
  logActivity(
    input.project_id,
    reporterId,
    'task.updated',
    task.id,
    { external_id: input.external_id, via_upsert: true },
  ).catch(() => {});

  void publishBoltEventForUpsert(task, reporterId, false);

  return {
    data: task,
    created: false,
    idempotency_key: `external_id:${input.project_id}:${input.external_id}`,
  };
}

/** Publish task.upserted to Bolt. Fire-and-forget; never throws upstream. */
async function publishBoltEventForUpsert(
  task: typeof tasks.$inferSelect,
  actorId: string,
  created: boolean,
): Promise<void> {
  try {
    const [row] = await db
      .select({ org_id: projects.org_id })
      .from(projects)
      .where(eq(projects.id, task.project_id))
      .limit(1);
    const orgId = row?.org_id ?? null;
    if (!orgId) return;
    const [enriched, actor, org] = await Promise.all([
      enrichTask(task),
      loadActor(actorId),
      loadOrg(orgId),
    ]);
    await publishBoltEvent(
      'task.upserted',
      'bam',
      {
        task: enriched.task,
        project: enriched.project,
        phase: enriched.phase,
        sprint: enriched.sprint,
        epic: enriched.epic,
        assignee: enriched.assignee,
        reporter: enriched.reporter,
        created,
        actor,
        org,
      },
      orgId,
      actorId,
      'user',
    );
  } catch {
    // Fire-and-forget.
  }
}
