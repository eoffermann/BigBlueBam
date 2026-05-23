import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createTaskSchema, updateTaskSchema, moveTaskSchema, bulkUpdateSchema } from '@bigbluebam/shared';
import * as taskService from '../services/task.service.js';
import * as taskUpsertService from '../services/task-upsert.service.js';
import * as projectService from '../services/project.service.js';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { projects } from '../db/schema/projects.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireProjectAccess, requireProjectAccessForEntity } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';

export default async function taskRoutes(fastify: FastifyInstance) {
  fastify.get<{
    Params: { id: string };
    Querystring: {
      cursor?: string;
      limit?: string;
      'filter[sprint_id]'?: string;
      'filter[phase_id]'?: string;
      'filter[state_id]'?: string;
      'filter[assignee_id]'?: string;
      'filter[priority]'?: string;
      'filter[labels]'?: string;
      search?: string;
    };
  }>(
    '/projects/:id/tasks',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_task.get')] },
    async (request, reply) => {
      const query = request.query;
      const result = await taskService.listTasks(request.params.id, {
        sprint_id: query['filter[sprint_id]'],
        phase_id: query['filter[phase_id]'],
        state_id: query['filter[state_id]'],
        assignee_id: query['filter[assignee_id]'],
        priority: query['filter[priority]'],
        labels: query['filter[labels]']?.split(','),
        search: query.search,
        cursor: query.cursor,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
      });

      return reply.send(result);
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: { sprint_id?: string } }>(
    '/projects/:id/board',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_board.get')] },
    async (request, reply) => {
      const project = await projectService.getProject(request.params.id);
      if (!project) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Project not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Get active sprint for this project if no sprint_id specified
      let sprint = null;
      if (request.query.sprint_id) {
        const sprintResult = await projectService.getSprint(request.query.sprint_id);
        sprint = sprintResult;
      } else {
        sprint = await projectService.getActiveSprint(request.params.id);
      }

      const phasesWithTasks = await taskService.getBoardState(
        request.params.id,
        sprint?.id,
      );

      return reply.send({
        data: {
          project,
          phases: phasesWithTasks,
          sprint,
        },
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/tasks',
    { preHandler: [requireAuth, fastify.requireCan('bam.project_task.create'), requireScope('read_write')] },
    async (request, reply) => {
      const data = createTaskSchema.parse(request.body);

      try {
        const task = await taskService.createTask(
          request.params.id,
          data,
          request.user!.id,
          request.impersonator?.id ?? null,
          request.viaSuperuserContext,
        );
        return reply.status(201).send({ data: task });
      } catch (err) {
        if (err instanceof taskService.TaskError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  // POST /v1/tasks/upsert-by-external-id — idempotent intake for webhooks and
  // imports (AGENTIC_TODO §14 Wave 4). Natural key is (project_id,
  // external_id); the response envelope carries a `created` boolean so
  // retriable callers can log insert vs. update correctly. Backed by the
  // partial unique index from migration 0130.
  const taskUpsertBodySchema = z.object({
    project_id: z.string().uuid(),
    external_id: z.string().min(1).max(256),
    title: z.string().min(1).max(500),
    description: z.string().nullable().optional(),
    phase_id: z.string().uuid().nullable().optional(),
    state_id: z.string().uuid().nullable().optional(),
    sprint_id: z.string().uuid().nullable().optional(),
    epic_id: z.string().uuid().nullable().optional(),
    assignee_id: z.string().uuid().nullable().optional(),
    priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional(),
    story_points: z.number().int().positive().nullable().optional(),
    time_estimate_minutes: z.number().int().positive().nullable().optional(),
    start_date: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
    labels: z.array(z.string().uuid()).optional(),
    custom_fields: z.record(z.unknown()).optional(),
    parent_task_id: z.string().uuid().nullable().optional(),
  });
  fastify.post(
    '/v1/tasks/upsert-by-external-id',
    { preHandler: [requireAuth, fastify.requireCan('bam.task_upsert_by_external_id.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = taskUpsertBodySchema.parse(request.body);

      // Org + project access check. If the project belongs to another org,
      // reject with the standard 404 shape so we do not leak project IDs.
      const project = await projectService.getProject(body.project_id);
      if (!project || project.org_id !== request.user!.org_id) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Project not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      if (!request.user!.is_superuser) {
        const membership = await projectService.getProjectMembership(
          body.project_id,
          request.user!.id,
        );
        if (!membership) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Project not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      try {
        const result = await taskUpsertService.upsertTaskByExternalId(
          body,
          request.user!.id,
        );
        return reply.status(result.created ? 201 : 200).send(result);
      } catch (err) {
        if (err instanceof taskUpsertService.TaskUpsertError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  // Resolve a human-readable task ref (e.g. "MAGE-38") to its task id +
  // project id. Used by the cross-app task-reference linking: when Banter
  // renders "MAGE-38" as a link, it targets /b3/tasks/ref/MAGE-38 which
  // hits this endpoint (via a tiny frontend resolver page) and bounces
  // to the right project board with the task drawer open.
  fastify.get<{ Params: { ref: string } }>(
    '/tasks/by-ref/:ref',
    { preHandler: [requireAuth, shadowOnly('bam.task_by_ref.get')] },
    async (request, reply) => {
      // Normalize: uppercase prefix, drop accidental '#' / whitespace.
      const raw = request.params.ref.trim().replace(/^#/, '');
      const match = /^([A-Za-z]{2,10})-(\d+)$/.exec(raw);
      if (!match) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_REF',
            message: 'Task reference must look like PREFIX-123',
            details: [],
            request_id: request.id,
          },
        });
      }
      const humanId = `${match[1]!.toUpperCase()}-${match[2]!}`;
      const task = await taskService.getTaskByHumanId(humanId);
      if (!task) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Verify user has access to this task's project (org + membership)
      if (!request.user!.is_superuser) {
        const project = await projectService.getProject(task.project_id);
        if (!project || project.org_id !== request.user!.org_id) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Task not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        const membership = await projectService.getProjectMembership(
          task.project_id,
          request.user!.id,
        );
        if (!membership) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Task not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      return reply.send({
        data: {
          id: task.id,
          project_id: task.project_id,
          human_id: task.human_id,
          title: task.title,
        },
      });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id',
    { preHandler: [requireAuth, requireProjectAccessForEntity('task'), shadowOnly('bam.task.get')] },
    async (request, reply) => {
      const task = await taskService.getTask(request.params.id);
      if (!task) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!request.user!.is_superuser) {
        const membership = await projectService.getProjectMembership(
          task.project_id,
          request.user!.id,
        );
        if (!membership) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Task not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      return reply.send({ data: task });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/tasks/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.task.update'), requireScope('read_write'), requireProjectAccessForEntity('task')] },
    async (request, reply) => {
      const data = updateTaskSchema.parse(request.body);
      const task = await taskService.updateTask(request.params.id, data, request.user!.id, request.impersonator?.id ?? null, request.viaSuperuserContext);

      if (!task) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: task });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/tasks/:id/move',
    { preHandler: [requireAuth, fastify.requireCan('bam.task.move'), requireScope('read_write'), requireProjectAccessForEntity('task')] },
    async (request, reply) => {
      const data = moveTaskSchema.parse(request.body);
      const task = await taskService.moveTask(request.params.id, data, request.user!.id, request.impersonator?.id ?? null, request.viaSuperuserContext);

      if (!task) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: task });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/tasks/:id',
    {
      preHandler: [
        requireAuth,
        // Wave B sample: destructive verb + project-scoped entity check.
        fastify.requireCan('bam.task.delete'),
        requireScope('read_write'),
        requireProjectAccessForEntity('task'),
      ],
    },
    async (request, reply) => {
      const task = await taskService.deleteTask(request.params.id, request.user!.id, request.impersonator?.id ?? null, request.viaSuperuserContext);
      if (!task) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );

  fastify.post(
    '/tasks/bulk',
    { preHandler: [requireAuth, fastify.requireCan('bam.task_bulk.create'), requireScope('read_write')] },
    async (request, reply) => {
      const data = bulkUpdateSchema.parse(request.body);

      // Verify user has project access for every task in the bulk operation
      if (!request.user!.is_superuser && data.task_ids.length > 0) {
        const bulkTasks = await db
          .select({ id: tasks.id, project_id: tasks.project_id })
          .from(tasks)
          .where(sql`${tasks.id} = ANY(${data.task_ids})`);

        const uniqueProjectIds = [...new Set(bulkTasks.map((t) => t.project_id))];
        for (const pid of uniqueProjectIds) {
          const project = await projectService.getProject(pid);
          if (!project || project.org_id !== request.user!.org_id) {
            return reply.status(404).send({
              error: {
                code: 'NOT_FOUND',
                message: 'One or more tasks not found',
                details: [],
                request_id: request.id,
              },
            });
          }
          const membership = await projectService.getProjectMembership(pid, request.user!.id);
          if (!membership) {
            return reply.status(404).send({
              error: {
                code: 'NOT_FOUND',
                message: 'One or more tasks not found',
                details: [],
                request_id: request.id,
              },
            });
          }
        }
      }

      const results = await taskService.bulkOperations(data, request.user!.id);
      return reply.send({ data: results });
    },
  );

  // ── POST /tasks/:id/duplicate ─────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/tasks/:id/duplicate',
    { preHandler: [requireAuth, fastify.requireCan('bam.task.duplicate'), requireScope('read_write'), requireProjectAccessForEntity('task')] },
    async (request, reply) => {
      const bodySchema = z.object({
        include_subtasks: z.boolean().optional().default(false),
      });

      const { include_subtasks } = bodySchema.parse(request.body ?? {});

      const original = await taskService.getTask(request.params.id);
      if (!original) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Task not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Generate new human_id
      const [updated] = await db
        .update(projects)
        .set({
          task_id_sequence: sql`${projects.task_id_sequence} + 1`,
        })
        .where(eq(projects.id, original.project_id))
        .returning({
          task_id_prefix: projects.task_id_prefix,
          task_id_sequence: projects.task_id_sequence,
        });

      if (!updated) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Project not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const humanId = `${updated.task_id_prefix}-${updated.task_id_sequence}`;

      // Get next position
      const posResult = await db
        .select({ maxPos: sql<number>`coalesce(max(${tasks.position}), 0)` })
        .from(tasks)
        .where(eq(tasks.phase_id, original.phase_id!));

      const position = (posResult[0]?.maxPos ?? 0) + 1024;

      const [newTask] = await db
        .insert(tasks)
        .values({
          project_id: original.project_id,
          human_id: humanId,
          parent_task_id: original.parent_task_id,
          title: original.title,
          description: original.description,
          description_plain: original.description_plain,
          phase_id: original.phase_id,
          state_id: original.state_id,
          sprint_id: original.sprint_id,
          epic_id: original.epic_id,
          assignee_id: original.assignee_id,
          reporter_id: request.user!.id,
          priority: original.priority,
          story_points: original.story_points,
          time_estimate_minutes: original.time_estimate_minutes,
          start_date: original.start_date,
          due_date: original.due_date,
          position,
          labels: original.labels,
          watchers: [],
          is_blocked: false,
          blocking_task_ids: [],
          blocked_by_task_ids: [],
          custom_fields: original.custom_fields,
        })
        .returning();

      // Duplicate subtasks if requested
      if (include_subtasks && newTask) {
        const subtasks = await db
          .select()
          .from(tasks)
          .where(eq(tasks.parent_task_id, original.id));

        let subtaskCount = 0;
        for (const sub of subtasks) {
          const [subUpdated] = await db
            .update(projects)
            .set({
              task_id_sequence: sql`${projects.task_id_sequence} + 1`,
            })
            .where(eq(projects.id, original.project_id))
            .returning({
              task_id_prefix: projects.task_id_prefix,
              task_id_sequence: projects.task_id_sequence,
            });

          const subHumanId = `${subUpdated!.task_id_prefix}-${subUpdated!.task_id_sequence}`;

          const subPosResult = await db
            .select({ maxPos: sql<number>`coalesce(max(${tasks.position}), 0)` })
            .from(tasks)
            .where(eq(tasks.phase_id, sub.phase_id!));

          const subPosition = (subPosResult[0]?.maxPos ?? 0) + 1024;

          await db.insert(tasks).values({
            project_id: sub.project_id,
            human_id: subHumanId,
            parent_task_id: newTask.id,
            title: sub.title,
            description: sub.description,
            description_plain: sub.description_plain,
            phase_id: sub.phase_id,
            state_id: sub.state_id,
            sprint_id: sub.sprint_id,
            assignee_id: sub.assignee_id,
            reporter_id: request.user!.id,
            priority: sub.priority,
            story_points: sub.story_points,
            time_estimate_minutes: sub.time_estimate_minutes,
            start_date: sub.start_date,
            due_date: sub.due_date,
            position: subPosition,
            labels: sub.labels,
            custom_fields: sub.custom_fields,
          });

          subtaskCount++;
        }

        if (subtaskCount > 0) {
          await db
            .update(tasks)
            .set({ subtask_count: subtaskCount })
            .where(eq(tasks.id, newTask.id));
        }
      }

      // Re-fetch with updated counts
      const [finalTask] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, newTask!.id))
        .limit(1);

      return reply.status(201).send({ data: finalTask });
    },
  );
}
