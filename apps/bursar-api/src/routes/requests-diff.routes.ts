import type { FastifyInstance } from 'fastify';
import { toCsv } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, viewerOf } from '../lib/http.js';
import { getExclusionDiff } from '../services/leveling.service.js';

// CSV export of the §4.7 exclusion diff (spec 11, M8). Serializes the same per-offer node partition
// the /requests/:id/exclusion-diff route returns, FORMULA-NEUTRALIZED via the shared toCsv helper
// (a scope-node title or offer label is user-influenced text). Gated by bursar.coverage.read, the
// same permission as the JSON diff.
export default async function requestDiffRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get('/requests/:id/diff/export', { preHandler: [requireAuth, can('bursar.coverage.read')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const diff = await getExclusionDiff(viewerOf(request), id);
      const header = ['offer_label', 'scope_node_title', 'verdict', 'review_status', 'withheld_reason'];
      const rows: unknown[][] = [];
      for (const offer of diff.data.offers) {
        for (const r of offer.rows) {
          rows.push([offer.label ?? '(unnamed offer)', r.title, r.verdict, r.review_status, r.withheld_reason ?? '']);
        }
      }
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="bursar-diff-${id}.csv"`);
      return toCsv(header, rows);
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });
}
