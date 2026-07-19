import type { FastifyInstance } from 'fastify';
import { bulwarkIngestEventSchema } from '@bigbluebam/shared';
import { requireInternalSecret } from '../lib/internal-secret.js';
import { writeIngestEvent } from '../services/ingest.service.js';
import { handleProposalDecided } from '../subscriptions/proposal-decided.js';

// Internal service-to-service routes (spec 5.1 / 6). Registered under { prefix: '/v1' } so the
// live paths are /v1/internal/events and /v1/internal/proposal-decided. The bolt-api dispatch
// hook (M6) POSTs to /v1/internal/events with the /v1 prefix present (Braid shipped a live 404
// by targeting /internal/events without it - do NOT drop the /v1).
export default async function internalRoutes(fastify: FastifyInstance) {
  // Ingest-trigger from bolt-api. Fails CLOSED when INTERNAL_SERVICE_SECRET is empty (S4/SN2),
  // then durably persists to bulwark_ingest_events and enqueues the firing drain.
  fastify.post('/internal/events', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    const parsed = bulwarkIngestEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid ingest event',
          details: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
          request_id: request.id,
        },
      });
    }
    const result = await writeIngestEvent(parsed.data);
    request.log.info(
      {
        org_id: parsed.data.org_id,
        source: parsed.data.source,
        event_type: parsed.data.event_type,
        deduped: result.deduped,
        enqueued: result.enqueued,
      },
      'bulwark /internal/events persisted to inbox',
    );
    return reply.status(202).send({ data: { accepted: true, ...result } });
  });

  // proposal.decided delivery (spec 2.2 / 5.4). Idempotent: the send executors are CAS-guarded.
  fastify.post('/internal/proposal-decided', async (request, reply) => {
    if (!requireInternalSecret(request, reply)) return reply;
    try {
      const result = await handleProposalDecided(request.body as never);
      return { data: result };
    } catch (err) {
      request.log.error({ err }, 'bulwark proposal-decided handler failed');
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'proposal-decided processing failed',
          details: [],
          request_id: request.id,
        },
      });
    }
  });
}
