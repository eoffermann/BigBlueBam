import type { FastifyInstance } from 'fastify';
import { eq, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { customFieldDefinitions } from '../db/schema/custom-fields.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireProjectAccess, requireProjectAccessForEntity } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';

export default async function customFieldRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/custom-fields',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_custom_field.get')] },
    async (request, reply) => {
      const result = await db
        .select()
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.project_id, request.params.id))
        .orderBy(asc(customFieldDefinitions.position));

      return reply.send({ data: result });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/custom-fields',
    { preHandler: [requireAuth, fastify.requireCan('bam.project_custom_field.create'), requireScope('read_write')] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().max(255),
        field_type: z.enum(['text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url']),
        options: z.unknown().optional(),
        is_required: z.boolean().default(false),
        is_visible_on_card: z.boolean().default(false),
        position: z.number().int().default(0),
      });
      const data = schema.parse(request.body);

      const [field] = await db
        .insert(customFieldDefinitions)
        .values({
          project_id: request.params.id,
          name: data.name,
          field_type: data.field_type,
          options: data.options ?? null,
          is_required: data.is_required,
          is_visible_on_card: data.is_visible_on_card,
          position: data.position,
        })
        .returning();

      return reply.status(201).send({ data: field });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/custom-fields/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.custom_field.update'), requireScope('read_write'), requireProjectAccessForEntity('custom_field')] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().max(255).optional(),
        field_type: z.enum(['text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url']).optional(),
        options: z.unknown().optional(),
        is_required: z.boolean().optional(),
        is_visible_on_card: z.boolean().optional(),
        position: z.number().int().optional(),
      });
      const data = schema.parse(request.body);

      const updateValues: Record<string, unknown> = { updated_at: new Date() };
      if (data.name !== undefined) updateValues.name = data.name;
      if (data.field_type !== undefined) updateValues.field_type = data.field_type;
      if (data.options !== undefined) updateValues.options = data.options;
      if (data.is_required !== undefined) updateValues.is_required = data.is_required;
      if (data.is_visible_on_card !== undefined) updateValues.is_visible_on_card = data.is_visible_on_card;
      if (data.position !== undefined) updateValues.position = data.position;

      const [field] = await db
        .update(customFieldDefinitions)
        .set(updateValues)
        .where(eq(customFieldDefinitions.id, request.params.id))
        .returning();

      if (!field) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Custom field definition not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: field });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/custom-fields/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.custom_field.delete'), requireScope('read_write'), requireProjectAccessForEntity('custom_field')] },
    async (request, reply) => {
      const [deleted] = await db
        .delete(customFieldDefinitions)
        .where(eq(customFieldDefinitions.id, request.params.id))
        .returning();

      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Custom field definition not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );
}
