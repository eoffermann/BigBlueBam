import type { FastifyInstance } from 'fastify';
import { eq, and, sql, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { taskTemplates } from '../db/schema/task-templates.js';
import { tasks } from '../db/schema/tasks.js';
import { phases } from '../db/schema/phases.js';
import { projects } from '../db/schema/projects.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireProjectAccess, requireProjectAccessForEntity } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';

async function generateHumanId(projectId: string): Promise<string> {
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

  if (!updated) throw new Error('Project not found');
  return `${updated.task_id_prefix}-${updated.task_id_sequence}`;
}

async function getNextPosition(phaseId: string): Promise<number> {
  const result = await db
    .select({ maxPos: sql<number>`coalesce(max(${tasks.position}), 0)` })
    .from(tasks)
    .where(eq(tasks.phase_id, phaseId));

  return (result[0]?.maxPos ?? 0) + 1024;
}

export default async function templateRoutes(fastify: FastifyInstance) {
  // ── GET /projects/:id/task-templates ──────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/task-templates',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_task_template.get')] },
    async (request, reply) => {
      const result = await db
        .select()
        .from(taskTemplates)
        .where(eq(taskTemplates.project_id, request.params.id))
        .orderBy(asc(taskTemplates.created_at));

      return reply.send({ data: result });
    },
  );

  // ── POST /projects/:id/task-templates ─────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/task-templates',
    { preHandler: [requireAuth, fastify.requireCan('bam.project_task_template.create'), requireScope('read_write')] },
    async (request, reply) => {
      const bodySchema = z.object({
        name: z.string().min(1).max(255),
        title_pattern: z.string().max(500).optional(),
        description: z.string().optional(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional().default('medium'),
        labels: z.array(z.string().uuid()).optional().default([]),
        phase_id: z.string().uuid().optional(),
        subtasks: z.array(z.string()).optional().default([]),
        story_points: z.number().int().positive().optional(),
      });

      const data = bodySchema.parse(request.body);

      const [template] = await db
        .insert(taskTemplates)
        .values({
          project_id: request.params.id,
          name: data.name,
          title_pattern: data.title_pattern ?? null,
          description: data.description ?? null,
          priority: data.priority,
          phase_id: data.phase_id ?? null,
          label_ids: data.labels,
          subtask_titles: data.subtasks,
          story_points: data.story_points ?? null,
          created_by: request.user!.id,
        })
        .returning();

      return reply.status(201).send({ data: template });
    },
  );

  // ── POST /projects/:id/task-templates/:templateId/apply ───────────────
  fastify.post<{ Params: { id: string; templateId: string } }>(
    '/projects/:id/task-templates/:templateId/apply',
    { preHandler: [requireAuth, fastify.requireCan('bam.project_task_template_apply.create'), requireScope('read_write')] },
    async (request, reply) => {
      const overrideSchema = z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        assignee_id: z.string().uuid().optional(),
        sprint_id: z.string().uuid().optional(),
        due_date: z.string().optional(),
      }).optional().default({});

      const overrides = overrideSchema.parse(request.body);
      const projectId = request.params.id;

      const [template] = await db
        .select()
        .from(taskTemplates)
        .where(
          and(
            eq(taskTemplates.id, request.params.templateId),
            eq(taskTemplates.project_id, projectId),
          ),
        )
        .limit(1);

      if (!template) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Template not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Resolve phase: use template phase, or default phase
      let phaseId = template.phase_id;
      if (!phaseId) {
        const [defaultPhase] = await db
          .select()
          .from(phases)
          .where(and(eq(phases.project_id, projectId), eq(phases.is_start, true)))
          .limit(1);

        if (!defaultPhase) {
          const [firstPhase] = await db
            .select()
            .from(phases)
            .where(eq(phases.project_id, projectId))
            .orderBy(asc(phases.position))
            .limit(1);

          phaseId = firstPhase?.id ?? null;
        } else {
          phaseId = defaultPhase.id;
        }
      }

      if (!phaseId) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'No phase available for task creation',
            details: [],
            request_id: request.id,
          },
        });
      }

      const humanId = await generateHumanId(projectId);
      const position = await getNextPosition(phaseId);

      const [task] = await db
        .insert(tasks)
        .values({
          project_id: projectId,
          human_id: humanId,
          title: overrides.title ?? template.title_pattern ?? template.name,
          description: overrides.description ?? template.description ?? null,
          phase_id: phaseId,
          assignee_id: overrides.assignee_id ?? null,
          reporter_id: request.user!.id,
          priority: overrides.priority ?? template.priority ?? 'medium',
          story_points: template.story_points ?? null,
          sprint_id: overrides.sprint_id ?? null,
          due_date: overrides.due_date ?? null,
          labels: template.label_ids ?? [],
          position,
        })
        .returning();

      // Create subtasks from template
      if (task && template.subtask_titles && template.subtask_titles.length > 0) {
        let subtaskCount = 0;
        for (const subtaskTitle of template.subtask_titles) {
          const subHumanId = await generateHumanId(projectId);
          const subPosition = await getNextPosition(phaseId);

          await db.insert(tasks).values({
            project_id: projectId,
            human_id: subHumanId,
            parent_task_id: task.id,
            title: subtaskTitle,
            phase_id: phaseId,
            reporter_id: request.user!.id,
            priority: 'medium',
            position: subPosition,
          });

          subtaskCount++;
        }

        await db
          .update(tasks)
          .set({ subtask_count: subtaskCount })
          .where(eq(tasks.id, task.id));
      }

      // Re-fetch the task with updated subtask_count
      const [finalTask] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, task!.id))
        .limit(1);

      return reply.status(201).send({ data: finalTask });
    },
  );

  // ── DELETE /task-templates/:id ────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/task-templates/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.task_template.delete'), requireScope('read_write'), requireProjectAccessForEntity('task_template')] },
    async (request, reply) => {
      const [deleted] = await db
        .delete(taskTemplates)
        .where(eq(taskTemplates.id, request.params.id))
        .returning();

      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Template not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );
}
