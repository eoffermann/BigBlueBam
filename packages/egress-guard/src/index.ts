// @bigbluebam/egress-guard: one SSRF guard for every server-side fetch of a
// URL or host that a user, an org admin or an external system controls.
//
// Before this package the suite had several partial copies of "reject private
// IPs" (literal-IP only, or a three-name hostname denylist) and some fetches
// with none at all (Book's ICS feed sync, the worker's Slack import download,
// the SMTP test routes). The worker's task-link-title fetch was the one
// complete implementation; this is that implementation, lifted so the range
// tables cannot drift again (the packages/smtp-resolver precedent).
//
// A guard needs all of these:
//  1. Protocol allowlist (http/https). file:, gopher: and friends are refused.
//  2. Hostname denylist: localhost, *.internal, cloud metadata names.
//  3. Literal-IP range checks for v4 and v6, including v4-mapped v6, which
//     URL.hostname normalizes into hex (::ffff:a00:1) so a dotted check misses it.
//  4. DNS resolution: a literal-IP check proves nothing about a DNS name that
//     points at 169.254.169.254.
//  5. Connect-time pinning: fetch re-resolves on connect, so a hostile resolver
//     can answer public for the check and private for the connect. The address
//     dialed must be the address vetted (safeDispatcher).
//  6. Per-hop redirect revalidation: redirect 'follow' lets a vetted public URL
//     302 to the metadata service. safeFetch follows redirects itself.
//
// Operator allowlist (EGRESS_ALLOW_PRIVATE_HOSTS). Some self-hosted stacks
// legitimately fetch from their own network: the GILLIGAN demo seed serves its
// Book calendar feed from the stack's MinIO (http://minio:9000/...) so the
// demo needs no internet (#247). EGRESS_ALLOW_PRIVATE_HOSTS is a comma list of
// exact "host" or "host:port" entries that skip the private-address checks.
// It is empty unless set: docker-compose.yml sets minio:9000 for book-api on
// the local stack, and the Railway service catalog never sets it. It matches
// the URL's literal host, so it cannot be reached through a public name, a
// redirect to a different host, or a different port.

import { isIP } from 'node:net';
import { lookup as lookupAsync } from 'node:dns/promises';
import { lookup as lookupCb } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';

// ── Range tables ──────────────────────────────────────────────────────────

const BLOCKED_IPV4_RANGES = [
  { start: [10, 0, 0, 0] as const, mask: 8 }, // RFC1918
  { start: [172, 16, 0, 0] as const, mask: 12 }, // RFC1918
  { start: [192, 168, 0, 0] as const, mask: 16 }, // RFC1918
  { start: [127, 0, 0, 0] as const, mask: 8 }, // loopback
  { start: [169, 254, 0, 0] as const, mask: 16 }, // link-local, cloud metadata
  { start: [0, 0, 0, 0] as const, mask: 8 }, // "this network"
  { start: [100, 64, 0, 0] as const, mask: 10 }, // CGNAT (Alibaba metadata 100.100.100.200)
  { start: [198, 18, 0, 0] as const, mask: 15 }, // benchmarking
  { start: [192, 0, 0, 0] as const, mask: 24 }, // IETF protocol assignments
  { start: [192, 0, 2, 0] as const, mask: 24 }, // TEST-NET-1
  { start: [198, 51, 100, 0] as const, mask: 24 }, // TEST-NET-2
  { start: [203, 0, 113, 0] as const, mask: 24 }, // TEST-NET-3
  { start: [224, 0, 0, 0] as const, mask: 4 }, // multicast
  { start: [240, 0, 0, 0] as const, mask: 4 }, // reserved, incl. broadcast
] as const;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google',
  'metadata.google.internal',
  'instance-data',
]);

/** Suffixes that only ever name internal infrastructure. */
const BLOCKED_HOST_SUFFIXES = ['.internal', '.local', '.localdomain', '.localhost'];

function ipv4ToNum(parts: readonly number[]): number {
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

export function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const num = ipv4ToNum(parts);
  return BLOCKED_IPV4_RANGES.some((range) => {
    const mask = (~0 << (32 - range.mask)) >>> 0;
    return (num & mask) === (ipv4ToNum(range.start) & mask);
  });
}

