import type { FastifyRequest, FastifyReply } from 'fastify';
import { createInternalSecretGuard } from '@bigbluebam/service-health';
import { env } from '../env.js';

/**
 * HB-7: Guard for the server-to-server /internal/helpdesk/* routes.
 *
 * Inbound requests MUST carry an X-Internal-Token header whose value matches
 * INTERNAL_HELPDESK_SECRET, from a direct private-network peer. The check is the suite-wide one in
 * @bigbluebam/service-health (constant-time compare, fail closed, TCP-socket peer only); this file
 * only names the secret and the header (#306: it used to read the header itself, which the
 * internal-secret CI guard could not see because the header name came through a constant).
 *
 * Responds:
 *   401 UNAUTHORIZED - secret not configured, token missing or mismatched
 *   403 FORBIDDEN    - token OK but caller not a direct private-network peer
 */
const checkHelpdeskToken = createInternalSecretGuard({
  secrets: () => [env.INTERNAL_HELPDESK_SECRET],
  tokenHeaderOnly: true,
});

export async function requireServiceAuth(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!checkHelpdeskToken(request, reply)) return reply;

  request.log.info(
    { url: request.url, caller: 'helpdesk-api' },
    'internal service call authorized',
  );
}
