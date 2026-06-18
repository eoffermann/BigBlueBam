// ---------------------------------------------------------------------------
// Helpdesk analytics routes (AGENTIC_TODO §4 Wave 5)
//
// Trend / count-by-phrase queries over tickets. Admin/agent auth surface:
// accepts either a Bam session cookie OR a per-agent helpdesk API key,
// mirroring the convention in users.routes.ts. Not exposed to customer
// JWTs.
//
// Routes:
//   GET /v1/tickets/analytics/count-by-phrase
//     query: phrase, buckets=hour|day|week, since (ISO), until? (ISO),
//            status? (ticket status enum)
//     -> 200 { phrase, bucket_granularity, window, buckets[], total,
//               approximate:false, generated_at }
// ---------------------------------------------------------------------------

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { verifyAgentApiKey } from '../lib/agent-auth.js';
import {
  countTicketsByPhrase,
  PhraseCountError,
} from '../services/phrase-count.service.js';

/**
 * Require admin auth - accepts a Bam session cookie OR a per-agent
 * helpdesk API key. Mirrors users.routes.ts::requireAdminAuth.
 */
async function requireAdminAuth(request: FastifyRequest, reply: FastifyReply) {
  const sessionCookie = request.cookies?.session;
  if (sessionCookie) {
    try {
      const result = await db.execute(
        sql`SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.id = ${sessionCookie} AND s.expires_at > now() LIMIT 1`,
      );
      if (result && (Array.isArray(result) ? result.length > 0 : (result as any).rows?.length > 0)) {
        return;
      }
    } catch {
      // Fall through to X-Agent-Key.
    }
  }
  const token = request.headers['x-agent-key'] as string | undefined;
  const agentUserId = await verifyAgentApiKey(request, token);
  if (agentUserId) return;

  return reply.status(401).send({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
      details: [],
      request_id: request.id,
    },
  });
}

const bucketEnum = z.enum(['hour', 'day', 'week']);

const ticketStatusEnum = z.enum([
  'open',
  'in_progress',
  'waiting_on_customer',
  'resolved',
  'closed',
]);

const querySchema = z.object({
  phrase: z.string().min(1).max(500),
  buckets: bucketEnum,
  // window.since is REQUIRED. window.until defaults to now() server-side.
  since: z.string().datetime({ offset: true }).or(z.string().datetime()),
  until: z
    .string()
    .datetime({ offset: true })
    .or(z.string().datetime())
    .optional(),
  status: ticketStatusEnum.optional(),
});

export default async function analyticsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/v1/tickets/analytics/count-by-phrase',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: [requireAdminAuth],
    },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }
      const q = parsed.data;
      const since = new Date(q.since);
      const until = q.until ? new Date(q.until) : new Date();

      try {
        const result = await countTicketsByPhrase({
          phrase: q.phrase,
          buckets: q.buckets,
          since,
          until,
          statusFilter: q.status,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof PhraseCountError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        // statement_timeout surfaces as a pg error; normalize to 504.
        const msg = err instanceof Error ? err.message : String(err);
        if (/statement.*timeout/i.test(msg)) {
          return reply.status(504).send({
            error: {
              code: 'PHRASE_COUNT_TIMEOUT',
              message: 'Query exceeded 5s budget',
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