export function isBlockedIPv6(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (clean === '::1' || clean === '::') return true;
  if (/^f[cd]/.test(clean)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(clean)) return true; // fe80::/10 link-local
  if (/^ff/.test(clean)) return true; // ff00::/8 multicast

  const v4Mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped?.[1]) return isBlockedIPv4(v4Mapped[1]);

  const v4MappedHex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex?.[1] && v4MappedHex[2]) {
    const hi = Number.parseInt(v4MappedHex[1], 16);
    const lo = Number.parseInt(v4MappedHex[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return false;
}

export function isBlockedAddress(address: string, family: number): boolean {
  return family === 4 ? isBlockedIPv4(address) : isBlockedIPv6(address);
}

// ── Operator allowlist ────────────────────────────────────────────────────

let warnedAllowlist = false;

/** Parsed EGRESS_ALLOW_PRIVATE_HOSTS ("host" or "host:port", lowercased). */
export function allowedPrivateHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.EGRESS_ALLOW_PRIVATE_HOSTS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True when the operator allowlisted this exact host (any port) or host:port. */
export function isAllowlistedHost(hostname: string, port?: string | number, env: NodeJS.ProcessEnv = process.env): boolean {
  const allow = allowedPrivateHosts(env);
  if (allow.size === 0) return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hit = allow.has(host) || (port !== undefined && port !== '' && allow.has(`${host}:${port}`));
  if (hit && !warnedAllowlist) {
    warnedAllowlist = true;
    console.warn(
      `[egress-guard] EGRESS_ALLOW_PRIVATE_HOSTS lets this process reach private hosts: ${[...allow].join(', ')}`,
    );
  }
  return hit;
}

function urlPort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '';
}

// ── Result types ──────────────────────────────────────────────────────────

export interface UrlCheckResult {
  safe: boolean;
  reason?: string;
  parsed?: URL;
  /** The host matched EGRESS_ALLOW_PRIVATE_HOSTS, so private checks were skipped. */
  allowlisted?: boolean;
}

export class EgressBlockedError extends Error {
  readonly code = 'EGRESS_BLOCKED';
  constructor(reason: string) {
    super(reason);
    this.name = 'EgressBlockedError';
  }
}

export interface EgressCheckOptions {
  /** Extra protocols to permit. http/https are always allowed. */
  allowedProtocols?: string[];
  /**
   * Skip DNS resolution. Only for callers that cannot await (a Zod refine)
   * and that have a real fetch-time guard behind them.
   */
  skipDns?: boolean;
  /** Override process.env (tests). */
  env?: NodeJS.ProcessEnv;
}

// ── Sync checks (protocol / hostname / literal IP) ────────────────────────

export function checkUrlSync(rawUrl: string, opts: EgressCheckOptions = {}): UrlCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  const allowed = new Set(['http:', 'https:', ...(opts.allowedProtocols ?? [])]);
  if (!allowed.has(parsed.protocol)) {
    return { safe: false, reason: `Protocol "${parsed.protocol}" is not allowed` };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return { safe: false, reason: 'URL has no hostname' };

  if (isAllowlistedHost(hostname, urlPort(parsed), opts.env)) {
    return { safe: true, parsed, allowlisted: true };
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: `Hostname "${hostname}" is not allowed` };
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return { safe: false, reason: `Hostname "${hostname}" appears to be an internal address` };
    }
  }

  const bare = hostname.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(bare);
  if (ipVersion === 4 && isBlockedIPv4(bare)) {
    return { safe: false, reason: 'Private/internal IPv4 addresses are not allowed' };
  }
  if ((ipVersion === 6 || hostname.startsWith('[')) && isBlockedIPv6(bare)) {
    return { safe: false, reason: 'Private/internal IPv6 addresses are not allowed' };
  }

  return { safe: true, parsed };
}

// ── DNS check ─────────────────────────────────────────────────────────────

/**
 * Resolve a hostname and reject when ANY resolved address is private: a name
 * answering with both a public and a private address is a rebind attempt, not
 * a legitimate target. Literal IPs skip the lookup (checkUrlSync vetted them).
 */
export async function resolveAndCheckHost(hostname: string): Promise<UrlCheckResult> {
  const clean = hostname.replace(/^\[|\]$/g, '');
  if (isIP(clean) !== 0) return { safe: true };

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupAsync(clean, { all: true, verbatim: true });
  } catch {
    return { safe: false, reason: 'DNS resolution failed' };
  }
  if (addresses.length === 0) {
    return { safe: false, reason: 'DNS resolution returned no addresses' };
  }
  for (const addr of addresses) {
    if (isBlockedAddress(addr.address, addr.family)) {
      return { safe: false, reason: 'Hostname resolves to a private/internal address' };
    }
  }
  return { safe: true };
}

/** Full check: sync rules, then DNS (unless skipDns or allowlisted). */
export async function checkUrl(rawUrl: string, opts: EgressCheckOptions = {}): Promise<UrlCheckResult> {
  const sync = checkUrlSync(rawUrl, opts);
  if (!sync.safe || !sync.parsed) return sync;
  if (sync.allowlisted || opts.skipDns) return sync;

  const dns = await resolveAndCheckHost(sync.parsed.hostname);
  if (!dns.safe) return { safe: false, reason: dns.reason };
  return { safe: true, parsed: sync.parsed };
}

/** checkUrl, but throws EgressBlockedError instead of returning a result. */
export async function assertSafeUrl(rawUrl: string, opts: EgressCheckOptions = {}): Promise<URL> {
  const res = await checkUrl(rawUrl, opts);
  if (!res.safe || !res.parsed) {
    throw new EgressBlockedError(res.reason ?? 'Blocked by egress policy');
  }
  return res.parsed;
}

