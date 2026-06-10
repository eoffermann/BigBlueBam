import { URL } from 'node:url';
import { isIP } from 'node:net';

/**
 * Webhook URL validation for AGENTIC_TODO §20 Wave 5.
 *
 * Diverges from the general `validateExternalUrl` in two places:
 *   - https:// is REQUIRED when NODE_ENV === 'production'. http:// is
 *     permitted in development and test so local Playwright harnesses can
 *     target plain-HTTP mock receivers.
 *   - 10.0.0.0/8 is permitted when NODE_ENV === 'test', because our docker
 *     compose test network falls inside that range. Every other private /
 *     loopback / link-local range is always rejected.
 *
 * Returns `{ safe: true }` or `{ safe: false, reason: string }`. The caller
 * is expected to log the reason at warn or info level and surface it to
 * the operator configuring the webhook.
 */

const RFC1918_10 = { start: [10, 0, 0, 0], mask: 8 } as const;
// Always blocked private ranges (excludes 10.0.0.0/8 which is test-conditional).
const ALWAYS_BLOCKED_IPV4_RANGES = [
  // 172.16.0.0/12
  { start: [172, 16, 0, 0], mask: 12 },
  // 192.168.0.0/16
  { start: [192, 168, 0, 0], mask: 16 },
  // 127.0.0.0/8 loopback
  { start: [127, 0, 0, 0], mask: 8 },
  // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254)
  { start: [169, 254, 0, 0], mask: 16 },
  // 0.0.0.0/8
  { start: [0, 0, 0, 0], mask: 8 },
  // 100.64.0.0/10 CGNAT (Alibaba Cloud metadata lives at 100.100.100.200)
  { start: [100, 64, 0, 0], mask: 10 },
  // 198.18.0.0/15 benchmarking
  { start: [198, 18, 0, 0], mask: 15 },
] as const;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
]);

function ipv4ToNum(parts: readonly number[]): number {
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function matchIPv4Range(num: number, range: { start: readonly number[]; mask: number }): boolean {
  const rangeStart = ipv4ToNum(range.start);
  const mask = (~0 << (32 - range.mask)) >>> 0;
  return (num & mask) === (rangeStart & mask);
}

function isBlockedIPv4(ip: string, allow10: boolean): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const num = ipv4ToNum(parts);
  for (const range of ALWAYS_BLOCKED_IPV4_RANGES) {
    if (matchIPv4Range(num, range)) return true;
  }
  if (!allow10 && matchIPv4Range(num, RFC1918_10)) return true;
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '');
  if (clean === '::1') return true;
  // fc00::/7 (unique local)
  if (/^f[cd]/i.test(clean)) return true;
  // fe80::/10 (link-local)
  if (/^fe[89ab]/i.test(clean)) return true;
  const v4Mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) {
    // Don't use the 10/8 bypass for mapped addresses; an attacker who
    // tunnels a 10.x target through ::ffff: is almost certainly doing it
    // on purpose.
    return isBlockedIPv4(v4Mapped[1]!, false);
  }
  return false;
}

export interface WebhookUrlValidationResult {
  safe: boolean;
  reason?: string;
}

export function validateWebhookUrl(
  rawUrl: string,
  nodeEnv: string = process.env.NODE_ENV ?? 'development',
): WebhookUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: 'Only http and https URLs are allowed' };
  }
  if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
    return { safe: false, reason: 'https:// is required in production' };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: `Hostname "${hostname}" is not allowed` };
  }

  if (hostname === '169.254.169.254') {
    return { safe: false, reason: 'Cloud metadata endpoint is not allowed' };
  }

  const allow10 = nodeEnv === 'test';

  if (isIP(hostname) === 4) {
    if (isBlockedIPv4(hostname, allow10)) {
      return { safe: false, reason: 'Private/internal IPv4 addresses are not allowed' };
    }
  } else if (isIP(hostname) === 6 || hostname.startsWith('[')) {
    if (isBlockedIPv6(hostname)) {
      return { safe: false, reason: 'Private/internal IPv6 addresses are not allowed' };
    }
  }

  if (hostname.endsWith('.internal')) {
    return { safe: false, reason: `Hostname "${hostname}" appears to be an internal address` };
  }

  return { safe: true };
}
