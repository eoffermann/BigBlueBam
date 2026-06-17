import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as fieldService from '../services/field.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const FIELD_TYPES = [
  'short_text', 'long_text', 'email', 'phone', 'url', 'number',
  'single_select', 'multi_select', 'dropdown',
  'date', 'time', 'datetime',
  'file_upload', 'image_upload',
  'rating', 'scale', 'nps',
  'checkbox', 'toggle',
  // Layout-only field types (no submitted answer). `page_break` is a
  // first-class type in the form builder: it splits the form into pages
  // and the renderer/validator treat it as non-input.
  'section_header', 'paragraph', 'hidden', 'page_break',
] as const;

const createFieldSchema = z.object({
  field_key: z.string().min(1).max(60).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'field_key must be a safe identifier (letters, digits, underscores; must start with letter or underscore)'),
  label: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  placeholder: z.string().max(255).optional(),
  field_type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  min_length: z.number().int().positive().optional(),
  max_length: z.number().int().positive().optional(),
  options: z.unknown().optional(),
  scale_min: z.number().int().optional(),
  scale_max: z.number().int().optional(),
  scale_min_label: z.string().max(100).optional(),
  scale_max_label: z.string().max(100).optional(),
  allowed_file_types: z.array(z.string()).optional(),
  max_file_size_mb: z.number().int().positive().optional(),
  conditional_on_field_id: z.string().uuid().optional(),
  conditional_operator: z.enum(['equals', 'not_equals', 'contains', 'gt', 'lt', 'is_set', 'is_not_set']).optional(),
  conditional_value: z.string().optional(),
  sort_order: z.number().int().optional(),
  page_number: z.number().int().positive().optional(),
  column_span: z.number().int().min(1).max(2).optional(),
  default_value: z.string().optional(),
});

const updateFieldSchema = z.object({
  field_key: z.string().min(1).max(60).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'field_key must be a safe identifier (letters, digits, underscores; must start with letter or underscore)').optional(),
  label: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).nullable().optional(),
  placeholder: z.string().max(255).nullable().optional(),
  field_type: z.enum(FIELD_TYPES).optional(),
  required: z.boolean().optional(),
  min_length: z.number().int().positive().nullable().optional(),
  max_length: z.number().int().positive().nullable().optional(),
  options: z.unknown().optional(),
  scale_min: z.number().int().optional(),
  scale_max: z.number().int().optional(),
  scale_min_label: z.string().max(100).nullable().optional(),
  scale_max_label: z.string().max(100).nullable().optional(),
  sort_order: z.number().int().optional(),
  page_number: z.number().int().positive().optional(),
  column_span: z.number().int().min(1).max(2).optional(),
  default_value: z.string().nullable().optional(),
});

const reorderSchema = z.object({
  fields: z.array(z.object({
    id: z.string().uuid(),
    sort_order: z.number().int(),
  })),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function fieldRoutes(fastify: FastifyInstance) {
  // POST /forms/:id/fields — Add a field
  fastify.post<{ Params: { id: string } }>(
    '/forms/:id/fields',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = createFieldSchema.parse(request.body);
      const field = await fieldService.addField(request.params.id, request.user!.org_id, body);
      return reply.status(201).send({ data: field });
    },
  );

  // PATCH /fields/:id — Update a field
  fastify.patch<{ Params: { id: string } }>(
    '/fields/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = updateFieldSchema.parse(request.body);
      const field = await fieldService.updateField(request.params.id, request.user!.org_id, body);
      return reply.send({ data: field });
    },
  );

  // DELETE /fields/:id — Remove a field
  fastify.delete<{ Params: { id: string } }>(
    '/fields/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      await fieldService.deleteField(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /forms/:id/fields/reorder — Bulk reorder fields
  fastify.post<{ Params: { id: string } }>(
    '/forms/:id/fields/reorder',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = reorderSchema.parse(request.body);
      const fields = await fieldService.reorderFields(
        request.params.id,
        request.user!.org_id,
        body.fields,
      );
      return reply.send({ data: fields });
    },
  );
}
