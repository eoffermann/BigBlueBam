import { eq, and, sql, ilike, asc, gt, desc } from 'drizzle-orm';
import Redis from 'ioredis';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { projects } from '../db/schema/projects.js';
import { phases } from '../db/schema/phases.js';
import { tickets, ticketMessages } from '../db/schema/tickets.js';
import type { CreateTaskInput, UpdateTaskInput, MoveTaskInput, BulkUpdateInput } from '@bigbluebam/shared';
import { broadcastToProject } from './realtime.service.js';
import { logActivity } from './activity.service.js';
import { postToSlack, taskDeepLink } from './slack-notify.service.js';
import { env } from '../env.js';
import { escapeLike } from '../lib/escape-like.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { enrichTask, loadActor, loadOrg, loadPhase } from './bolt-event-enricher.service.js';
import { fanoutNotification, enqueueNotification } from './notification-fanout.service.js';

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

  const [task] = await db
    .insert(tasks)
    .values({
      project_id: projectId,
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
      position: await getNextPosition(data.phase_id),
    })
    .returning();

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
  if (data.parent_task_id !== undefined) { updateValues.parent_task_id = data.parent_task_id; changedFields.push('parent_task_id'); }
  if (data.custom_fields !== undefined) { updateValues.custom_fields = data.custom_fields; changedFields.push('custom_fields'); }

  const [task] = await db
    .update(tasks)
    .set(updateValues)
    .where(eq(tasks.id, taskId))
    .returning();

  // Broadcast realtime event
  if (task) {
    broadcastToProject(task.project_id, 'task.updated', {
      id: taskId,
      changes: data,
      task,
    });

    // Log activity
    if (actorId) {
      logActivity(task.project_id, actorId, 'task.updated', taskId, { changed_fields: changedFields }, impersonatorId ?? null, viaSuperuserContext).catch(() => {});
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

  // Group tasks by phase (skip tasks with null phase_id)
  const tasksByPhase = new Map<string, typeof allTasks>();
  for (const task of allTasks) {
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
        await updateTask(taskId, data.fields as UpdateTaskInput);
        results.push({ task_id: taskId, success: true });
      } else if (data.operation === 'delete') {
        await deleteTask(taskId);
        results.push({ task_id: taskId, success: true });
      } else if (data.operation === 'move' && data.fields) {
        await moveTask(taskId, data.fields as MoveTaskInput);
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
