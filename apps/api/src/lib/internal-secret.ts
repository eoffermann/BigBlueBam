import {
  createInternalSecretGuard,
  internalSecretPreHandler,
  isDirectPrivatePeer,
  isPrivateNetworkAddress,
  refuseNonPrivatePeer,
  sameSecret,
  socketPeerAddress,
} from '@bigbluebam/service-health';
import { env } from '../env.js';

/**
 * The api's internal-route guards (#233). The check itself (constant-time compare, fail closed,
 * direct private-network peer only) is the suite-wide one in @bigbluebam/service-health
 * (packages/service-health/src/internal-secret.ts, #252); this file only says which secrets the
 * api accepts on which routes.
 *
 *   401 UNAUTHORIZED  secret not configured, missing or wrong
 *   403 FORBIDDEN     secret right, caller not a direct private-network peer
 */

export { isDirectPrivatePeer, isPrivateNetworkAddress, refuseNonPrivatePeer, sameSecret, socketPeerAddress };

const preHandler = internalSecretPreHandler;

/** INTERNAL_SERVICE_SECRET via x-internal-service-secret (or legacy x-internal-secret), private peer only. */
export const requireInternalSecret = preHandler(createInternalSecretGuard({ secrets: () => [env.INTERNAL_SERVICE_SECRET] }));

/** As requireInternalSecret, but also reads the x-internal-token header. */
export const requireInternalSecretOrToken = preHandler(
  createInternalSecretGuard({ secrets: () => [env.INTERNAL_SERVICE_SECRET], acceptTokenHeader: true }),
);

/** As requireInternalSecretOrToken, but also accepts INTERNAL_HELPDESK_SECRET (llm, permissions dual-read). */
export const requireInternalSecretOrHelpdeskToken = preHandler(
  createInternalSecretGuard({
    secrets: () => [env.INTERNAL_SERVICE_SECRET, env.INTERNAL_HELPDESK_SECRET],
    acceptTokenHeader: true,
  }),
);
