import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { env } from '../env.js';

/**
 * The one guard for api-owned server-to-server routes (#233). Every internal route in apps/api
 * authenticates through here, so a fix to the check lands once for all of them.
 *
 * Two factors, both required:
 *   1. A shared secret, compared in constant time. Fails CLOSED when it is not configured (#86).
 *   2. The caller is a direct peer on a private network (#226). This reads the TCP socket peer,
 *      never `request.ip`: the api runs with `trustProxy: true`, so `request.ip` is the left-most
 *      X-Forwarded-For entry, which any internet client can set. A request that came through the
 *      edge nginx is also refused: nginx always adds X-Forwarded-For, and every satellite calls
 *      the api directly over the private network (`BBB_API_INTERNAL_URL`), so a forwarded
 *      request on an internal route can only be an outside caller. nginx also 404s these paths
 *      at the edge (scripts/check-nginx-spa-lists.mjs keeps that deny in all three configs).
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
 * Refuses (403) a caller that is not a direct private-network peer. Exported for guards whose
 * secret check differs (requireServiceAuth, which uses INTERNAL_HELPDESK_SECRET).
 * Returns true when the request was refused.
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

interface InternalSecretGuardOptions {
  /** Also read the x-internal-token header (blueprint-api and helpdesk-api send it). */
  acceptTokenHeader?: boolean;
  /** Also accept INTERNAL_HELPDESK_SECRET (llm, permissions dual-read). */
  acceptHelpdeskSecret?: boolean;
}

function internalSecretGuard(options: InternalSecretGuardOptions = {}) {
  const headerNames = options.acceptTokenHeader
    ? ['x-internal-service-secret', 'x-internal-secret', 'x-internal-token']
    : ['x-internal-service-secret', 'x-internal-secret'];
  return async function guard(request: FastifyRequest, reply: FastifyReply) {
    const secrets: string[] = [];
    if (env.INTERNAL_SERVICE_SECRET) secrets.push(env.INTERNAL_SERVICE_SECRET);
    if (options.acceptHelpdeskSecret && env.INTERNAL_HELPDESK_SECRET) secrets.push(env.INTERNAL_HELPDESK_SECRET);
    if (secrets.length === 0) {
      request.log.error('INTERNAL_SERVICE_SECRET is not configured - refusing internal request.');
      return deny(request, reply, 401, 'UNAUTHORIZED', 'Internal service authentication is not configured');
    }
    const provided = firstHeader(request, headerNames);
    // Compare against every secret so the timing does not reveal which one matched.
    const matched = provided !== undefined && secrets.map((s) => sameSecret(provided, s)).some(Boolean);
    if (!matched) {
      return deny(request, reply, 401, 'UNAUTHORIZED', 'Invalid or missing internal service secret');
    }
    if (refuseNonPrivatePeer(request, reply)) return reply;
  };
}

/** INTERNAL_SERVICE_SECRET via x-internal-service-secret (or legacy x-internal-secret), private peer only. */
export const requireInternalSecret = internalSecretGuard();

/** As requireInternalSecret, but also reads the x-internal-token header. */
export const requireInternalSecretOrToken = internalSecretGuard({ acceptTokenHeader: true });

/** As requireInternalSecretOrToken, but also accepts INTERNAL_HELPDESK_SECRET. */
export const requireInternalSecretOrHelpdeskToken = internalSecretGuard({
  acceptTokenHeader: true,
  acceptHelpdeskSecret: true,
});
