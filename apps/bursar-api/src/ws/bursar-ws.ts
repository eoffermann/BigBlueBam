// The /bursar/ws hub (spec 11.1, issue #121). nginx proxies /bursar/ws to bursar-api's /ws.
//
// The SPA (apps/bursar/src/hooks/use-bursar-realtime.ts) connects with `?rooms=a,b` and also
// sends `{ type: 'subscribe', rooms: [...] }` after open. Each requested room is authorized ONCE,
// when it is joined, then cached on the socket; per-frame delivery is an org check plus a set
// lookup in process memory. One Redis subscriber per process fans frames out.
//
// Authorization:
//   - the upgrade itself needs a session and bursar.request.read (route preHandler), so an
//     unauthenticated or unpermitted client gets a plain 401/403 and never an open socket;
//   - org:<id> is joinable only for the caller's own org;
//   - request:<id> is joinable only when the request exists in the caller's org, read through
//     the same org-scoped loader GET /requests/:id uses;
//   - vendor:<id> is in the spec's room list, but no server event targets a vendor room yet and
//     vendor reads have their own permission (bursar.vendor.read) that this socket does not hold,
//     so vendor rooms are refused rather than authorized speculatively;
//   - every frame also carries its org, and is never delivered across orgs even if a room id
//     were reused.
// The SPA polls GET /requests/:id/leveling-runs as the source of truth (spec 11.1), so a dropped
// frame costs a refetch and nothing else; there is no replay buffer.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import Redis from 'ioredis';
import { env } from '../env.js';
import { requireAuth } from '../plugins/auth.js';
import { viewerOf } from '../lib/http.js';
import { BURSAR_WS_CHANNEL, orgRoom, type BursarEnvelope } from '../lib/realtime.js';
import { wsFrameGate } from '../lib/ws-frames.js';
import * as requests from '../services/requests.service.js';
import type { Viewer } from '../services/types.js';

/** The socket surface this hub uses (structural, like burn-api's hub). */
export interface BursarSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
}

export interface BursarSubscriber {
  orgId: string;
  rooms: Set<string>;
  send(data: string): void;
}

/** Most rooms one socket may hold; the SPA uses one. */
export const MAX_ROOMS_PER_SOCKET = 16;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RoomAuthDeps {
  /** True when request `id` exists in the viewer's org. */
  requestVisible(viewer: Viewer, id: string): Promise<boolean>;
}

/**
 * The subset of `requested` this viewer may join, never more than MAX_ROOMS_PER_SOCKET in total
 * including `alreadyJoined`. Pure apart from `deps`; exported for the unit test.
 */
export async function authorizeRooms(
  viewer: Viewer,
  requested: string[],
  deps: RoomAuthDeps,
  alreadyJoined = 0,
): Promise<string[]> {
  const out: string[] = [];
  for (const raw of new Set(requested)) {
    if (alreadyJoined + out.length >= MAX_ROOMS_PER_SOCKET) break;
    const room = String(raw).trim();
    const sep = room.indexOf(':');
    if (sep < 0) continue;
    const kind = room.slice(0, sep);
    const id = room.slice(sep + 1);
    if (!UUID.test(id)) continue;
    if (kind === 'org') {
      if (id === viewer.org_id) out.push(orgRoom(id));
    } else if (kind === 'request') {
      if (await deps.requestVisible(viewer, id).catch(() => false)) out.push(room);
    }
    // vendor:<id> and anything else: refused (see the header).
  }
  return out;
}

/** Deliver one envelope to every subscriber of its org that joined its room. Exported for tests. */
export function fanOut(subscribers: Iterable<BursarSubscriber>, envelope: BursarEnvelope): number {
  const room = envelope?.frame?.room;
  if (!envelope?.org_id || !room) return 0;
  const payload = JSON.stringify(envelope.frame);
  let delivered = 0;
  for (const s of subscribers) {
    if (s.orgId !== envelope.org_id || !s.rooms.has(room)) continue;
    try {
      s.send(payload);
      delivered += 1;
    } catch {
      /* a dead socket is reaped by its own close handler */
    }
  }
  return delivered;
}

