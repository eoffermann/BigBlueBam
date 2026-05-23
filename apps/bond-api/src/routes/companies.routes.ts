import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as companyService from '../services/company.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createCompanySchema = z.object({
  name: z.string().min(1).max(255),
  domain: z.string().max(255).optional(),
  industry: z.string().max(100).optional(),
  size_bucket: z.enum(['1-10', '11-50', '51-200', '201-1000', '1001-5000', '5000+']).optional(),
  annual_revenue: z.number().int().optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().optional(),
  logo_url: z.string().url().optional(),
  address_line1: z.string().max(255).optional(),
  address_line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state_region: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  country: z.string().length(2).optional(),
  custom_fields: z.record(z.unknown()).optional(),
  owner_id: z.string().uuid().optional(),
});

const updateCompanySchema = createCompanySchema.partial();

const listQuerySchema = z.object({
  industry: z.string().optional(),
  size_bucket: z.string().optional(),
  owner_id: z.string().uuid().optional(),
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

const companyDealsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sort: z.string().max(60).optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function companyRoutes(fastify: FastifyInstance) {
  // GET /companies — List companies
  fastify.get(
    '/companies',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await companyService.listCompanies({
        organization_id: request.user!.org_id,
        ...query,
        include_deleted: query.include_deleted === 'true',
      });
      return reply.send(result);
    },
  );

  // POST /companies — Create company
  fastify.post(
    '/companies',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bond.company.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const body = createCompanySchema.parse(request.body);
      const company = await companyService.createCompany(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: company });
    },
  );

  // GET /companies/search — Search companies
  fastify.get(
    '/companies/search',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const query = searchQuerySchema.parse(request.query);
      const results = await companyService.searchCompanies(
        request.user!.org_id,
        query.q,
        query.limit,
      );
      return reply.send({ data: results });
    },
  );

  // GET /companies/:id — Get company detail
  fastify.get<{ Params: { id: string } }>(
    '/companies/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const company = await companyService.getCompany(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: company });
    },
  );

  // PATCH /companies/:id — Update company
  fastify.patch<{ Params: { id: string } }>(
    '/companies/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.company.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateCompanySchema.parse(request.body);
      const company = await companyService.updateCompany(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: company });
    },
  );

  // DELETE /companies/:id — Delete company
  fastify.delete<{ Params: { id: string } }>(
    '/companies/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.company.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await companyService.deleteCompany(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // GET /companies/:id/contacts — Contacts at this company
  fastify.get<{ Params: { id: string } }>(
    '/companies/:id/contacts',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const contacts = await companyService.getCompanyContacts(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: contacts });
    },
  );

  // GET /companies/:id/deals — Paginated deals attached to this company (G3)
  fastify.get<{
    Params: { id: string };
    Querystring: {
      limit?: number;
      offset?: number;
      sort?: string;
    };
  }>(
    '/companies/:id/deals',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = companyDealsQuerySchema.parse(request.query);
      const result = await companyService.getCompanyDeals(
        request.params.id,
        request.user!.org_id,
        query,
      );
      return reply.send(result);
    },
  );

  // POST /companies/:id/restore — Undelete a soft-deleted company (G4)
  fastify.post<{ Params: { id: string } }>(
    '/companies/:id/restore',
    { preHandler: [requireAuth, fastify.requireCan('bond.company.restore'), requireScope('read_write')] },
    async (request, reply) => {
      const company = await companyService.restoreCompany(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: company });
    },
  );
}
