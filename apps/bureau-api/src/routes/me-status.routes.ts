/**
 * Bureau real-presence endpoints (workstream 13).
 *
 *   GET   /v1/presence            — org-wide presence snapshot (who is on
 *                                    Bureau right now, where, and their status)
 *   GET   /v1/presence/locate     — locate a single user's current room/floor
 *   PATCH /v1/me/status           — set + persist the caller's presence status
 *
 * These back the three MCP tools that previously fell through to a `_stub`
 * envelope (bureau_get_presence / bureau_locate_user / bureau_set_status).
 * They read the SAME live Redis presence substrate the floor view and the
 * floating presence widget use (§7): the per-session `bureau:sess:{id}`
 * HASHes (35s TTL, set + refreshed by the WS hub) for live location, plus
 * the durable, TTL-less `bureau:user:{id}:status` HASH for a chosen status
 * that must outlive a reconnect / apply when an agent has no live web
 * session.
 *
 * Org scoping: every read is filtered to the caller's active org. Status
 * is single-valued per user but stamped with the org it was set in, so a
 * member of two orgs never reads the other org's status (see
 * presence.service.ts::getUserStatus).
 */

import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { requireAuth } from '../plugins/auth.js';
import { badRequest } from '../middleware/room-access.js';
import {
  keys as presenceKeys,
  setStatusForUserSessions,
  setUserStatus,
  type PresenceStatus,
} from '../services/presence.service.js';
import {
  channels as presenceChannels,
  mirrorPresenceToShared,
} from '../services/presence-publisher.service.js';

/**
 * The MCP-facing enum is the four-state subset (available/busy/away/dnd),
 * but the WS hub and DND check accept the full §8 set. We accept the full
 * set so a status set from the floor view's status menu (focus, in_meeting)
 * round-trips through this REST/MCP path too.
 */
const STATUS_VALUES = [
  'available',
  'busy',
  'dnd',
  'focus',
  'away',
  'in_meeting',
] as const;

const setStatusBody = z.object({
  status: z.enum(STATUS_VALUES),
});

const locateQuery = z.object({
  // Accept either ?user= (the bureau_locate_user tool uses this) or
  // ?user_id= for symmetry with the rest of the surface.
  user: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});

interface LivePresence {
  userId: string;
  status: string;
  roomId: string | null;
  floorId: string | null;
  locationUrl: string | null;
  locationApp: string | null;
  locationLabel: string | null;
  lastBeat: number;
}

/**
 * SCAN every live `bureau:sess:*` HASH scoped to one org and collapse the
 * user's devices into one LivePresence each (the most-recent heartbeat
 * wins, so the freshest room/location/status is what we report). Returns a
 * Map keyed by userId. O(N) on live sessions in the org — fine for v1, the
 * same approach presence-here.routes.ts uses.
 */
async function scanOrgPresence(
  fastify: FastifyInstance,
  orgId: string,
): Promise<Map<string, LivePresence>> {
  const byUser = new Map<string, LivePresence>();
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
      if (hash.orgId !== orgId) continue;

      const userId = hash.userId;
      if (!userId) continue;

      const lastBeat = hash.lastBeat ? Number(hash.lastBeat) : 0;
      const candidate: LivePresence = {
        userId,
        status: hash.status && hash.status.length > 0 ? hash.status : 'available',
        roomId: hash.roomId && hash.roomId.length > 0 ? hash.roomId : null,
        floorId: hash.floorId && hash.floorId.length > 0 ? hash.floorId : null,
        locationUrl:
          hash.locationUrl && hash.locationUrl.length > 0 ? hash.locationUrl : null,
        locationApp:
          hash.locationApp && hash.locationApp.length > 0 ? hash.locationApp : null,
        locationLabel:
          hash.locationLabel && hash.locationLabel.length > 0
            ? hash.locationLabel
            : null,
        lastBeat,
      };

      const existing = byUser.get(userId);
      // Keep the freshest session — a user reading on the floor view while
      // a stale pip session lingers should report the floor session.
      if (!existing || candidate.lastBeat >= existing.lastBeat) {
        byUser.set(userId, candidate);
      }
    }
  } while (cursor !== '0');

  return byUser;
}

