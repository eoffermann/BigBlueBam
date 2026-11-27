import { timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

/**
 * The framework-free core of the suite's internal-route guard (#252, #277). No Fastify import, so a
 * raw node:http server (mcp-server's POST /tools/call) applies exactly the same rule as every
 * Fastify service, whose guard (./internal-secret.ts, createInternalSecretGuard) is built on this.
 * Import it as `@bigbluebam/service-health/internal-peer`.
 *
 * The rule, both factors required:
 *   1. A shared secret, compared in constant time. Fails CLOSED when none is configured (an
 *      empty-vs-empty timingSafeEqual is true, so "unconfigured" is refused before any compare).
 *   2. The caller is a direct peer on a private network: the TCP socket address is private, and
 *      the request was not relayed by the edge nginx (which always adds X-Forwarded-For).
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

/** Request headers as node:http and Fastify both expose them (lower-cased names). */
export type HeaderBag = Record<string, string | string[] | undefined>;

/** True when the request came through a reverse proxy (the edge nginx always sets these). */
export function wasProxied(headers: HeaderBag): boolean {
  return headers['x-forwarded-for'] !== undefined || headers['x-real-ip'] !== undefined;
}

/** True when the caller is a direct private-network peer, not a client relayed by the edge. */
export function isDirectPrivatePeerOf(headers: HeaderBag, remoteAddress: string | undefined | null): boolean {
  return !wasProxied(headers) && isPrivateNetworkAddress(remoteAddress);
}

function firstHeader(headers: HeaderBag, names: readonly string[]): string | undefined {
  for (const name of names) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export interface InternalVerdictOptions {
  /** The configured secret(s). Empty and undefined entries are ignored; none left fails closed. */
  secrets: ReadonlyArray<string | null | undefined>;
  /** Also read the x-internal-token header. */
  acceptTokenHeader?: boolean;
  /**
   * Read ONLY the x-internal-token header (the HB-7 helpdesk pair: the api's /internal/helpdesk/*
   * routes and helpdesk-api's Bam-proxied agent calls, both keyed by INTERNAL_HELPDESK_SECRET).
   */
  tokenHeaderOnly?: boolean;
}

/** True when the request carries a non-empty x-internal-token header (#306: callers that branch on
 * its presence ask here instead of reading the header themselves). */
export function carriesInternalTokenOf(headers: HeaderBag): boolean {
  return firstHeader(headers, [INTERNAL_TOKEN_HEADER]) !== undefined;
}

/**
 *   ok            secret right, direct private-network peer
 *   unconfigured  no secret configured (respond 401)
 *   bad_secret    secret missing or wrong (respond 401)
 *   not_private   secret right, caller relayed by the edge or not on a private network (respond 403)
 */
export type InternalVerdict = 'ok' | 'unconfigured' | 'bad_secret' | 'not_private';

/** The whole rule, for any server: pass the request headers and the TCP socket peer address. */
export function internalRequestVerdict(
  request: { headers: HeaderBag; remoteAddress: string | undefined | null },
  options: InternalVerdictOptions,
): InternalVerdict {
  const secrets = options.secrets.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (secrets.length === 0) return 'unconfigured';
  const names: readonly string[] = options.tokenHeaderOnly
    ? [INTERNAL_TOKEN_HEADER]
    : options.acceptTokenHeader
      ? [...INTERNAL_SECRET_HEADERS, INTERNAL_TOKEN_HEADER]
      : INTERNAL_SECRET_HEADERS;
  const provided = firstHeader(request.headers, names);
  // Compare against every secret so the timing does not reveal which one matched.
  const matched = provided !== undefined && secrets.map((s) => sameSecret(provided, s)).some(Boolean);
  if (!matched) return 'bad_secret';
  return isDirectPrivatePeerOf(request.headers, request.remoteAddress) ? 'ok' : 'not_private';
}
