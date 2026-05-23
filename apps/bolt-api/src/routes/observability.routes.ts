// §12 Wave 5 bolt observability
// ---------------------------------------------------------------------------
// Observability routes: event-level trace and recent-events inspection. Both
// are org-scoped via the auth plugin; the trace route additionally joins
// bolt_automations so a caller cannot probe another org by guessing an
// event_id.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import {
  getTraceByEventId,
  listRecentEvents,
} from '../services/event-trace.service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const recentEventsQuerySchema = z.object({
  source: z.string().min(1).max(60).optional(),
  event: z.string().min(1).max(60).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export default async function observabilityRoutes(fastify: FastifyInstance) {
  // GET /events/:event_id/trace — Full evaluation trail for one ingest event
  fastify.get<{ Params: { event_id: string } }>(
    '/events/:event_id/trace',
    { preHandler: [requireAuth, shadowOnly('bolt.event_trace.get')] },
    async (request, reply) => {
      const { event_id } = request.params;
      if (!event_id || !UUID_REGEX.test(event_id)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Valid event_id (uuid) is required',
            details: [],
            request_id: request.id,
          },
        });
      }

      const trace = await getTraceByEventId(event_id, request.user!.org_id);
      return reply.send({
        data: {
          event_id,
          executions: trace,
        },
      });
    },
  );

  // GET /events/recent?source=&event=&since=&limit= — Recent ingest-event
  // summaries. Spec called for `GET /v1/events?source=...` but the bare
  // /events path is already owned by event.routes.ts (static event catalog),
  // so we keep the trace-side listing under /events/recent.
  fastify.get(
    '/events/recent',
    { preHandler: [requireAuth, shadowOnly('bolt.event_recent.list')] },
    async (request, reply) => {
      const query = recentEventsQuerySchema.parse(request.query);
      const events = await listRecentEvents({
        orgId: request.user!.org_id,
        source: query.source,
        event: query.event,
        since: query.since,
        limit: query.limit,
      });
      return reply.send({ data: events });
    },
  );
}
