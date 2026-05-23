import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as customFieldService from '../services/custom-field.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const entityTypes = ['contact', 'company', 'deal'] as const;
const fieldTypes = [
  'text', 'number', 'date', 'select', 'multi_select',
  'url', 'email', 'phone', 'boolean',
] as const;

const optionSchema = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
});

const createFieldSchema = z.object({
  entity_type: z.enum(entityTypes),
  field_key: z.string().min(1).max(60).regex(/^[a-z][a-z0-9_]*$/, {
    message: 'Field key must be lowercase alphanumeric with underscores, starting with a letter',
  }),
  label: z.string().min(1).max(100),
  field_type: z.enum(fieldTypes),
  options: z.array(optionSchema).optional(),
  required: z.boolean().optional(),
  sort_order: z.number().int().min(0).optional(),
});

const updateFieldSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  field_type: z.enum(fieldTypes).optional(),
  options: z.array(optionSchema).optional(),
  required: z.boolean().optional(),
  sort_order: z.number().int().min(0).optional(),
});

const listQuerySchema = z.object({
  entity_type: z.enum(entityTypes).optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function customFieldRoutes(fastify: FastifyInstance) {
  // GET /custom-field-definitions — List custom field definitions
  fastify.get(
    '/custom-field-definitions',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const fields = await customFieldService.listCustomFieldDefinitions(
        request.user!.org_id,
        query.entity_type,
      );
      return reply.send({ data: fields });
    },
  );

  // GET /custom-field-definitions/:id — Get a custom field definition
  fastify.get<{ Params: { id: string } }>(
    '/custom-field-definitions/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const field = await customFieldService.getCustomFieldDefinition(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: field });
    },
  );

  // POST /custom-field-definitions — Create a custom field definition
  fastify.post(
    '/custom-field-definitions',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bond.custom_field_definition.create'), requireScope('admin')],
    },
    async (request, reply) => {
      const body = createFieldSchema.parse(request.body);
      const field = await customFieldService.createCustomFieldDefinition(
        body,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: field });
    },
  );

  // PATCH /custom-field-definitions/:id — Update a custom field definition
  fastify.patch<{ Params: { id: string } }>(
    '/custom-field-definitions/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.custom_field_definition.update'), requireScope('admin')] },
    async (request, reply) => {
      const body = updateFieldSchema.parse(request.body);
      const field = await customFieldService.updateCustomFieldDefinition(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: field });
    },
  );

  // DELETE /custom-field-definitions/:id — Delete a custom field definition
  fastify.delete<{ Params: { id: string } }>(
    '/custom-field-definitions/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.custom_field_definition.delete'), requireScope('admin')] },
    async (request, reply) => {
      await customFieldService.deleteCustomFieldDefinition(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: { deleted: true } });
    },
  );
}