export default async function meStatusRoutes(fastify: FastifyInstance) {
  // ── GET /v1/presence — org-wide presence snapshot ──
  fastify.get(
    '/presence',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const byUser = await scanOrgPresence(fastify, user.org_id);

      const ids = Array.from(byUser.keys());
      if (ids.length === 0) {
        return reply.status(200).send({ data: [] });
      }

      const userRows = await db
        .select({
          id: users.id,
          display_name: users.display_name,
          avatar_url: users.avatar_url,
        })
        .from(users)
        .where(inArray(users.id, ids));
      const userMap = new Map(userRows.map((u) => [u.id, u]));

      const data = ids.map((id) => {
        const p = byUser.get(id)!;
        const u = userMap.get(id);
        return {
          user_id: id,
          display_name: u?.display_name ?? null,
          avatar_url: u?.avatar_url ?? null,
          status: p.status,
          room_id: p.roomId,
          floor_id: p.floorId,
          location_url: p.locationUrl,
          location_app: p.locationApp,
          location_label: p.locationLabel,
        };
      });

      return reply.status(200).send({ data });
    },
  );

  // ── GET /v1/presence/locate?user=<id> — current room/floor of one user ──
  fastify.get(
    '/presence/locate',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const parsed = locateQuery.safeParse(request.query);
      if (!parsed.success) {
        return badRequest(request, reply, 'Invalid query parameters');
      }
      const targetUserId = parsed.data.user ?? parsed.data.user_id;
      if (!targetUserId) {
        return badRequest(request, reply, '`user` (or `user_id`) is required');
      }

      // Read the target's live sessions directly (cheaper than a full org
      // SCAN for a point lookup). Pick the freshest org-matching session.
      const sessionIds = await fastify.redis.smembers(
        presenceKeys.userSessions(targetUserId),
      );
      let best: LivePresence | null = null;
      if (sessionIds.length > 0) {
        const pipeline = fastify.redis.pipeline();
        for (const sessionId of sessionIds) {
          pipeline.hgetall(presenceKeys.session(sessionId));
        }
        const results = await pipeline.exec();
        for (const entry of results ?? []) {
          if (!entry) continue;
          const [err, hashRaw] = entry;
          if (err) continue;
          const hash = hashRaw as Record<string, string> | null;
          if (!hash || Object.keys(hash).length === 0) continue;
          if (hash.orgId !== user.org_id) continue;
          const lastBeat = hash.lastBeat ? Number(hash.lastBeat) : 0;
          const candidate: LivePresence = {
            userId: targetUserId,
            status:
              hash.status && hash.status.length > 0 ? hash.status : 'available',
            roomId: hash.roomId && hash.roomId.length > 0 ? hash.roomId : null,
            floorId: hash.floorId && hash.floorId.length > 0 ? hash.floorId : null,
            locationUrl:
              hash.locationUrl && hash.locationUrl.length > 0
                ? hash.locationUrl
                : null,
            locationApp:
              hash.locationApp && hash.locationApp.length > 0
                ? hash.locationApp
                : null,
            locationLabel:
              hash.locationLabel && hash.locationLabel.length > 0
                ? hash.locationLabel
                : null,
            lastBeat,
          };
          if (!best || candidate.lastBeat >= best.lastBeat) best = candidate;
        }
      }

      if (!best) {
        // Not located: no live org-matching session. null (not 404) so the
        // tool can distinguish "not in Bureau" from an error.
        return reply.status(200).send({ data: null });
      }

      return reply.status(200).send({
        data: {
          user_id: targetUserId,
          room_id: best.roomId,
          floor_id: best.floorId,
          status: best.status,
          location_url: best.locationUrl,
          location_app: best.locationApp,
          location_label: best.locationLabel,
        },
      });
    },
  );

  // ── PATCH /v1/me/status — set + persist the caller's status ──
  fastify.patch(
    '/me/status',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const parsed = setStatusBody.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(
          request,
          reply,
          'Invalid request body',
          parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
        );
      }
      const status = parsed.data.status as PresenceStatus;

      // 1. Persist the durable choice so it survives reconnects and applies
      //    even with no live session (agent over MCP).
      await setUserStatus(fastify.redis, user.id, user.org_id, status);

      // 2. Fan the new status onto every live session HASH so the floor
      //    view / DND check / presence widget see it immediately.
      const liveSessions = await setStatusForUserSessions(
        fastify.redis,
        user.id,
        status,
      );

      // 3. Best-effort: publish a status_changed delta on the user's floor
      //    so an already-open floor view repaints without a full refresh,
      //    and mirror to the shared cross-app presence channel.
      const sessionIds = await fastify.redis.smembers(
        presenceKeys.userSessions(user.id),
      );
      const seenFloors = new Set<string>();
      for (const sessionId of sessionIds) {
        const floorId = await fastify.redis.hget(
          presenceKeys.session(sessionId),
          'floorId',
        );
        if (floorId && floorId.length > 0 && !seenFloors.has(floorId)) {
          seenFloors.add(floorId);
          const payload = JSON.stringify({
            type: 'status_changed',
            data: { userId: user.id, status, statusText: null, emoji: null },
            timestamp: new Date().toISOString(),
          });
          await fastify.redis
            .publish(presenceChannels.floor(floorId), payload)
            .catch(() => {
              /* best effort */
            });
        }
      }
      await mirrorPresenceToShared(fastify.redis, user.id, status, {
        orgId: user.org_id,
      }).catch(() => {
        /* best effort */
      });

      return reply.status(200).send({
        data: { status, live_sessions: liveSessions, persisted: true },
      });
    },
  );
}
