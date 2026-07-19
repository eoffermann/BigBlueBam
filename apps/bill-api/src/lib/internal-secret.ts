import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';

/**
 * Guard for bill-api's `/internal/*` service-to-service routes.
 *
 * FAILS CLOSED ON AN EMPTY SECRET. Burn spec 2.4 point 16 is explicit that the two
 * postures are inverted on purpose: AVAILABILITY fails open (the gate never blocks money
 * because something broke) and AUTHENTICATION fails closed (a missing secret never becomes
 * an open door). Do not harmonize them. A deploy that forgot INTERNAL_SERVICE_SECRET must
 * get 401 on every internal route, not an unauthenticated write path into invoices.
 *
 * Same shape as apps/bulwark-api/src/lib/internal-secret.ts.
 */
export function requireInternalSecret(request: FastifyRequest, reply: FastifyReply): boolean {
  const configured = env.INTERNAL_SERVICE_SECRET;
  const presented = request.headers['x-internal-secret'];

  if (!configured || typeof presented !== 'string' || presented !== configured) {
    reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing internal service secret',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  return true;
}
