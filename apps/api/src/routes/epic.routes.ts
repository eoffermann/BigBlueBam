import type { FastifyInstance } from 'fastify';
import { eq, sql, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { epics } from '../db/schema/epics.js';
import { tasks } from '../db/schema/tasks.js';
import { sprints } from '../db/schema/sprints.js';
import { phases } from '../db/schema/phases.js';
import { taskStates } from '../db/schema/task-states.js';
import { projects } from '../db/schema/projects.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireProjectAccess, requireProjectAccessForEntity } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { logActivity } from '../services/activity.service.js';
import { loadActor, loadOrg, epicUrl } from '../services/bolt-event-enricher.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';

/** Resolve the org that owns an epic's project. Used to scope the Bolt
 *  event and org-context enrichment on epic mutations. */
async function getEpicOrgId(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ org_id: projects.org_id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.org_id ?? null;
}

export default async function epicRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/epics',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_epic.get')] },
    async (request, reply) => {
      const result = await db
        .select({
          id: epics.id,
          project_id: epics.project_id,
          name: epics.name,
          description: epics.description,
          color: epics.color,
          start_date: epics.start_date,
          target_date: epics.target_date,
          status: epics.status,
          created_at: epics.created_at,
          updated_at: epics.updated_at,
          task_count: sql<number>`count(${tasks.id})::int`,
        })
        .from(epics)
        .leftJoin(tasks, eq(tasks.epic_id, epics.id))
        .where(eq(epics.project_id, request.params.id))
        .groupBy(epics.id)
        .orderBy(asc(epics.created_at));

      return reply.send({ data: result });
    },
  );

  // Epic detail + rollup over ALL tasks (parents AND subtasks) with
  // epic_id = :id. No dedicated `bam.epic.get` permission exists in the
  // catalog, so this gates on auth + project-access-for-entity + the same
  // read shadow key the list route uses (`bam.project_epic.get`).
  fastify.get<{ Params: { id: string } }>(
    '/epics/:id',
    {
      preHandler: [
        requireAuth,
        requireProjectAccessForEntity('epic'),
        shadowOnly('bam.project_epic.get'),
      ],
    },
    async (request, reply) => {
      const [epic] = await db
        .select()
        .from(epics)
        .where(eq(epics.id, request.params.id))
        .limit(1);

      if (!epic) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Epic not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const [rollup] = await db
        .select({
          task_count: sql<number>`count(${tasks.id})::int`,
          done_count: sql<number>`count(${tasks.completed_at})::int`,
          total_story_points: sql<number>`coalesce(sum(${tasks.story_points}), 0)::int`,
          done_story_points: sql<number>`coalesce(sum(${tasks.story_points}) filter (where ${tasks.completed_at} is not null), 0)::int`,
        })
        .from(tasks)
        .where(eq(tasks.epic_id, request.params.id));

      return reply.send({
        data: {
          ...epic,
          task_count: rollup?.task_count ?? 0,
          done_count: rollup?.done_count ?? 0,
          total_story_points: rollup?.total_story_points ?? 0,
          done_story_points: rollup?.done_story_points ?? 0,
        },
      });
    },
  );

  // All tasks assigned to the epic, ordered by sprint then position. Powers
  // the epic detail page's group-by-sprint list + burnup.
  fastify.get<{ Params: { id: string } }>(
    '/epics/:id/tasks',
    {
      preHandler: [
        requireAuth,
        requireProjectAccessForEntity('epic'),
        shadowOnly('bam.project_epic.get'),
      ],
    },
    async (request, reply) => {
      const rows = await db
        .select({
          id: tasks.id,
          human_id: tasks.human_id,
          title: tasks.title,
          parent_task_id: tasks.parent_task_id,
          sprint_id: tasks.sprint_id,
          sprint_name: sprints.name,
          phase_name: phases.name,
          state_category: taskStates.category,
          completed_at: tasks.completed_at,
          story_points: tasks.story_points,
        })
        .from(tasks)
        .leftJoin(sprints, eq(sprints.id, tasks.sprint_id))
        .leftJoin(phases, eq(phases.id, tasks.phase_id))
        .leftJoin(taskStates, eq(taskStates.id, tasks.state_id))
        .where(eq(tasks.epic_id, request.params.id))
        // Nulls-last on sprint so backlog tasks group at the end; then
        // float position for stable in-sprint ordering.
        .orderBy(sql`${tasks.sprint_id} asc nulls last`, asc(tasks.position));

      return reply.send({ data: rows });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/epics',
    { preHandler: [requireAuth, fastify.requireCan('bam.project_epic.create'), requireScope('read_write')] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().max(255),
        description: z.string().optional(),
        color: z.string().max(7).optional(),
        start_date: z.string().optional(),
        target_date: z.string().optional(),
        status: z.enum(['open', 'in_progress', 'closed']).default('open'),
      });
      const data = schema.parse(request.body);

      const [epic] = await db
        .insert(epics)
        .values({
          project_id: request.params.id,
          name: data.name,
          description: data.description ?? null,
          color: data.color ?? null,
          start_date: data.start_date ?? null,
          target_date: data.target_date ?? null,
          status: data.status,
        })
        .returning();

      const actorId = request.user!.id;

      // Activity log (entity 'epic'). The activity_log table is task-centric
      // (no entity_type column), so the epic id rides in `details` rather
      // than `task_id` — same shape as task.deleted, which also stows its
      // id in details. The 'epic.created' action carries the semantics.
      logActivity(
        epic!.project_id,
        actorId,
        'epic.created',
        null,
        { entity_type: 'epic', epic_id: epic!.id, name: epic!.name },
        request.impersonator?.id ?? null,
        request.viaSuperuserContext,
      ).catch(() => {});

      // Bolt workflow event (fire-and-forget).
      getEpicOrgId(epic!.project_id).then(async (orgId) => {
        if (!orgId) return;
        const [actor, org] = await Promise.all([loadActor(actorId), loadOrg(orgId)]);
        publishBoltEvent(
          'epic.created',
          'bam',
          {
            epic: {
              id: epic!.id,
              name: epic!.name,
              title: epic!.name,
              project_id: epic!.project_id,
              status: epic!.status,
              url: epicUrl(epic!.project_id, epic!.id),
            },
            project: { id: epic!.project_id },
            actor,
            org,
          },
          orgId,
          actorId,
          'user',
        );
      }).catch(() => {});

      return reply.status(201).send({ data: epic });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/epics/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.epic.update'), requireScope('read_write'), requireProjectAccessForEntity('epic')] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().max(255).optional(),
        description: z.string().nullable().optional(),
        color: z.string().max(7).nullable().optional(),
        start_date: z.string().nullable().optional(),
        target_date: z.string().nullable().optional(),
        status: z.enum(['open', 'in_progress', 'closed']).optional(),
      });
      const data = schema.parse(request.body);

      // Snapshot the prior status so we can detect a status transition for
      // the epic.status_changed event.
      const [prior] = await db
        .select({ status: epics.status })
        .from(epics)
        .where(eq(epics.id, request.params.id))
        .limit(1);

      const updateValues: Record<string, unknown> = { updated_at: new Date() };
      const changedFields: string[] = [];
      if (data.name !== undefined) { updateValues.name = data.name; changedFields.push('name'); }
      if (data.description !== undefined) { updateValues.description = data.description; changedFields.push('description'); }
      if (data.color !== undefined) { updateValues.color = data.color; changedFields.push('color'); }
      if (data.start_date !== undefined) { updateValues.start_date = data.start_date; changedFields.push('start_date'); }
      if (data.target_date !== undefined) { updateValues.target_date = data.target_date; changedFields.push('target_date'); }
      if (data.status !== undefined) { updateValues.status = data.status; changedFields.push('status'); }

      const [epic] = await db
        .update(epics)
        .set(updateValues)
        .where(eq(epics.id, request.params.id))
        .returning();

      if (!epic) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Epic not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const actorId = request.user!.id;
      const statusChanged =
        data.status !== undefined && prior !== undefined && prior.status !== data.status;

      // Activity log: always log the update; additionally log the status
      // transition when it changed.
      logActivity(
        epic.project_id,
        actorId,
        'epic.updated',
        null,
        { entity_type: 'epic', epic_id: epic.id, name: epic.name, changed_fields: changedFields },
        request.impersonator?.id ?? null,
        request.viaSuperuserContext,
      ).catch(() => {});

      if (statusChanged) {
        logActivity(
          epic.project_id,
          actorId,
          'epic.status_changed',
          null,
          {
            entity_type: 'epic',
            epic_id: epic.id,
            name: epic.name,
            old_status: prior!.status,
            new_status: data.status,
          },
          request.impersonator?.id ?? null,
          request.viaSuperuserContext,
        ).catch(() => {});
      }

      // Bolt workflow events (fire-and-forget).
      getEpicOrgId(epic.project_id).then(async (orgId) => {
        if (!orgId) return;
        const [actor, org] = await Promise.all([loadActor(actorId), loadOrg(orgId)]);
        const epicPayload = {
          id: epic.id,
          name: epic.name,
          title: epic.name,
          project_id: epic.project_id,
          status: epic.status,
          url: epicUrl(epic.project_id, epic.id),
        };

        publishBoltEvent(
          'epic.updated',
          'bam',
          {
            epic: epicPayload,
            changed_fields: changedFields,
            project: { id: epic.project_id },
            actor,
            org,
          },
          orgId,
          actorId,
          'user',
        );

        if (statusChanged) {
          publishBoltEvent(
            'epic.status_changed',
            'bam',
            {
              epic: epicPayload,
              old_status: prior!.status,
              new_status: data.status,
              project: { id: epic.project_id },
              actor,
              org,
            },
            orgId,
            actorId,
            'user',
          );
        }
      }).catch(() => {});

      return reply.send({ data: epic });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/epics/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.epic.delete'), requireScope('read_write'), requireProjectAccessForEntity('epic')] },
    async (request, reply) => {
      const [deleted] = await db
        .delete(epics)
        .where(eq(epics.id, request.params.id))
        .returning();

      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Epic not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );
}
