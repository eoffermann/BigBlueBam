import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';

// Internal-route guard for /v1/internal/* (spec 5.5 / 5.6), ported verbatim from
// burn-api/src/lib/internal-secret.ts.
//
// AUTHENTICATION FAILS CLOSED. Because these routes have a SINGLE required secret, an
// empty-vs-empty compare would authorize an unauthenticated caller:
// `timingSafeEqual(Buffer.from(''), Buffer.from(''))` is true. So we reject UNCONDITIONALLY
// when the configured secret is empty, BEFORE any compare. Bursar's INTERNAL_SERVICE_SECRET is
// a required, min-32 env var, so in practice this only fires on a misconfigured deploy.

export function requireInternalSecret(request: FastifyRequest, reply: FastifyReply): boolean {
  const configured = env.INTERNAL_SERVICE_SECRET;
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
