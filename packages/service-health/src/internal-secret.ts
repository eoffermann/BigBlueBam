import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  carriesInternalTokenOf,
  type HeaderBag,
  INTERNAL_SECRET_HEADERS,
  INTERNAL_TOKEN_HEADER,
  internalRequestVerdict,
  isDirectPrivatePeerOf,
  isPrivateNetworkAddress,
  sameSecret,
} from './internal-peer.js';

/**
 * The one guard for server-to-server ("internal") routes in every Fastify service (#233, #252).
 * apps/api and every satellite authenticate their internal routes through here, so a fix to the
 * check lands once for all of them. The rule itself is ./internal-peer.ts (framework-free, also
 * used by mcp-server's raw node:http /tools/call, #277). scripts/check-internal-secret-guard.mjs
 * fails CI when a service reads an internal-secret header anywhere else.
 *
 * Two factors, both required:
 *   1. A shared secret, compared in constant time. Fails CLOSED when no secret is configured (#86).
 *   2. The caller is a direct peer on a private network (#226). This reads the TCP socket peer,
 *      never `request.ip`: services run with `trustProxy: true`, so `request.ip` is the left-most
 *      X-Forwarded-For entry, which any internet client can set. A request that came through the
 *      edge nginx is also refused: nginx always adds X-Forwarded-For, and services call each other
 *      directly over the private network (compose service names, *.railway.internal on Railway),
 *      so a forwarded request on an internal route can only be an outside caller.
 *
 *   401 UNAUTHORIZED  secret not configured, missing or wrong
 *   403 FORBIDDEN     secret right, caller not a direct private-network peer
 */

export { INTERNAL_SECRET_HEADERS, INTERNAL_TOKEN_HEADER, isPrivateNetworkAddress, sameSecret };

/** The TCP peer address, ignoring every proxy header. */
export function socketPeerAddress(request: FastifyRequest): string | undefined {
  return request.raw.socket?.remoteAddress ?? undefined;
}

/**
 * True when the request carries an x-internal-token header at all. For a route that serves both
 * internal and non-internal callers and must pick a path before authenticating (helpdesk-api's
 * agent routes, #306); the secret itself is still checked only by createInternalSecretGuard.
 */
export function carriesInternalToken(request: FastifyRequest): boolean {
  return carriesInternalTokenOf(request.headers as HeaderBag);
}

/** True when the caller is a direct private-network peer, not a client relayed by the edge. */
export function isDirectPrivatePeer(request: FastifyRequest): boolean {
  return isDirectPrivatePeerOf(request.headers as HeaderBag, socketPeerAddress(request));
}

function deny(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message, details: [], request_id: request.id } });
}

function logNotPrivate(request: FastifyRequest) {
  request.log.warn(
    {
      peer: socketPeerAddress(request),
      forwarded: request.headers['x-forwarded-for'] ?? null,
      url: request.url,
    },
    'internal credential presented by a caller that is not a direct private-network peer',
  );
}

/**
 * Refuses (403) a caller that is not a direct private-network peer. Returns true when the request
 * was refused. Exported for guards whose secret check differs (the api's requireServiceAuth).
 */
export function refuseNonPrivatePeer(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isDirectPrivatePeer(request)) return false;
  logNotPrivate(request);
  void deny(request, reply, 403, 'FORBIDDEN', 'Internal endpoints are not reachable from this network');
  return true;
}

export interface InternalSecretGuardOptions {
  /**
   * The configured secret(s), read on every request (so a test that mocks the service's env
   * module is honoured). Empty and undefined entries are ignored; none left means fail closed.
   */
  secrets: () => ReadonlyArray<string | null | undefined>;
  /** Also read the x-internal-token header (helpdesk-api and blueprint-api conventions). */
  acceptTokenHeader?: boolean;
  /** Read only the x-internal-token header (the HB-7 INTERNAL_HELPDESK_SECRET pair). */
  tokenHeaderOnly?: boolean;
}

/** `(request, reply) => boolean`: true when allowed; otherwise the 401/403 is already sent. */
export type InternalSecretCheck = (request: FastifyRequest, reply: FastifyReply) => boolean;

/**
 * Build the internal guard for one service. Use the returned function inline
 * (`if (!requireInternalSecret(request, reply)) return reply;`) or wrap it with
 * internalSecretPreHandler for `preHandler: [...]`.
 */
export function createInternalSecretGuard(options: InternalSecretGuardOptions): InternalSecretCheck {
  return function requireInternalSecret(request: FastifyRequest, reply: FastifyReply): boolean {
    const verdict = internalRequestVerdict(
      { headers: request.headers as HeaderBag, remoteAddress: socketPeerAddress(request) },
      {
        secrets: options.secrets(),
        acceptTokenHeader: options.acceptTokenHeader,
        tokenHeaderOnly: options.tokenHeaderOnly,
      },
    );
    switch (verdict) {
      case 'ok':
        return true;
      case 'unconfigured':
        request.log.error('INTERNAL_SERVICE_SECRET is not configured - refusing internal request.');
        void deny(request, reply, 401, 'UNAUTHORIZED', 'Internal service authentication is not configured');
        return false;
      case 'bad_secret':
        void deny(request, reply, 401, 'UNAUTHORIZED', 'Invalid or missing internal service secret');
        return false;
      case 'not_private':
        logNotPrivate(request);
        void deny(request, reply, 403, 'FORBIDDEN', 'Internal endpoints are not reachable from this network');
        return false;
    }
  };
}

/** The guard as a Fastify preHandler. */
export function internalSecretPreHandler(check: InternalSecretCheck) {
  return async function internalSecretHook(request: FastifyRequest, reply: FastifyReply) {
    if (!check(request, reply)) return reply;
  };
}