/**
 * Host check for clients that are not fetch and do their own DNS (nodemailer).
 * It resolves and vets every address before the caller connects. This is
 * inherently time-of-check/time-of-use: the client's socket cannot be pinned
 * to the vetted address the way safeDispatcher pins undici's. It closes the
 * "point smtp_host at an internal host" case; a determined DNS rebind against
 * the SMTP test remains theoretically possible.
 */
export async function assertSafeHost(hostname: string, port?: number, env?: NodeJS.ProcessEnv): Promise<void> {
  const host = (hostname ?? '').trim().toLowerCase();
  if (!host) throw new EgressBlockedError('No host supplied');
  if (isAllowlistedHost(host, port, env)) return;

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new EgressBlockedError(`Host "${host}" is not allowed`);
  }
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      throw new EgressBlockedError(`Host "${host}" appears to be an internal address`);
    }
  }

  const bare = host.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(bare);
  if (ipVersion !== 0) {
    if (isBlockedAddress(bare, ipVersion)) {
      throw new EgressBlockedError('Private/internal addresses are not allowed');
    }
    return;
  }

  const dns = await resolveAndCheckHost(bare);
  if (!dns.safe) throw new EgressBlockedError(dns.reason ?? 'Blocked by egress policy');
}

// ── Pinned dispatcher (closes DNS rebind) ─────────────────────────────────

/**
 * undici Agent that vets the addresses inside the lookup undici connects
 * with, so the address dialed is the address checked. Module-level so the
 * connection pool is shared.
 */
export const safeDispatcher = new Agent({
  connect: {
    lookup(
      hostname: string,
      _options: unknown,
      callback: (err: Error | null, address: string, family: number) => void,
    ) {
      lookupCb(hostname, { all: true, verbatim: true }, (err, addresses) => {
        if (err) return callback(err, '', 0);
        if (!Array.isArray(addresses) || addresses.length === 0) {
          return callback(new Error('DNS resolution returned no addresses'), '', 0);
        }
        for (const a of addresses) {
          if (isBlockedAddress(a.address, a.family)) {
            return callback(new Error('Hostname resolves to a private/internal address'), '', 0);
          }
        }
        const chosen = addresses[0]!;
        callback(null, chosen.address, chosen.family);
      });
    },
  },
});

/** Unpinned dispatcher, used only for EGRESS_ALLOW_PRIVATE_HOSTS matches. */
const allowlistDispatcher = new Agent();

// ── safeFetch ─────────────────────────────────────────────────────────────

export interface SafeFetchOptions extends EgressCheckOptions {
  /** Max redirect hops to follow. Each hop is fully revalidated. Default 5. */
  maxRedirects?: number;
  /**
   * Drop these headers once a redirect leaves the original origin (for
   * example Authorization, so a bearer token never follows a redirect).
   */
  stripHeadersOnCrossOrigin?: string[];
  /** Override the fetch implementation (tests). Defaults to undici's fetch,
   *  which is guaranteed to accept the undici dispatcher used for pinning. */
  fetchImpl?: typeof fetch;
}

function stripHeaders(headers: Headers, names: string[]): Headers {
  const out = new Headers(headers);
  for (const n of names) out.delete(n);
  return out;
}

/**
 * fetch() with the guard applied to the initial URL and to every redirect
 * hop. Uses redirect 'manual' and follows the chain itself, because with
 * 'follow' a vetted public URL could 302 to the metadata service unseen.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
  const maxRedirects = opts.maxRedirects ?? 5;
  const stripNames = opts.stripHeadersOnCrossOrigin ?? [];

  let currentUrl = rawUrl;
  let headers = new Headers(init.headers ?? {});
  let initialOrigin: string | null = null;
  try {
    initialOrigin = new URL(rawUrl).origin;
  } catch {
    initialOrigin = null;
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await checkUrl(currentUrl, opts);
    if (!check.safe || !check.parsed) {
      throw new EgressBlockedError(check.reason ?? 'Blocked by egress policy');
    }
    const parsed = check.parsed;

    if (stripNames.length > 0 && initialOrigin && parsed.origin !== initialOrigin) {
      headers = stripHeaders(headers, stripNames);
    }

    const res = await doFetch(currentUrl, {
      ...init,
      headers,
      redirect: 'manual',
      // undici-specific init field; pins the connection to the vetted address.
      dispatcher: check.allowlisted ? allowlistDispatcher : safeDispatcher,
    } as unknown as RequestInit);

    const isRedirect = res.status >= 300 && res.status <= 399 && res.headers.has('location');
    if (!isRedirect) return res;

    if (hop === maxRedirects) {
      throw new EgressBlockedError(`Too many redirects (>${maxRedirects})`);
    }
    currentUrl = new URL(res.headers.get('location')!, parsed).toString();
  }

  throw new EgressBlockedError('Redirect loop');
}
