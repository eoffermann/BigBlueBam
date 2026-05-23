import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import * as mvService from '../services/materialized-view.service.js';

/**
 * Bench materialized-view admin routes (Wave 2B follow-up to close the
 * frontend-is-there-but-no-route gap that surfaced during the Wave 2B
 * frontend dispatch).
 *
 * GET /v1/materialized-views
 *   Lists every bench_materialized_views row with its refresh state.
 *   Member role and up can read.
 *
 * POST /v1/materialized-views/:viewName/refresh
 *   Manually triggers a refresh. Same underlying service as the worker
 *   scheduler uses. Admin role required since REFRESH MATERIALIZED VIEW
 *   can be expensive and should not be spammable by every member.
 */
export default async function materializedViewsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/materialized-views',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      const rows = await mvService.listMaterializedViews();
      return reply.send({ data: rows });
    },
  );

  fastify.post<{ Params: { viewName: string } }>(
    '/materialized-views/:viewName/refresh',
    { preHandler: [requireAuth, fastify.requireCan('bench.materialized_view_refresh.create')] },
    async (request, reply) => {
      const { viewName } = request.params;
      const result = await mvService.refreshView(viewName);
      return reply.status(200).send({ data: result });
    },
  );
}
