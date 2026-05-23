/**
 * Search routes — hybrid search, typeahead, and saved queries.
 *
 * POST /search           — full hybrid search (§5.2 request schema)
 * GET  /search/suggest   — typeahead
 * POST /search/context   — same as /search but with pre-fetched linked beacons
 * POST /search/saved     — save a query
 * GET  /search/saved     — list saved queries
 * GET  /search/saved/:id — get saved query
 * DELETE /search/saved/:id — delete saved query
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as searchService from '../services/search.service.js';
import * as savedQueryService from '../services/saved-query.service.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const searchRequestSchema = z.object({
  query: z.string().max(1000),
  filters: z.object({
    organization_id: z.string().uuid().optional(), // falls back to session org
    project_ids: z.array(z.string().uuid()).optional(),
    status: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    visibility_max: z.enum(['Public', 'Organization', 'Project', 'Private']).optional(),
    expires_after: z.string().optional(),
  }).optional(),
  options: z.object({
    include_graph_expansion: z.boolean().optional(),
    include_tag_expansion: z.boolean().optional(),
    include_fulltext_fallback: z.boolean().optional(),
    rerank: z.boolean().optional(),
    top_k: z.number().int().min(0).max(100).optional(),
    group_by_beacon: z.boolean().optional(),
  }).optional(),
});

const suggestQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const saveQuerySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).nullable().optional(),
  query_body: z.record(z.unknown()),
  scope: z.enum(['Private', 'Project', 'Organization']).optional(),
  project_id: z.string().uuid().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export default async function searchRoutes(fastify: FastifyInstance) {
  // POST /search — Full hybrid search
  fastify.post(
    '/search',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('beacon.search.create')],
    },
    async (request, reply) => {
      const body = searchRequestSchema.parse(request.body);

      // Always enforce the session org — never trust client-supplied organization_id
      const searchRequest: searchService.SearchRequest = {
        query: body.query,
        filters: {
          organization_id: request.user!.org_id,
          project_ids: body.filters?.project_ids,
          status: body.filters?.status,
          tags: body.filters?.tags,
          visibility_max: body.filters?.visibility_max,
          expires_after: body.filters?.expires_after,
        },
        options: body.options,
      };

      const result = await searchService.hybridSearch(searchRequest, request.user!.id);
      return reply.send(result);
    },
  );

  // GET /search/suggest — Typeahead suggestions
  fastify.get(
    '/search/suggest',
    { preHandler: [requireAuth, shadowOnly('beacon.search_suggest.list')] },
    async (request, reply) => {
      const query = suggestQuerySchema.parse(request.query);
      const results = await searchService.suggestBeacons(
        query.q,
        request.user!.org_id,
        query.limit,
        request.user!.id,
      );
      return reply.send({ data: results });
    },
  );

  // POST /search/context — Same as /search but with enriched linked beacons
  fastify.post(
    '/search/context',
    { preHandler: [requireAuth, shadowOnly('beacon.search_context.create')] },
    async (request, reply) => {
      const body = searchRequestSchema.parse(request.body);

      // Always enforce the session org — never trust client-supplied organization_id
      const searchRequest: searchService.SearchRequest = {
        query: body.query,
        filters: {
          organization_id: request.user!.org_id,
          project_ids: body.filters?.project_ids,
          status: body.filters?.status,
          tags: body.filters?.tags,
          visibility_max: body.filters?.visibility_max,
          expires_after: body.filters?.expires_after,
        },
        options: {
          ...body.options,
          // Context mode always includes graph and tag expansion
          include_graph_expansion: true,
          include_tag_expansion: true,
        },
      };

      const result = await searchService.hybridSearch(searchRequest, request.user!.id);
      return reply.send(result);
    },
  );

  // POST /search/saved — Save a named query
  fastify.post(
    '/search/saved',
    { preHandler: [requireAuth, fastify.requireCan('beacon.search_saved.create'), requireScope('read_write')] },
    async (request, reply) => {
      const data = saveQuerySchema.parse(request.body);
      const saved = await savedQueryService.saveQuery(
        data,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: saved });
    },
  );

  // GET /search/saved — List saved queries
  fastify.get(
    '/search/saved',
    { preHandler: [requireAuth, shadowOnly('beacon.search_saved.list')] },
    async (request, reply) => {
      const query = z
        .object({ project_id: z.string().uuid().optional() })
        .parse(request.query);

      const results = await savedQueryService.listQueries(
        request.user!.id,
        request.user!.org_id,
        query.project_id,
      );
      return reply.send({ data: results });
    },
  );

  // GET /search/saved/:id — Get a saved query
  fastify.get<{ Params: { id: string } }>(
    '/search/saved/:id',
    { preHandler: [requireAuth, shadowOnly('beacon.search_saved.get')] },
    async (request, reply) => {
      const result = await savedQueryService.getQuery(
        request.params.id,
        request.user!.id,
        request.user!.org_id,
      );
      if (!result) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Saved query not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: result });
    },
  );

  // DELETE /search/saved/:id — Delete a saved query
  fastify.delete<{ Params: { id: string } }>(
    '/search/saved/:id',
    { preHandler: [requireAuth, shadowOnly('beacon.search_saved.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await savedQueryService.deleteQuery(request.params.id, request.user!.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );
}
