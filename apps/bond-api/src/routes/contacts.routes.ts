import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as contactService from '../services/contact.service.js';
import * as contactUpsertService from '../services/contact-upsert.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const lifecycleStages = [
  'subscriber', 'lead', 'marketing_qualified', 'sales_qualified',
  'opportunity', 'customer', 'evangelist', 'other',
] as const;

const createContactSchema = z.object({
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(150).optional(),
  avatar_url: z.string().url().optional(),
  lifecycle_stage: z.enum(lifecycleStages).optional(),
  lead_source: z.string().max(60).optional(),
  address_line1: z.string().max(255).optional(),
  address_line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state_region: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  country: z.string().length(2).optional(),
  custom_fields: z.record(z.unknown()).optional(),
  owner_id: z.string().uuid().optional(),
});

const updateContactSchema = createContactSchema.partial();

const mergeContactSchema = z.object({
  source_id: z.string().uuid(),
});

const importContactsSchema = z.object({
  contacts: z.array(createContactSchema).min(1).max(5000),
});

// AGENTIC_TODO §14 Wave 4: idempotent create-or-update by email.
// `email` is required (unlike create, where it is optional) because it is
// the natural key of the upsert.
const upsertContactSchema = z.object({
  email: z.string().email().max(255),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(150).optional(),
  avatar_url: z.string().url().optional(),
  lifecycle_stage: z.enum(lifecycleStages).optional(),
  lead_source: z.string().max(60).optional(),
  address_line1: z.string().max(255).optional(),
  address_line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state_region: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  country: z.string().length(2).optional(),
  custom_fields: z.record(z.unknown()).optional(),
  owner_id: z.string().uuid().optional(),
});

const listQuerySchema = z.object({
  lifecycle_stage: z.string().optional(),
  lead_source: z.string().optional(),
  owner_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  lead_score_min: z.coerce.number().int().optional(),
  lead_score_max: z.coerce.number().int().optional(),
  search: z.string().max(200).optional(),
  include_deleted: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sort: z.string().optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function contactRoutes(fastify: FastifyInstance) {
  // GET /contacts — List contacts
  fastify.get(
    '/contacts',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      // "Own only" visibility: members and viewers only see contacts they own
      const role = request.user!.role;
      const isRestrictedRole = role === 'member' || role === 'viewer';
      const result = await contactService.listContacts({
        organization_id: request.user!.org_id,
        ...query,
        include_deleted: query.include_deleted === 'true',
        visibility_owner_id: isRestrictedRole ? request.user!.id : undefined,
      });
      return reply.send(result);
    },
  );

  // POST /contacts — Create contact
  fastify.post(
    '/contacts',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bond.contact.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const body = createContactSchema.parse(request.body);
      const contact = await contactService.createContact(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: contact });
    },
  );

  // GET /contacts/search — Search contacts
  fastify.get(
    '/contacts/search',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const query = searchQuerySchema.parse(request.query);
      const results = await contactService.searchContacts(
        request.user!.org_id,
        query.q,
        query.limit,
      );
      return reply.send({ data: results });
    },
  );

  // POST /contacts/upsert — Idempotent create-or-update by email
  // (AGENTIC_TODO §14 Wave 4). Returns { data, created, idempotency_key }.
  // Natural key is (organization_id, lower(email)); soft-deleted rows are
  // resurrected on match.
  fastify.post(
    '/contacts/upsert',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bond.contact.upsert'), requireScope('read_write')],
    },
    async (request, reply) => {
      const body = upsertContactSchema.parse(request.body);
      const result = await contactUpsertService.upsertContactByEmail(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(result.created ? 201 : 200).send(result);
    },
  );

  // POST /contacts/import — Bulk import
  fastify.post(
    '/contacts/import',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bond.contact.import'), requireScope('admin')],
    },
    async (request, reply) => {
      const body = importContactsSchema.parse(request.body);
      const result = await contactService.importContacts(
        body.contacts,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.send({ data: result });
    },
  );

  // GET /contacts/export — Export contacts
  fastify.get(
    '/contacts/export',
    { preHandler: [requireAuth, fastify.requireCan('bond.contact.list')] },
    async (request, reply) => {
      const data = await contactService.exportContacts(request.user!.org_id);
      return reply.send({ data });
    },
  );

  // GET /contacts/:id — Get contact detail
  fastify.get<{ Params: { id: string } }>(
    '/contacts/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const contact = await contactService.getContact(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: contact });
    },
  );

  // PATCH /contacts/:id — Update contact
  fastify.patch<{ Params: { id: string } }>(
    '/contacts/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.contact.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateContactSchema.parse(request.body);
      const contact = await contactService.updateContact(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: contact });
    },
  );

  // DELETE /contacts/:id — Delete contact
  fastify.delete<{ Params: { id: string } }>(
    '/contacts/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.contact.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await contactService.deleteContact(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /contacts/:id/restore — Undelete a soft-deleted contact (G4)
  fastify.post<{ Params: { id: string } }>(
    '/contacts/:id/restore',
    { preHandler: [requireAuth, fastify.requireCan('bond.contact.restore'), requireScope('read_write')] },
    async (request, reply) => {
      const contact = await contactService.restoreContact(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: contact });
    },
  );

  // POST /contacts/:id/merge — Merge contacts
  fastify.post<{ Params: { id: string } }>(
    '/contacts/:id/merge',
    { preHandler: [requireAuth, fastify.requireCan('bond.contact.merge'), requireScope('read_write')] },
    async (request, reply) => {
      const body = mergeContactSchema.parse(request.body);
      const result = await contactService.mergeContacts(
        request.params.id,
        body.source_id,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );
}
