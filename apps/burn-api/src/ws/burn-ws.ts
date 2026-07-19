// The /burn/ws hub. Spec 6.2.
//
// One Redis subscriber per burn-api process, fanning frames out to the sockets whose
// room set contains the frame's room. Rooms are resolved ONCE at connect and cached, which
// is the requirement spec 6.2 states as "the membership check on fan-out is served from the
// Redis-cached PermissionContext, not a DB round-trip per frame per subscriber".
//
// ── A DELIBERATE DEVIATION FROM THE LETTER OF 6.2, AND WHY ────────────────────────────
//
// The spec names the `@bigbluebam/permissions` Redis-cached `PermissionContext` as the
// source of the membership check. That object (packages/permissions/src/types.ts:53) carries
// `subject`, `memberships` (ACCOUNT GROUP memberships, scope_type/scope_id), account
// overrides, group defaults, and agent policy. It does NOT carry raw `project_memberships`
// rows. A user can be a member of a project without holding any project-scoped permission
// GROUP, so deriving project membership from `memberships` would silently drop frames for
// ordinary project members -- and any looser mapping (treating every project-scoped group
// membership as project membership) would over-deliver, which on a surface whose whole
// purpose is project-scoped fan-out is the wrong direction to be wrong in.
//
// So this implements the ACTUAL requirement -- no per-frame, per-subscriber DB round trip --
// with a source that is correct for the question being asked: the subscriber's project id
// set is read ONCE at connect through the same predicate the REST layer uses, then cached in
// Redis under `burn:ws:projects:<user>:<org>` for the permissions package's own
// DEFAULT_TTL_SECONDS. Per-frame delivery is a set lookup in process memory. A membership
// change takes at most one TTL to propagate to an already-open socket, which is acceptable
// precisely because frames are advisory and the client refetches on reconnect.
//
// This deviation is recorded here rather than in a commit message because the next person to
// read 6.2 will otherwise "fix" it back.

import type { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { DEFAULT_TTL_SECONDS } from '@bigbluebam/permissions';
import { env } from '../env.js';
import { BURN_WS_CHANNEL, burnAdminRoom, burnProjectRoom } from '../lib/realtime.js';
import { memberProjectIds } from '../lib/project-scope.js';
import { viewerOf } from '../lib/http.js';
import { isAdminViewer } from '../services/types.js';

/**
 * The socket surface this hub actually uses.
 *
 * Declared structurally rather than importing `WebSocket` from `ws`: `ws` is a transitive
 * dependency of @fastify/websocket and is not a direct dependency of burn-api, so importing
 * its types here would compile today and break the moment the transitive tree shifts. Four
 * methods is the entire contract.
 */
interface BurnSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'close' | 'error', listener: () => void): void;
}

interface Subscriber {
  socket: BurnSocket;
  rooms: Set<string>;
}

const PROJECT_SET_KEY = (userId: string, orgId: string) => `burn:ws:projects:${userId}:${orgId}`;

/**
 * The subscriber's project id set, from Redis when warm and from one indexed DB query when
 * cold. Never throws: a Redis outage degrades to the DB read rather than dropping the
 * connection, because losing realtime on a Redis blip would be a worse failure than one
 * extra query per connect.
 */
async function cachedProjectIds(
  fastify: FastifyInstance,
  userId: string,
  orgId: string,
): Promise<string[]> {
  const key = PROJECT_SET_KEY(userId, orgId);
  try {
    const cached = await fastify.redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as unknown;
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
        return parsed as string[];
      }
    }
  } catch {
    /* fall through to the DB read */
  }
  const ids = await memberProjectIds(userId);
  try {
    await fastify.redis.set(key, JSON.stringify(ids), 'EX', DEFAULT_TTL_SECONDS);
  } catch {
    /* cache write is best-effort */
  }
  return ids;
}

export default async function registerBurnWs(fastify: FastifyInstance) {
  const subscribers = new Set<Subscriber>();

  // ONE subscriber connection per process, not one per socket. A firm with 40 open Burn tabs
  // would otherwise hold 40 Redis connections against a `--maxmemory 256mb` instance that
  // spec 5.5.3 already identifies as a hard dependency under pressure.
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  sub.on('error', (err) => fastify.log.warn({ err }, 'burn ws redis subscriber error'));
  await sub.connect();
  await sub.subscribe(BURN_WS_CHANNEL);

  sub.on('message', (_channel, raw) => {
    let envelope: { room?: string; event?: unknown };
    try {
      envelope = JSON.parse(raw) as { room?: string; event?: unknown };
    } catch {
      return;
    }
    const room = envelope.room;
    if (!room || envelope.event === undefined) return;
    const payload = JSON.stringify(envelope.event);
    for (const s of subscribers) {
      if (!s.rooms.has(room)) continue;
      try {
        s.socket.send(payload);
      } catch {
        /* a dead socket is reaped by its own close handler */
      }
    }
  });

  fastify.addHook('onClose', async () => {
    try {
      await sub.quit();
    } catch {
      /* ignore */
    }
  });

  fastify.get('/ws', { websocket: true }, async (connection, request) => {
      const socket = connection as unknown as BurnSocket;

    // Authentication is the auth plugin's preHandler, which has already run. An
    // unauthenticated socket is closed immediately rather than left open with an empty room
    // set: an open socket that receives nothing looks like a bug to the client and invites
    // a retry loop.
    if (!request.user) {
      try {
        socket.close(4401, 'Authentication required');
      } catch {
        /* ignore */
      }
      return;
    }

    const viewer = viewerOf(request);
    const rooms = new Set<string>();
    if (isAdminViewer(viewer)) {
      rooms.add(burnAdminRoom(viewer.org_id));
    } else {
      for (const projectId of await cachedProjectIds(fastify, viewer.id, viewer.org_id)) {
        rooms.add(burnProjectRoom(viewer.org_id, projectId));
      }
    }

    const entry: Subscriber = { socket, rooms };
    subscribers.add(entry);

    // The client refetches on reconnect (spec 6.2), so the server sends a `ready` marker and
    // no backlog. There is deliberately no replay buffer: a backlog would be a second,
    // weaker copy of the REST read path, and the moment it exists someone treats it as
    // authoritative.
    try {
      socket.send(JSON.stringify({ type: 'ready', rooms: rooms.size }));
    } catch {
      /* ignore */
    }

    socket.on('close', () => {
      subscribers.delete(entry);
    });
    socket.on('error', () => {
      subscribers.delete(entry);
    });
  });
}
