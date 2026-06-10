/**
 * Task link title-fetch job (bam-csv-import-plan §4.3 item 3, Phase 0).
 *
 * Queue name: 'task-link-title-fetch' (enqueue-driven, no cron).
 * Payload:    { task_id: string; link_id: string; url: string }
 * Producer:   apps/api/src/services/task-links-queue.service.ts
 *             (enqueueTaskLinkTitleFetch — fire-and-forget).
 *
 * GETs an external link's page, extracts og:title / <title>, and patches
 * the matching entry in tasks.links — but ONLY if the entry's title is
 * still null with title_source 'none' (a user rename that lands while the
 * job is queued always wins).
 *
 * Fetch discipline (mirrors the Wave-5 outbound-webhook sender; the guard
 * is duplicated locally because the worker stays decoupled from apps/api
 * imports — see apps/api/src/lib/webhook-url-validator.ts):
 *   - http/https only; hostnames AND every DNS-resolved address are checked
 *     against private/loopback/link-local/metadata ranges (10/8, 172.16/12,
 *     192.168/16, 127/8, 169.254/16, 0/8, ::1, fc00::/7, fe80::/10,
 *     ::ffff:-mapped v4).
 *   - redirect: 'manual', up to 3 hops, every Location re-validated.
 *   - 3s AbortSignal timeout per request (covers the body read).
 *   - Only the first 64KB of the body is read (well under the 256KB cap);
 *     <title>/og:title live in <head> so that is always enough.
 *   - ANY failure (unreachable, non-2xx, junk content, redirect to a
 *     private range) falls back silently: the link keeps title null and
 *     the UI shows the hostname. Logged at warn, never thrown.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

// ── Job types ─────────────────────────────────────────────────────

export const TASK_LINK_TITLE_FETCH_QUEUE = 'task-link-title-fetch';

export interface TaskLinkTitleFetchJobData {
  task_id: string;
  link_id: string;
  url: string;
}

// ── Constants ─────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 3_000;
const MAX_REDIRECT_HOPS = 3;
const HTML_READ_CAP_BYTES = 64 * 1024;
const TITLE_MAX_LENGTH = 500;
const USER_AGENT = 'BigBlueBam-LinkTitleFetch/1.0';

// ── SSRF guard ────────────────────────────────────────────────────

const BLOCKED_IPV4_RANGES = [
  { start: [10, 0, 0, 0] as const, mask: 8 }, // RFC1918
  { start: [172, 16, 0, 0] as const, mask: 12 }, // RFC1918
  { start: [192, 168, 0, 0] as const, mask: 16 }, // RFC1918
  { start: [127, 0, 0, 0] as const, mask: 8 }, // loopback
  { start: [169, 254, 0, 0] as const, mask: 16 }, // link-local + cloud metadata
  { start: [0, 0, 0, 0] as const, mask: 8 }, // "this network"
  { start: [100, 64, 0, 0] as const, mask: 10 }, // CGNAT (Alibaba metadata 100.100.100.200)
  { start: [198, 18, 0, 0] as const, mask: 15 }, // benchmarking
] as const;

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata.google']);

function ipv4ToNum(parts: readonly number[]): number {
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function isBlockedIPv4(ip: string): boolean {
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

function isBlockedIPv6(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '');
  if (clean === '::1') return true;
  if (/^f[cd]/i.test(clean)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/i.test(clean)) return true; // fe80::/10 link-local
  const v4Mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped?.[1]) return isBlockedIPv4(v4Mapped[1]);
  // URL.hostname normalizes v4-mapped addresses to hex hextets
  // ("[::ffff:10.0.0.1]" parses as "::ffff:a00:1") — convert back.
  const v4MappedHex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4MappedHex?.[1] && v4MappedHex[2]) {
    const hi = Number.parseInt(v4MappedHex[1], 16);
    const lo = Number.parseInt(v4MappedHex[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return false;
}

interface UrlCheckResult {
  safe: boolean;
  reason?: string;
  parsed?: URL;
}

/** Synchronous checks: protocol, blocked hostnames, literal-IP ranges. */
function checkUrlSync(rawUrl: string): UrlCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: 'Only http and https URLs are allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: `Hostname "${hostname}" is not allowed` };
  }
  if (hostname.endsWith('.internal')) {
    return { safe: false, reason: `Hostname "${hostname}" appears to be an internal address` };
  }

  const ipVersion = isIP(hostname.replace(/^\[|\]$/g, ''));
  if (ipVersion === 4 && isBlockedIPv4(hostname)) {
    return { safe: false, reason: 'Private/internal IPv4 addresses are not allowed' };
  }
  if ((ipVersion === 6 || hostname.startsWith('[')) && isBlockedIPv6(hostname)) {
    return { safe: false, reason: 'Private/internal IPv6 addresses are not allowed' };
  }

  return { safe: true, parsed };
}

/**
 * Resolve a hostname and reject if ANY resolved address is private.
 * Literal IPs skip the lookup (already vetted by checkUrlSync).
 */
async function resolveAndCheckHost(hostname: string): Promise<UrlCheckResult> {
  const clean = hostname.replace(/^\[|\]$/g, '');
  if (isIP(clean) !== 0) return { safe: true };

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(clean, { all: true, verbatim: true });
  } catch {
    return { safe: false, reason: 'DNS resolution failed' };
  }
  if (addresses.length === 0) {
    return { safe: false, reason: 'DNS resolution returned no addresses' };
  }
  for (const addr of addresses) {
    const blocked =
      addr.family === 4 ? isBlockedIPv4(addr.address) : isBlockedIPv6(addr.address);
    if (blocked) {
      return { safe: false, reason: 'Hostname resolves to a private/internal address' };
    }
  }
  return { safe: true };
}

