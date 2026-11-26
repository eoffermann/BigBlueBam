import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../env.js';
import { refuseNonPrivatePeer, sameSecret } from '../lib/internal-secret.js';

/**
 * HB-7: Guard for the server-to-server /internal/helpdesk/* routes.
 *
 * Inbound requests MUST carry an X-Internal-Token header whose value
 * matches INTERNAL_HELPDESK_SECRET. Comparison is timing-safe. As a
 * defense-in-depth layer the caller must also be a direct private-network
 * peer (the TCP socket address, never the spoofable X-Forwarded-For; see
 * refuseNonPrivatePeer in lib/internal-secret.ts, #226), so a leaked token
 * alone, from outside the cluster, is not sufficient.
 *
 * Responds:
 *   401 UNAUTHORIZED - missing or mismatched token
 *   403 FORBIDDEN    - token OK but caller not a direct private-network peer
 */
export async function requireServiceAuth(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const header = request.headers['x-internal-token'];
  const provided = Array.isArray(header) ? header[0] : header;

  if (!provided || typeof provided !== 'string') {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing internal service token',
        details: [],
        request_id: request.id,
      },
    });
  }

  const expected = env.INTERNAL_HELPDESK_SECRET;
  if (!expected || !sameSecret(provided, expected)) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid internal service token',
        details: [],
        request_id: request.id,
      },
    });
  }

  if (refuseNonPrivatePeer(request, reply)) return reply;

  request.log.info(
    { url: request.url, caller: 'helpdesk-api' },
    'internal service call authorized',
  );
}
