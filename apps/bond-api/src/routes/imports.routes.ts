import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as importService from '../services/import.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const entityTypes = ['contact', 'company', 'deal'] as const;

const createMappingSchema = z.object({
  source_system: z.string().min(1).max(60),
  source_id: z.string().min(1).max(255),
  bond_entity_type: z.enum(entityTypes),
  bond_entity_id: z.string().uuid(),
});

const listMappingsQuerySchema = z.object({
  source_system: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Minimal import-mappings CRUD. Supports the express-interest migration (G1)
 * by exposing the dedup table behind a thin REST surface. Full CSV upload
 * with column mapping is deferred to the P1 batch; this wave just gets the
 * primitive recording/lookup endpoints in place so other services (and MCP
 * tools) can start threading through mappings.
 */
export default async function importRoutes(fastify: FastifyInstance) {
  // POST /imports/mappings — upsert a single mapping
  fastify.post(
    '/imports/mappings',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bond.import_mapping.create'), requireScope('admin')],
    },
    async (request, reply) => {
      const body = createMappingSchema.parse(request.body);
      const mapping = await importService.createImportMapping(
        request.user!.org_id,
        body,
      );
      return reply.status(201).send({ data: mapping });
    },
  );

  // GET /imports/mappings — list mappings for the current org
  fastify.get(
    '/imports/mappings',
    {
      preHandler: [requireAuth, fastify.requireCan('bond.import_mapping.list')],
    },
    async (request, reply) => {
      const query = listMappingsQuerySchema.parse(request.query);
      const result = await importService.listImportMappings(
        request.user!.org_id,
        query,
      );
      return reply.send(result);
    },
  );
}
