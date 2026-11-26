import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

/**
 * The one guard for server-to-server ("internal") routes in every Fastify service (#233, #252).
 * apps/api and every satellite authenticate their internal routes through here, so a fix to the
 * check lands once for all of them. scripts/check-internal-secret-guard.mjs fails CI when a
 * service reads an internal-secret header anywhere else.
 *
 * Two factors, both required:
 *   1. A shared secret, compared in constant time. Fails CLOSED when no secret is configured
 *      (#86): an empty-vs-empty timingSafeEqual is true, so an unconfigured secret is refused
 *      before any compare, never treated as "unprotected".
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

// Real CIDR ranges. A '172.' prefix match would also admit public 172.0-15.x and 172.32-255.x.
const PRIVATE_NETWORKS = new BlockList();
PRIVATE_NETWORKS.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_NETWORKS.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_NETWORKS.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_NETWORKS.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_NETWORKS.addAddress('::1', 'ipv6');
// IPv6 unique-local; Railway's private network uses fd00::/8 for service-to-service traffic.
PRIVATE_NETWORKS.addSubnet('fc00::', 7, 'ipv6');

/**
 * Every header name a caller may carry the internal service secret in. Callers across the suite
 * send one or the other (X-Internal-Secret from the shared Bolt / visibility clients, the
 * X-Internal-Service-Secret name from Book, Bureau and the worker), so every guard reads both.
 */
export const INTERNAL_SECRET_HEADERS = ['x-internal-service-secret', 'x-internal-secret'] as const;
/** The older helpdesk-api / blueprint-api header name, read only by guards that opt in. */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/** True when `address` is in a private range (IPv4, IPv4-mapped IPv6, or IPv6). */
export function isPrivateNetworkAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  let addr = address.trim();
  // Zone ids (fe80::1%eth0) are not valid for BlockList.
  const pct = addr.indexOf('%');
  if (pct >= 0) addr = addr.slice(0, pct);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped?.[1]) addr = mapped[1];
  const family = isIP(addr);
  if (family === 4) return PRIVATE_NETWORKS.check(addr, 'ipv4');
  if (family === 6) return PRIVATE_NETWORKS.check(addr, 'ipv6');
  return false;
}

/** The TCP peer address, ignoring every proxy header. */
export function socketPeerAddress(request: FastifyRequest): string | undefined {
  return request.raw.socket?.remoteAddress ?? undefined;
}

/** True when the request came through a reverse proxy (the edge nginx always sets these). */
function wasProxied(request: FastifyRequest): boolean {
  return request.headers['x-forwarded-for'] !== undefined || request.headers['x-real-ip'] !== undefined;
}

/** True when the caller is a direct private-network peer, not a client relayed by the edge. */
export function isDirectPrivatePeer(request: FastifyRequest): boolean {
  return !wasProxied(request) && isPrivateNetworkAddress(socketPeerAddress(request));
}

/** Constant-time string equality (a length mismatch still spends one compare). */
export function sameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function firstHeader(request: FastifyRequest, names: readonly string[]): string | undefined {
  for (const name of names) {
    const raw = request.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function deny(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message, details: [], request_id: request.id } });
}

/**
 * Refuses (403) a caller that is not a direct private-network peer. Returns true when the request
 * was refused. Exported for guards whose secret check differs (the api's requireServiceAuth).
 */
export function refuseNonPrivatePeer(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isDirectPrivatePeer(request)) return false;
  request.log.warn(
    {
      peer: socketPeerAddress(request),
      forwarded: request.headers['x-forwarded-for'] ?? null,
      url: request.url,
    },
    'internal credential presented by a caller that is not a direct private-network peer',
  );
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
}

/** `(request, reply) => boolean`: true when allowed; otherwise the 401/403 is already sent. */
export type InternalSecretCheck = (request: FastifyRequest, reply: FastifyReply) => boolean;

/**
 * Build the internal guard for one service. Use the returned function inline
 * (`if (!requireInternalSecret(request, reply)) return reply;`) or wrap it with
 * internalSecretPreHandler for `preHandler: [...]`.
 */
export function createInternalSecretGuard(options: InternalSecretGuardOptions): InternalSecretCheck {
  const headerNames: readonly string[] = options.acceptTokenHeader
    ? [...INTERNAL_SECRET_HEADERS, INTERNAL_TOKEN_HEADER]
    : INTERNAL_SECRET_HEADERS;
  return function requireInternalSecret(request: FastifyRequest, reply: FastifyReply): boolean {
    const secrets = options.secrets().filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (secrets.length === 0) {
      request.log.error('INTERNAL_SERVICE_SECRET is not configured - refusing internal request.');
      void deny(request, reply, 401, 'UNAUTHORIZED', 'Internal service authentication is not configured');
      return false;
    }
    const provided = firstHeader(request, headerNames);
    // Compare against every secret so the timing does not reveal which one matched.
    const matched = provided !== undefined && secrets.map((s) => sameSecret(provided, s)).some(Boolean);
    if (!matched) {
      void deny(request, reply, 401, 'UNAUTHORIZED', 'Invalid or missing internal service secret');
      return false;
    }
    return !refuseNonPrivatePeer(request, reply);
  };
}

/** The guard as a Fastify preHandler. */
export function internalSecretPreHandler(check: InternalSecretCheck) {
  return async function internalSecretHook(request: FastifyRequest, reply: FastifyReply) {
    if (!check(request, reply)) return reply;
  };
}