// ── Title extraction ──────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function cleanTitle(raw: string): string | null {
  const cleaned = decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/** og:title wins over <title> (usually cleaner: no "| Site Name" suffix). */
function extractTitle(html: string): string | null {
  const ogPatterns = [
    /<meta[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i,
    /<meta[^>]*content\s*=\s*["']([^"']*)["'][^>]*property\s*=\s*["']og:title["']/i,
  ];
  for (const pattern of ogPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const title = cleanTitle(match[1]);
      if (title) return title;
    }
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return cleanTitle(titleMatch[1]);
  return null;
}

// ── Guarded fetch ─────────────────────────────────────────────────

async function readBodyPrefix(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < HTML_READ_CAP_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = Buffer.concat(chunks).subarray(0, HTML_READ_CAP_BYTES);
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/**
 * Fetch the page and extract a title. Returns null on ANY failure —
 * the caller treats null as "leave the link untitled".
 */
async function fetchPageTitle(
  rawUrl: string,
  logger: Logger,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const check = checkUrlSync(currentUrl);
    if (!check.safe || !check.parsed) {
      logger.warn(
        { url: rawUrl, currentUrl, reason: check.reason },
        'task-link-title-fetch: URL rejected by SSRF guard',
      );
      return null;
    }
    const dnsCheck = await resolveAndCheckHost(check.parsed.hostname);
    if (!dnsCheck.safe) {
      logger.warn(
        { url: rawUrl, currentUrl, reason: dnsCheck.reason },
        'task-link-title-fetch: hostname rejected by SSRF guard',
      );
      return null;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(check.parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': USER_AGENT,
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location) {
          logger.warn(
            { url: rawUrl, currentUrl, status: res.status },
            'task-link-title-fetch: redirect without Location header',
          );
          return null;
        }
        // Re-validated at the top of the next iteration.
        currentUrl = new URL(location, check.parsed).toString();
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        logger.warn(
          { url: rawUrl, currentUrl, status: res.status },
          'task-link-title-fetch: non-2xx response',
        );
        return null;
      }

      const contentType = res.headers.get('content-type');
      if (contentType && !/html/i.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        logger.warn(
          { url: rawUrl, currentUrl, contentType },
          'task-link-title-fetch: non-HTML content type',
        );
        return null;
      }

      const html = await readBodyPrefix(res.body);
      return extractTitle(html);
    } catch (err) {
      logger.warn(
        { url: rawUrl, currentUrl, err: err instanceof Error ? err.message : String(err) },
        'task-link-title-fetch: fetch failed',
      );
      return null;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  logger.warn({ url: rawUrl }, 'task-link-title-fetch: too many redirects');
  return null;
}

// ── Processor ─────────────────────────────────────────────────────

export async function processTaskLinkTitleFetchJob(
  job: Job<TaskLinkTitleFetchJobData>,
  logger: Logger,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const { task_id, link_id, url } = job.data;

  const title = await fetchPageTitle(url, logger, opts.fetchImpl ?? fetch);
  if (!title) {
    // Best-effort by design: the link stays untitled and the UI falls
    // back to hostname display. Already logged at warn inside the fetch.
    return;
  }

  const db = getDb();

  // Rebuild the links array, patching only the matching entry — and only
  // while its title is still null with title_source 'none'. The WHERE
  // EXISTS guard makes the whole UPDATE a no-op if a user assigned a
  // title (or removed the link) while this job sat in the queue, and
  // guarantees jsonb_agg never collapses a non-matching row set to NULL.
  const updated = await db.execute<{ id: string }>(sql`
    UPDATE tasks
    SET links = (
      SELECT jsonb_agg(
        CASE
          WHEN elem->>'id' = ${link_id}
           AND elem->>'title' IS NULL
           AND elem->>'title_source' = 'none'
          THEN elem || jsonb_build_object('title', ${title}::text, 'title_source', 'fetched')
          ELSE elem
        END
      )
      FROM jsonb_array_elements(tasks.links) AS elem
    ),
    updated_at = NOW()
    WHERE id = ${task_id}
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(tasks.links) AS pending
        WHERE pending->>'id' = ${link_id}
          AND pending->>'title' IS NULL
          AND pending->>'title_source' = 'none'
      )
    RETURNING id
  `);

  const row = updated[0] as { id: string } | undefined;
  if (!row) {
    logger.info(
      { jobId: job.id, task_id, link_id },
      'task-link-title-fetch: link gone or already titled, skipping',
    );
    return;
  }

  logger.info(
    { jobId: job.id, task_id, link_id, title },
    'task-link-title-fetch: title patched onto task link',
  );
}

// ── Test harness ──────────────────────────────────────────────────

export const __test__ = {
  checkUrlSync,
  resolveAndCheckHost,
  isBlockedIPv4,
  isBlockedIPv6,
  extractTitle,
  decodeHtmlEntities,
  fetchPageTitle,
  FETCH_TIMEOUT_MS,
  MAX_REDIRECT_HOPS,
  HTML_READ_CAP_BYTES,
  TITLE_MAX_LENGTH,
};
