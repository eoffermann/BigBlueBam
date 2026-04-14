import type { FastifyInstance } from 'fastify';
import { eq, and, sql, asc } from 'drizzle-orm';
import { createSprintSchema, updateSprintSchema, completeSprintSchema } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { sprints } from '../db/schema/sprints.js';
import { tasks } from '../db/schema/tasks.js';
import { taskStates } from '../db/schema/task-states.js';
import { sprintTasks } from '../db/schema/sprint-tasks.js';
import { requireAuth, requireScope, requireMinRole } from '../plugins/auth.js';
import { requireProjectRole, requireProjectAccess, requireProjectAccessForEntity } from '../middleware/authorize.js';
import { postToSlack } from '../services/slack-notify.service.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import { loadActor, loadOrg, loadProjectContext } from '../services/bolt-event-enricher.service.js';
import { sprintUrl } from '../lib/urls.js';

export default async function sprintRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/sprints',
    { preHandler: [requireAuth, requireProjectAccess()] },
    async (request, reply) => {
      const projectSprints = await db
        .select()
        .from(sprints)
        .where(eq(sprints.project_id, request.params.id))
        .orderBy(asc(sprints.start_date));

      return reply.send({ data: projectSprints });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/sprints',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write'), requireProjectRole('admin')] },
    async (request, reply) => {
      const data = createSprintSchema.parse(request.body);

      const [sprint] = await db
        .insert(sprints)
        .values({
          project_id: request.params.id,
          name: data.name,
          goal: data.goal ?? null,
          status: 'planned',
          start_date: data.start_date,
          end_date: data.end_date,
        })
        .returning();

      return reply.status(201).send({ data: sprint });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/sprints/:id',
    { preHandler: [requireAuth, requireProjectAccessForEntity('sprint')] },
    async (request, reply) => {
      const [sprint] = await db
        .select()
        .from(sprints)
        .where(eq(sprints.id, request.params.id))
        .limit(1);

      if (!sprint) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Sprint not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: sprint });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/sprints/:id',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write'), requireProjectAccessForEntity('sprint')] },
    async (request, reply) => {
      const data = updateSprintSchema.parse(request.body);

      const updateValues: Record<string, unknown> = { updated_at: new Date() };
      if (data.name !== undefined) updateValues.name = data.name;
      if (data.goal !== undefined) updateValues.goal = data.goal;
      if (data.start_date !== undefined) updateValues.start_date = data.start_date;
      if (data.end_date !== undefined) updateValues.end_date = data.end_date;

      const [sprint] = await db
        .update(sprints)
        .set(updateValues)
        .where(eq(sprints.id, request.params.id))
        .returning();

      if (!sprint) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Sprint not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: sprint });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/sprints/:id/start',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write'), requireProjectAccessForEntity('sprint')] },
    async (request, reply) => {
      // BAM-024: Wrap status check + active-sprint check + update in a
      // transaction with SELECT ... FOR UPDATE to serialize concurrent starts.
      const result = await db.transaction(async (tx) => {
        // Lock the sprint row to prevent concurrent mutations
        const [sprint] = await tx.execute(
          sql`SELECT * FROM sprints WHERE id = ${request.params.id} FOR UPDATE`,
        ) as unknown as [typeof sprints.$inferSelect | undefined];

        if (!sprint) {
          return { error: 'NOT_FOUND' as const };
        }

        if (sprint.status !== 'planned') {
          return { error: 'INVALID_STATE' as const };
        }

        // Check no other active sprint in this project (lock those too)
        const activeRows = await tx.execute(
          sql`SELECT id FROM sprints WHERE project_id = ${sprint.project_id} AND status = 'active' FOR UPDATE`,
        ) as unknown as { id: string }[];

        if (activeRows.length > 0) {
          return { error: 'ACTIVE_SPRINT_EXISTS' as const };
        }

        const [updated] = await tx
          .update(sprints)
          .set({
            status: 'active',
            updated_at: new Date(),
          })
          .where(eq(sprints.id, request.params.id))
          .returning();

        return { data: updated };
      });

      if (result.error === 'NOT_FOUND') {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Sprint not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (result.error === 'INVALID_STATE') {
        return reply.status(400).send({
          error: {
            code: 'INVALID_STATE',
            message: 'Sprint can only be started from planned status',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (result.error === 'ACTIVE_SPRINT_EXISTS') {
        return reply.status(400).send({
          error: {
            code: 'ACTIVE_SPRINT_EXISTS',
            message: 'There is already an active sprint in this project',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Slack outbound notification (fire-and-forget)
      if (result.data) {
        postToSlack(result.data.project_id, {
          event_type: 'sprint.started',
          text: `:rocket: Sprint started: *${result.data.name}*${result.data.goal ? ` — ${result.data.goal}` : ''}`,
        }).catch(() => {});

        // Bolt workflow event (fire-and-forget)
        const startedSprint = result.data;
        (async () => {
          try {
            // Count tasks in the sprint at start time
            const taskCountRows = await db
              .select({ count: sql<number>`count(*)::int` })
              .from(tasks)
              .where(eq(tasks.sprint_id, startedSprint.id));
            const taskCount = Number(taskCountRows[0]?.count ?? 0);

            const [actor, org, project] = await Promise.all([
              loadActor(request.user!.id),
              loadOrg(request.user!.org_id),
              loadProjectContext(startedSprint.project_id),
            ]);

            await publishBoltEvent(
              'sprint.started',
              'bam',
              {
                sprint: {
                  id: startedSprint.id,
                  name: startedSprint.name,
                  project_id: startedSprint.project_id,
                  goal: startedSprint.goal,
                  start_date: startedSprint.start_date,
                  end_date: startedSprint.end_date,
                  status: startedSprint.status,
                  task_count: taskCount,
                  url: sprintUrl(startedSprint.project_id, startedSprint.id),
                },
                project,
                actor,
                org,
              },
              request.user!.org_id,
              request.user!.id,
              'user',
            );
          } catch {
            // fire-and-forget
          }
        })();
      }

      return reply.send({ data: result.data });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/sprints/:id/complete',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write'), requireProjectAccessForEntity('sprint')] },
    async (request, reply) => {
      const data = completeSprintSchema.parse(request.body);

      // BAM-023: Wrap the entire status check + carry-forward + velocity calc
      // in a single transaction with SELECT ... FOR UPDATE to serialize
      // concurrent completions on the same sprint.
      const result = await db.transaction(async (tx) => {
        // Lock the sprint row to prevent concurrent mutations
        const [sprint] = await tx.execute(
          sql`SELECT * FROM sprints WHERE id = ${request.params.id} FOR UPDATE`,
        ) as unknown as [typeof sprints.$inferSelect | undefined];

        if (!sprint) {
          return { error: 'NOT_FOUND' as const };
        }

        if (sprint.status !== 'active') {
          return { error: 'INVALID_STATE' as const };
        }

        // Process carry-forward tasks
        for (const item of data.carry_forward.tasks) {
          if (item.action === 'carry_forward') {
            await tx
              .update(tasks)
              .set({
                sprint_id: data.carry_forward.target_sprint_id,
                carry_forward_count: sql`${tasks.carry_forward_count} + 1`,
                original_sprint_id: sql`coalesce(${tasks.original_sprint_id}, ${request.params.id}::uuid)`,
                updated_at: new Date(),
              })
              .where(eq(tasks.id, item.task_id));

            // Create sprint_tasks record for carried forward task
            await tx
              .insert(sprintTasks)
              .values({
                sprint_id: request.params.id,
                task_id: item.task_id,
                removal_reason: 'carried_forward',
                removed_at: new Date(),
              })
              .onConflictDoUpdate({
                target: [sprintTasks.sprint_id, sprintTasks.task_id],
                set: {
                  removal_reason: 'carried_forward',
                  removed_at: new Date(),
                },
              });
          } else if (item.action === 'backlog') {
            await tx
              .update(tasks)
              .set({
                sprint_id: null,
                updated_at: new Date(),
              })
              .where(eq(tasks.id, item.task_id));

            // Create sprint_tasks record for descoped task
            await tx
              .insert(sprintTasks)
              .values({
                sprint_id: request.params.id,
                task_id: item.task_id,
                removal_reason: 'descoped',
                removed_at: new Date(),
              })
              .onConflictDoUpdate({
                target: [sprintTasks.sprint_id, sprintTasks.task_id],
                set: {
                  removal_reason: 'descoped',
                  removed_at: new Date(),
                },
              });
          }
          // 'cancel' - leave as-is in completed sprint
        }

        // Calculate velocity: sum story_points of tasks whose task_state has is_closed = true
        const closedTasksResult = await tx
          .select({
            story_points: tasks.story_points,
          })
          .from(tasks)
          .innerJoin(taskStates, eq(tasks.state_id, taskStates.id))
          .where(
            and(
              eq(tasks.sprint_id, request.params.id),
              eq(taskStates.is_closed, true),
            ),
          );

        const velocity = closedTasksResult.reduce(
          (sum, t) => sum + (t.story_points ?? 0),
          0,
        );
        const tasksCompletedCount = closedTasksResult.length;

        // Total tasks + committed story points across the whole sprint
        const allSprintTasks = await tx
          .select({ story_points: tasks.story_points })
          .from(tasks)
          .where(eq(tasks.sprint_id, request.params.id));
        const tasksTotal = allSprintTasks.length;
        const storyPointsCommitted = allSprintTasks.reduce(
          (sum, t) => sum + (t.story_points ?? 0),
          0,
        );

        // Carry-forward count from the request payload
        const carriedForwardCount = data.carry_forward.tasks.filter(
          (t) => t.action === 'carry_forward',
        ).length;

        // Complete the sprint with velocity
        const [completed] = await tx
          .update(sprints)
          .set({
            status: 'completed',
            velocity,
            closed_at: new Date(),
            notes: data.retrospective_notes ?? null,
            updated_at: new Date(),
          })
          .where(eq(sprints.id, request.params.id))
          .returning();

        return {
          data: completed,
          stats: {
            tasks_completed: tasksCompletedCount,
            tasks_total: tasksTotal,
            tasks_carried_forward: carriedForwardCount,
            story_points_completed: velocity,
            story_points_committed: storyPointsCommitted,
          },
        };
      });

      if (result.error === 'NOT_FOUND') {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Sprint not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (result.error === 'INVALID_STATE') {
        return reply.status(400).send({
          error: {
            code: 'INVALID_STATE',
            message: 'Sprint can only be completed from active status',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Slack outbound notification (fire-and-forget)
      if (result.data) {
        postToSlack(result.data.project_id, {
          event_type: 'sprint.completed',
          text: `:checkered_flag: Sprint completed: *${result.data.name}* — velocity: ${result.data.velocity ?? 0} pts`,
        }).catch(() => {});

        // Bolt workflow event (fire-and-forget)
        const completedSprint = result.data;
        const stats = result.stats!;
        (async () => {
          try {
            const [actor, org, project] = await Promise.all([
              loadActor(request.user!.id),
              loadOrg(request.user!.org_id),
              loadProjectContext(completedSprint.project_id),
            ]);

            await publishBoltEvent(
              'sprint.completed',
              'bam',
              {
                sprint: {
                  id: completedSprint.id,
                  name: completedSprint.name,
                  project_id: completedSprint.project_id,
                  goal: completedSprint.goal,
                  start_date: completedSprint.start_date,
                  end_date: completedSprint.end_date,
                  velocity: completedSprint.velocity,
                  status: completedSprint.status,
                  url: sprintUrl(completedSprint.project_id, completedSprint.id),
                },
                tasks_completed: stats.tasks_completed,
                tasks_carried_forward: stats.tasks_carried_forward,
                tasks_total: stats.tasks_total,
                story_points_completed: stats.story_points_completed,
                story_points_committed: stats.story_points_committed,
                project,
                actor,
                org,
              },
              request.user!.org_id,
              request.user!.id,
              'user',
            );
          } catch {
            // fire-and-forget
          }
        })();
      }

      return reply.send({ data: result.data });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/sprints/:id/cancel',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write'), requireProjectAccessForEntity('sprint')] },
    async (request, reply) => {
      const [sprint] = await db
        .select()
        .from(sprints)
        .where(eq(sprints.id, request.params.id))
        .limit(1);

      if (!sprint) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Sprint not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (sprint.status !== 'active' && sprint.status !== 'planned') {
        return reply.status(400).send({
          error: {
            code: 'INVALID_STATE',
            message: 'Sprint can only be cancelled from active or planned status',
            details: [],
            request_id: request.id,
          },
        });
      }

      await db.transaction(async (tx) => {
        // Move all tasks in this sprint to backlog (set sprint_id = null)
        await tx
          .update(tasks)
          .set({
            sprint_id: null,
            updated_at: new Date(),
          })
          .where(eq(tasks.sprint_id, request.params.id));

        // Cancel the sprint
        await tx
          .update(sprints)
          .set({
            status: 'cancelled',
            closed_at: new Date(),
            updated_at: new Date(),
          })
          .where(eq(sprints.id, request.params.id));
      });

      const [cancelled] = await db
        .select()
        .from(sprints)
        .where(eq(sprints.id, request.params.id))
        .limit(1);

      return reply.send({ data: cancelled });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/sprints/:id/report',
    { preHandler: [requireAuth, requireProjectAccessForEntity('sprint')] },
    async (request, reply) => {
      const [sprint] = await db
        .select()
        .from(sprints)
        .where(eq(sprints.id, request.params.id))
        .limit(1);

      if (!sprint) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Sprint not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Get tasks in this sprint
      const sprintTasks = await db
        .select()
        .from(tasks)
        .where(eq(tasks.sprint_id, request.params.id));

      // Get tasks that were originally in this sprint but carried forward
      const carriedForward = await db
        .select()
        .from(tasks)
        .where(eq(tasks.original_sprint_id, request.params.id));

      const totalTasks = sprintTasks.length;
      const completedTasks = sprintTasks.filter((t) => t.completed_at !== null).length;
      const totalPoints = sprintTasks.reduce((sum, t) => sum + (t.story_points ?? 0), 0);
      const completedPoints = sprintTasks
        .filter((t) => t.completed_at !== null)
        .reduce((sum, t) => sum + (t.story_points ?? 0), 0);

      return reply.send({
        data: {
          sprint,
          summary: {
            total_tasks: totalTasks,
            completed_tasks: completedTasks,
            total_story_points: totalPoints,
            completed_story_points: completedPoints,
            carried_forward_count: carriedForward.length,
            completion_percentage: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
          },
          tasks: sprintTasks,
        },
      });
    },
  );
}
