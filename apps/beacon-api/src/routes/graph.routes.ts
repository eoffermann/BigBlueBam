/**
 * Graph routes — Knowledge Graph Explorer API endpoints (§5.5.3).
 *
 * GET /graph/neighbors  — Nodes and edges within N hops of a focal Beacon
 * GET /graph/hubs       — Most-connected Beacons in scope
 * GET /graph/recent     — Recently modified/verified Beacons
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import * as graphService from '../services/graph.service.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const neighborsQuerySchema = z.object({
  beacon_id: z.string().uuid(),
  hops: z.coerce.number().int().min(1).max(3).default(1),
  include_implicit: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  tag_affinity_threshold: z.coerce.number().int().min(1).max(5).default(2),
  'filters.status': z
    .union([z.string(), z.array(z.string())])
    .default(['Active', 'PendingReview'])
    .transform((v) => (Array.isArray(v) ? v : [v])),
});

const hubsQuerySchema = z.object({
  scope: z.enum(['project', 'organization']).default('project'),
  project_id: z.string().uuid().optional(),
  top_k: z.coerce.number().int().min(1).max(50).default(20),
});

const recentQuerySchema = z.object({
  scope: z.enum(['project', 'organization']).default('project'),
  project_id: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(90).default(7),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export default async function graphRoutes(fastify: FastifyInstance) {
  // Inject Redis into graph service for implicit edge caching
  graphService.setRedis(fastify.redis);

  // GET /graph/neighbors
  fastify.get(
    '/graph/neighbors',
    { preHandler: [requireAuth, fastify.requireCan('beacon.graph_neighbor.list')] },
    async (request, reply) => {
      const query = neighborsQuerySchema.parse(request.query);

      const result = await graphService.getNeighbors(
        query.beacon_id,
        query.hops,
        query.include_implicit,
        query.tag_affinity_threshold,
        query['filters.status'],
        request.user!.org_id,
        request.user!.id,
      );

      return reply.send(result);
    },
  );

  // GET /graph/hubs
  fastify.get(
    '/graph/hubs',
    { preHandler: [requireAuth, fastify.requireCan('beacon.graph_hub.list')] },
    async (request, reply) => {
      const query = hubsQuerySchema.parse(request.query);

      const result = await graphService.getHubs(
        query.scope,
        query.project_id ?? null,
        request.user!.org_id,
        query.top_k,
        request.user!.id,
      );

      return reply.send({ data: result.nodes, edges: result.edges });
    },
  );

  // GET /graph/recent
  fastify.get(
    '/graph/recent',
    { preHandler: [requireAuth, fastify.requireCan('beacon.graph_recent.list')] },
    async (request, reply) => {
      const query = recentQuerySchema.parse(request.query);

      const nodes = await graphService.getRecent(
        query.scope,
        query.project_id ?? null,
        request.user!.org_id,
        query.days,
        request.user!.id,
      );

      return reply.send({ data: nodes });
    },
  );
}
