import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';

// Internal-route guard for /v1/internal/events (spec 5.1 / S4 / SN2).
//
// This is intentionally STRONGER than apps/api/src/routes/internal-llm.routes.ts:64.
// Because /internal/events has a SINGLE required secret, an empty-vs-empty compare would
// authorize an unauthenticated caller. So we reject UNCONDITIONALLY when the sole secret
// is empty/undefined, BEFORE any timing-safe compare. An implementer must NOT "align" this
// to the looser multi-secret shape.
export function requireInternalSecret(request: FastifyRequest, reply: FastifyReply): boolean {
  const configured = env.INTERNAL_SERVICE_SECRET;
  // FAIL CLOSED on an empty/undefined configured secret (S4/SN2).
  if (!configured || configured.length === 0) {
    reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Internal endpoint is not configured (empty INTERNAL_SERVICE_SECRET)',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  const providedRaw = request.headers['x-internal-secret'];
  const provided = Array.isArray(providedRaw) ? providedRaw[0] : providedRaw;
  const ok =
    typeof provided === 'string' &&
    provided.length === configured.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
  if (!ok) {
    reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing X-Internal-Secret header',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  return true;
}
