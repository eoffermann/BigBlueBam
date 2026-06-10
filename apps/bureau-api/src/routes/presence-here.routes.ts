/**
 * Bureau co-presence by URL (presence-and-immediate-interaction).
 *
 *   GET /v1/presence/here?url=<encoded canonical URL>
 *
 * Returns the list of OTHER users currently reporting the same `locationUrl`
 * on their live Bureau session, deduped by user_id and filtered by the
 * caller's cross-app visibility on the destination URL.
 *
 * Why this exists:
 *   When two people are looking at the same content surface (a Brief doc,
 *   a Board canvas, a Blueprint diagram, a Bond deal, a Bam task, a Beacon
 *   article, a Helpdesk ticket), the UI wants to show a small "X others
 *   here" chip and let either of them open a huddle. The bureau-client SDK
 *   already streams location updates into bureau:sess:* HASH fields via WS
 *   `location_update`; this route reads them back.
 *
 * Implementation:
 *   1. SCAN every bureau:sess:* HASH in Redis, scoped to the caller's org_id.
 *      O(N) on active sessions in the org — fine for v1; a per-URL SET would
 *      make this O(1) but adds a write-side index we don't yet need.
 *   2. Dedupe by userId (multiple devices collapse to one chip).
 *   3. Drop the caller themselves.
 *   4. For each candidate, call cross-app-access.service.ts::resolveAccess
 *      with the caller as `userId` — if THE CALLER cannot see that user's
 *      session on this URL (e.g. a private Board they don't share), the
 *      candidate is dropped silently. Following §10 step 4a: "denial is
 *      private to the denied" — the absence is invisible.
 *   5. Look up display_name + avatar_url from the users table for the
 *      remaining set.
 *
 * Returns: { data: [{ user_id, display_name, avatar_url, status, status_emoji }] }
 */

import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAuth } from '../plugins/auth.js';
import { keys as presenceKeys } from '../services/presence.service.js';
import { resolveAccess } from '../services/cross-app-access.service.js';
import { badRequest } from '../middleware/room-access.js';

const querySchema = z.object({
  url: z.string().min(1).max(2048),
});

/**
 * Best-effort mapping from a canonical URL to a destination "app" name for
 * the cross-app-access preflight. We look at the first path segment of the
 * URL after the host — `/board/...` → `board`, `/brief/...` → `brief`, etc.
 *
 * Returns null for URLs we can't classify; the caller treats null as "no
 * preflight available, allow" so the chip still renders.
 */
function classifyUrlApp(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    const segments = parsed.pathname.split('/').filter(Boolean);
    const first = segments[0];
    if (!first) return null;
    // /b3/... is Bam.
    if (first === 'b3') return 'bam';
    const KNOWN = new Set([
      'board',
      'brief',
      'blueprint',
      'bond',
      'beacon',
      'helpdesk',
      'banter',
      'bolt',
      'bearing',
      'blast',
      'bench',
      'book',
      'blank',
      'bill',
    ]);
    if (KNOWN.has(first)) return first;
    return null;
  } catch {
    return null;
  }
}

interface OccupantHit {
  userId: string;
  status: string;
  statusEmoji: string | null;
}

export default async function presenceHereRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/presence/here',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return badRequest(
          request,
          reply,
          'Invalid query parameters',
          parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
        );
      }
      const targetUrl = parsed.data.url;

      // ── 1. SCAN bureau:sess:* and HGETALL each. We collapse multiple
      //    devices for the same user into one OccupantHit by keeping the
      //    most-informative status (any non-empty wins over empty). ──
      const byUser = new Map<string, OccupantHit>();
      let cursor = '0';
      do {
        const [next, batch] = await fastify.redis.scan(
          cursor,
          'MATCH',
          presenceKeys.sessionScanPattern(),
          'COUNT',
          200,
        );
        cursor = next;
        if (batch.length === 0) continue;

        const pipeline = fastify.redis.pipeline();
        for (const key of batch) pipeline.hgetall(key);
        const results = await pipeline.exec();
        if (!results) continue;

        for (let i = 0; i < batch.length; i++) {
          const entry = results[i];
          if (!entry) continue;
          const [err, hashRaw] = entry;
          if (err) continue;
          const hash = hashRaw as Record<string, string> | null;
          if (!hash || Object.keys(hash).length === 0) continue;

          // Org scope — never leak across orgs.
          if (hash.orgId !== user.org_id) continue;
          // URL match — exact string compare on the canonical URL the SDK
          // reported. (Bureau-client is responsible for canonicalisation.)
          if (hash.locationUrl !== targetUrl) continue;

          const occupantId = hash.userId;
          if (!occupantId) continue;
          // Drop the caller themselves — the chip never says "you".
          if (occupantId === user.id) continue;

          const status = hash.status && hash.status.length > 0 ? hash.status : 'available';
          const emoji = hash.emoji && hash.emoji.length > 0 ? hash.emoji : null;

          // Merge — prefer a hit that has a non-default emoji set.
          const existing = byUser.get(occupantId);
          if (!existing) {
            byUser.set(occupantId, {
              userId: occupantId,
              status,
              statusEmoji: emoji,
            });
          } else if (!existing.statusEmoji && emoji) {
            existing.statusEmoji = emoji;
          }
        }
      } while (cursor !== '0');

      const candidates = Array.from(byUser.values());
      if (candidates.length === 0) {
        return reply.status(200).send({ data: [] });
      }

      // ── 2. Cross-app access filter. Only show users whose presence the
      //    CALLER is allowed to see on this URL. classifyUrlApp returns
      //    null for unknown URLs; in that case we skip the preflight and
      //    let the row through (the chip degrades open rather than going
      //    silent on unmapped surfaces). ──
      const app = classifyUrlApp(targetUrl);
      const visibleIds = new Set<string>();
      if (!app) {
        for (const c of candidates) visibleIds.add(c.userId);
      } else {
        const decisions = await Promise.all(
          candidates.map((c) =>
            resolveAccess({
              orgId: user.org_id,
              userId: user.id,
              app,
              targetUrl,
            })
              .then((d) => ({ id: c.userId, allowed: d.allowed }))
              .catch(() => ({ id: c.userId, allowed: true })),
          ),
        );
        for (const d of decisions) {
          if (d.allowed) visibleIds.add(d.id);
        }
      }

      const visibleIdList = Array.from(visibleIds);
      if (visibleIdList.length === 0) {
        return reply.status(200).send({ data: [] });
      }

      // ── 3. Hydrate display_name + avatar_url. ──
      const userRows = await db
        .select({
          id: users.id,
          display_name: users.display_name,
          avatar_url: users.avatar_url,
        })
        .from(users)
        .where(inArray(users.id, visibleIdList));

      const data = userRows.map((u) => {
        const hit = byUser.get(u.id);
        return {
          user_id: u.id,
          display_name: u.display_name,
          avatar_url: u.avatar_url,
          status: hit?.status ?? 'available',
          status_emoji: hit?.statusEmoji ?? null,
        };
      });

      return reply.status(200).send({ data });
    },
  );
}
