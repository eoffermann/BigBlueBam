import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAgentAuth, resolveAgentRequestOrgId } from '../lib/agent-auth.js';
import * as similarTicketsService from '../services/similar-tickets.service.js';

/**
 * Helpdesk dedupe routes (Wave 5 AGENTIC_TODO §7).
 *
 *   GET /helpdesk/agents/tickets/:id/similar
 *
 * Returns ranked similar tickets for a given ticket using pg_trgm
 * similarity on subject plus requester / category / linked-duplicate
 * boosts. Each candidate carries the contributing signals and, when
 * present, the prior decision row from dedupe_decisions keyed by the
 * canonical ordered pair so callers can suppress already-resolved
 * pairs. Org-scoping matches the rest of the agent surface: the
 * caller's org is resolved from the Bam session cookie or the agent
 * API key, and results are always filtered to that org via
 * projects.org_id.
 */

const querySchema = z.object({
  status_filter: z.enum(['open', 'any', 'not_closed']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  window_days: z.coerce.number().int().min(1).max(365).optional(),
  min_confidence: z.coerce.number().min(0).max(1).optional(),
});

/**
 * The org to scope by: the same rule as every other agent route (the
 * credential's org, then the Bam session's, then the X-Agent-Key owner's).
 */
const resolveRequestOrgId = resolveAgentRequestOrgId;

export default async function dedupeRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/helpdesk/agents/tickets/:id/similar',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAgentAuth],
    },
    async (request, reply) => {
      const scopeOrgId = await resolveRequestOrgId(request);
      if (!scopeOrgId) {
        return reply.status(403).send({
          error: {
            code: 'ORG_CONTEXT_REQUIRED',
            message:
              'Organization context is required. Authenticate with a Bam session cookie or use an agent key linked to a user with an org.',
            details: [],
            request_id: request.id,
          },
        });
      }
      const query = querySchema.parse(request.query);

      try {
        const result = await similarTicketsService.findSimilarTickets({
          ticket_id: request.params.id,
          org_id: scopeOrgId,
          status_filter: query.status_filter,
          limit: query.limit,
          window_days: query.window_days,
          min_confidence: query.min_confidence,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof similarTicketsService.SimilarTicketsError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );
}