const dbRoomAuth: RoomAuthDeps = {
  async requestVisible(viewer, id) {
    try {
      await requests.getRequest(viewer, id);
      return true;
    } catch {
      return false;
    }
  },
};

function roomsFromQuery(request: FastifyRequest): string[] {
  const q = (request.query as { rooms?: unknown } | undefined)?.rooms;
  return typeof q === 'string' && q.length > 0 ? q.split(',').slice(0, MAX_ROOMS_PER_SOCKET) : [];
}

export default async function registerBursarWs(fastify: FastifyInstance) {
  const subscribers = new Set<BursarSubscriber>();

  // ONE Redis subscriber per process, not one per socket.
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  sub.on('error', (err) => fastify.log.warn({ err }, 'bursar ws redis subscriber error'));
  await sub.connect();
  await sub.subscribe(BURSAR_WS_CHANNEL);
  sub.on('message', (_channel, raw) => {
    let envelope: BursarEnvelope;
    try {
      envelope = JSON.parse(raw) as BursarEnvelope;
    } catch {
      return;
    }
    fanOut(subscribers, envelope);
  });

  fastify.addHook('onClose', async () => {
    try {
      await sub.quit();
    } catch {
      /* ignore */
    }
  });

  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/ws',
    { websocket: true, preHandler: [requireAuth, can('bursar.request.read')] },
    async (connection, request) => {
      const socket = connection as unknown as BursarSocket;
      if (!request.user) {
        try {
          socket.close(4401, 'Authentication required');
        } catch {
          /* ignore */
        }
        return;
      }
      const viewer = viewerOf(request);
      const entry: BursarSubscriber = {
        orgId: viewer.org_id,
        rooms: new Set(),
        send: (d) => socket.send(d),
      };

      const join = async (requested: string[]) => {
        const allowed = await authorizeRooms(viewer, requested, dbRoomAuth, entry.rooms.size);
        for (const r of allowed) entry.rooms.add(r);
        return allowed;
      };

      // Register the listener before any await so an early subscribe frame is not lost.
      socket.on('message', (data: unknown) => {
        void (async () => {
          let msg: { type?: unknown; rooms?: unknown };
          try {
            msg = JSON.parse(String(data)) as { type?: unknown; rooms?: unknown };
          } catch {
            return;
          }
          // Per-frame catalog gate, the REST twin's (issue #177). An undeclared frame type runs
          // nothing.
          const denial = await wsFrameGate.check(msg?.type, { user_id: viewer.id, org_id: viewer.org_id }, request.log);
          if (denial) {
            if (denial.code === 'PERMISSION_DENIED') {
              try {
                socket.send(JSON.stringify({ type: 'error', ...denial }));
              } catch {
                /* ignore */
              }
            }
            return;
          }
          if (msg.type === 'subscribe' && Array.isArray(msg.rooms)) await onSubscribe(msg.rooms);
        })().catch(() => {});
      });

      const onSubscribe = (requestedRooms: unknown[]) =>
        join(requestedRooms.filter((r): r is string => typeof r === 'string').slice(0, MAX_ROOMS_PER_SOCKET))
          .then((allowed) => {
            try {
              socket.send(JSON.stringify({ type: 'subscribed', rooms: [...entry.rooms], joined: allowed }));
            } catch {
              /* ignore */
            }
          })
          .catch(() => {});
      socket.on('close', () => subscribers.delete(entry));
      socket.on('error', () => subscribers.delete(entry));

      subscribers.add(entry);
      await join(roomsFromQuery(request)).catch(() => []);
      try {
        socket.send(JSON.stringify({ type: 'ready', rooms: [...entry.rooms] }));
      } catch {
        /* ignore */
      }
    },
  );
}
