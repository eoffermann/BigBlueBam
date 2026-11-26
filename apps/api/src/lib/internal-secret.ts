import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

/**
 * preHandler for server-to-server routes: the x-internal-service-secret (or legacy
 * x-internal-secret) header must equal INTERNAL_SERVICE_SECRET, compared in constant time.
 * Fails CLOSED when the secret is unset, matching internal-can-read / internal-system-errors.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export async function requireInternalSecret(request: FastifyRequest, reply: FastifyReply) {
  const configured = env.INTERNAL_SERVICE_SECRET;
  if (!configured) {
    request.log.error('INTERNAL_SERVICE_SECRET is not configured - refusing internal request.');
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Internal service authentication is not configured',
        details: [],
        request_id: request.id,
      },
    });
  }
  const header = request.headers['x-internal-service-secret'] ?? request.headers['x-internal-secret'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || !timingSafeStringEqual(provided, configured)) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing internal service secret',
        details: [],
        request_id: request.id,
      },
    });
  }
}
