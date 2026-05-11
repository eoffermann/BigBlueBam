import type { FastifyInstance } from 'fastify';
import { eq, asc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { labels } from '../db/schema/labels.js';
import { projects } from '../db/schema/projects.js';
import { projectMemberships } from '../db/schema/project-memberships.js';
import { requireAuth, requireMinRole, requireScope } from '../plugins/auth.js';
import { requireProjectRole, requireProjectAccess, requireProjectAccessForEntity } from '../middleware/authorize.js';
import { dualReadGate } from '../middleware/dual-read.js';

export default async function labelRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/labels',
    { preHandler: [requireAuth, requireProjectAccess()] },
    async (request, reply) => {
      const result = await db
        .select()
        .from(labels)
        .where(eq(labels.project_id, request.params.id))
        .orderBy(asc(labels.position));

      return reply.send({ data: result });
    },
  );

  // Org-wide label listing used by the MCP resolver tool
  // `bam_list_labels` when no project_id is supplied. Returns labels
  // from every project the caller can see: all projects in the org for
  // normal members/admins/owners, only project-membership-scoped
  // projects for guests, and everything for superusers.
  fastify.get(
    '/labels',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      let projectIds: string[] = [];

      if (request.user!.is_superuser) {
        const rows = await db.select({ id: projects.id }).from(projects);
        projectIds = rows.map((r) => r.id);
      } else if (request.user!.role === 'guest') {
        const rows = await db
          .select({ project_id: projectMemberships.project_id })
          .from(projectMemberships)
          .where(eq(projectMemberships.user_id, request.user!.id));
        projectIds = rows.map((r) => r.project_id);
      } else {
        const rows = await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.org_id, request.user!.org_id));
        projectIds = rows.map((r) => r.id);
      }

      if (projectIds.length === 0) {
        return reply.send({ data: [] });
      }

      const result = await db
        .select({
          id: labels.id,
          project_id: labels.project_id,
          name: labels.name,
          color: labels.color,
          description: labels.description,
          position: labels.position,
        })
        .from(labels)
        .where(inArray(labels.project_id, projectIds))
        .orderBy(asc(labels.project_id), asc(labels.position));

      return reply.send({ data: result });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/labels',
    { preHandler: [requireAuth, requireProjectRole('admin', 'member'), dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.project_label.create' }), requireScope('read_write')] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().max(100),
        color: z.string().max(7).optional(),
        description: z.string().optional(),
        position: z.number().int().default(0),
      });
      const data = schema.parse(request.body);

      const [label] = await db
        .insert(labels)
        .values({
          project_id: request.params.id,
          name: data.name,
          color: data.color ?? null,
          description: data.description ?? null,
          position: data.position,
        })
        .returning();

      return reply.status(201).send({ data: label });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/labels/:id',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.label.update' }), requireScope('read_write'), requireProjectAccessForEntity('label')] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().max(100).optional(),
        color: z.string().max(7).nullable().optional(),
        description: z.string().nullable().optional(),
        position: z.number().int().optional(),
      });
      const data = schema.parse(request.body);

      const updateValues: Record<string, unknown> = { updated_at: new Date() };
      if (data.name !== undefined) updateValues.name = data.name;
      if (data.color !== undefined) updateValues.color = data.color;
      if (data.description !== undefined) updateValues.description = data.description;
      if (data.position !== undefined) updateValues.position = data.position;

      const [label] = await db
        .update(labels)
        .set(updateValues)
        .where(eq(labels.id, request.params.id))
        .returning();

      if (!label) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Label not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: label });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/labels/:id',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.label.delete' }), requireScope('read_write'), requireProjectAccessForEntity('label')] },
    async (request, reply) => {
      const [deleted] = await db
        .delete(labels)
        .where(eq(labels.id, request.params.id))
        .returning();

      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Label not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );
}
