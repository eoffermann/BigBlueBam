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
 * Fetch discipline (the guard is the shared @bigbluebam/egress-guard):
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
import {
  checkUrlSync,
  isBlockedIPv4,
  isBlockedIPv6,
  resolveAndCheckHost,
  safeDispatcher,
} from '@bigbluebam/egress-guard';
import { sql } from 'drizzle-orm';
import {
  TASK_LINK_TITLE_FETCH_QUEUE,
  type TaskLinkTitleFetchJobData,
} from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';

// ── Job types ─────────────────────────────────────────────────────
// Queue name + payload are the shared cross-service contract (one source
// of truth in @bigbluebam/shared so the producer can't drift from us).
export { TASK_LINK_TITLE_FETCH_QUEUE, type TaskLinkTitleFetchJobData };

// ── Constants ─────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 3_000;
const MAX_REDIRECT_HOPS = 3;
const HTML_READ_CAP_BYTES = 64 * 1024;
const TITLE_MAX_LENGTH = 500;
const USER_AGENT = 'BigBlueBam-LinkTitleFetch/1.0';

// ── SSRF guard ────────────────────────────────────────────────────

// The guard (protocol allowlist, internal-name denylist, v4/v6 literal and
// DNS-resolved range checks, connect-time pinning) is @bigbluebam/egress-guard,
// which was lifted from this file so every egress site shares one range table.

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
        // Non-standard undici init field (closes DNS-rebind, see dispatcher
        // above). Cast because lib.dom's RequestInit doesn't declare it; the
        // injected fetchImpl in tests simply ignores the extra key.
        dispatcher: safeDispatcher,
      } as unknown as RequestInit);

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
        ORDER BY ord
      )
      FROM jsonb_array_elements(tasks.links) WITH ORDINALITY AS t(elem, ord)
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
